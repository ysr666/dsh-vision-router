import { createHash } from 'node:crypto'

export const DEFAULT_DESCRIBE_CACHE_ENTRIES = 200
export const DEFAULT_DESCRIBE_CACHE_TTL_MS = 3600 * 1000
export const DEFAULT_DESCRIBE_CACHE_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_DESCRIBE_CACHE_MAX_ENTRY_BYTES = 1024 * 1024

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : fallback
}

function valueBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value)
  try { return Buffer.byteLength(JSON.stringify(value)) } catch { return Infinity }
}

/**
 * Small LRU used outside the legacy core cache. Limits and TTL are evaluated
 * against the latest settings on every reconfigure/get/set, so a hot settings
 * change cannot leave the process running with boot-time cache policy.
 */
export class LiveDescribeCache {
  constructor(options = {}) {
    this.entries = new Map()
    this.totalBytes = 0
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_DESCRIBE_CACHE_MAX_BYTES)
    this.maxEntryBytes = positiveInteger(options.maxEntryBytes, DEFAULT_DESCRIBE_CACHE_MAX_ENTRY_BYTES)
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_DESCRIBE_CACHE_ENTRIES)
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_DESCRIBE_CACHE_TTL_MS)
  }

  _delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes)
  }

  _prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt >= this.ttlMs) this._delete(key)
    }
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this._delete(oldest)
    }
  }

  reconfigure(config = {}, now = Date.now()) {
    this.maxEntries = positiveInteger(config.maxEntries, DEFAULT_DESCRIBE_CACHE_ENTRIES)
    this.ttlMs = positiveInteger(config.ttlMs, DEFAULT_DESCRIBE_CACHE_TTL_MS)
    this._prune(now)
  }

  clear() {
    this.entries.clear()
    this.totalBytes = 0
  }

  get(key, now = Date.now()) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (now - entry.storedAt >= this.ttlMs) {
      this._delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value, now = Date.now()) {
    const bytes = valueBytes(value)
    if (!Number.isFinite(bytes) || bytes > this.maxEntryBytes) return false
    this._delete(key)
    this.entries.set(key, { value, bytes, storedAt: now })
    this.totalBytes += bytes
    this._prune(now)
    return this.entries.has(key)
  }

  stats() {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      maxBytes: this.maxBytes,
    }
  }
}

function normalizedEndpoint(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

/**
 * Give a direct HTTP provider a fresh runtime-only identity after its endpoint
 * changes while name/model/credential stay the same. Core's breaker key uses
 * name/model, so this prevents an AUTH trip from the old endpoint suppressing
 * an immediately corrected endpoint for the remainder of the 10-minute TTL.
 * Persisted settings and browser-visible names are never modified.
 */
export class HttpEndpointRevisionTracker {
  constructor({ maxSlots = 128 } = {}) {
    this.maxSlots = positiveInteger(maxSlots, 128)
    this.slots = new Map()
  }

  project(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return rows
    const occurrences = new Map()
    let changed = false
    const projected = rows.map((row) => {
      if (!row || typeof row !== 'object') return row
      const name = String(row.name ?? '')
      const model = String(row.model ?? '')
      const credential = String(row.apiKeyEnv ?? '')
      const identity = `${name}\u0000${model}\u0000${credential}`
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      const slotKey = `${identity}\u0000${occurrence}`
      const endpoint = normalizedEndpoint(row.baseURL)
      let slot = this.slots.get(slotKey)
      if (!slot) {
        slot = { endpoint, revision: 0 }
        this.slots.set(slotKey, slot)
      } else if (slot.endpoint !== endpoint) {
        slot.endpoint = endpoint
        slot.revision += 1
        this.slots.delete(slotKey)
        this.slots.set(slotKey, slot)
      } else {
        this.slots.delete(slotKey)
        this.slots.set(slotKey, slot)
      }
      while (this.slots.size > this.maxSlots) {
        const oldest = this.slots.keys().next().value
        if (oldest === undefined) break
        this.slots.delete(oldest)
      }
      if (slot.revision <= 0 || name === '') return row
      changed = true
      return { ...row, name: `${name}~vr${slot.revision}` }
    })
    return changed ? projected : rows
  }
}

async function closeDispatcher(dispatcher) {
  if (!dispatcher || (typeof dispatcher !== 'object' && typeof dispatcher !== 'function')) return
  if (typeof dispatcher.close === 'function') {
    await dispatcher.close()
    return
  }
  if (typeof dispatcher.destroy === 'function') await dispatcher.destroy()
}

/**
 * Tracks the ProxyAgent actually observed by the fetch layer. A URL switch in
 * core creates a new dispatcher; observing that replacement gracefully closes
 * the previous pool. `close()` waits for in-flight Undici work rather than
 * destroying active requests.
 */
export class ProxyDispatcherTracker {
  constructor() {
    this.current = undefined
    this.closed = new WeakSet()
    this.pending = new Set()
  }

  _retire(dispatcher) {
    if (!dispatcher || (typeof dispatcher !== 'object' && typeof dispatcher !== 'function')) return
    if (this.closed.has(dispatcher)) return
    this.closed.add(dispatcher)
    const pending = Promise.resolve()
      .then(() => closeDispatcher(dispatcher))
      .catch(() => undefined)
      .finally(() => this.pending.delete(pending))
    this.pending.add(pending)
  }

  observe(dispatcher) {
    if (!dispatcher || dispatcher === this.current) return
    const previous = this.current
    this.current = dispatcher
    if (previous) this._retire(previous)
  }

  dispose() {
    const current = this.current
    this.current = undefined
    if (current) this._retire(current)
  }

  async drain() {
    await Promise.all([...this.pending])
  }
}

function safeUrl(value) {
  try {
    if (value instanceof URL) return value
    if (typeof value === 'string') return new URL(value)
    if (value && typeof value.url === 'string') return new URL(value.url)
  } catch {
    return undefined
  }
  return undefined
}

export function proxyRequestIsManaged(input, config) {
  if (!config || typeof config !== 'object' || String(config.proxy ?? '').trim() === '') return false
  const url = safeUrl(input)
  if (!url) return false
  const hosts = Array.isArray(config.proxyHosts) ? config.proxyHosts : []
  return hosts.some((raw) => {
    const host = String(raw ?? '').trim().toLowerCase()
    return host !== '' && (url.hostname.toLowerCase() === host || url.hostname.toLowerCase().endsWith(`.${host}`))
  })
}

/** Build an order-sensitive cache key. Path inputs are content-hashed. */
export async function describeCacheKey(ctx, args = {}, exec, revision = 0) {
  const hash = createHash('sha256')
  hash.update(`revision:${revision}\n`)
  const paths = Array.isArray(args.paths) ? args.paths : []
  const attachments = Array.isArray(args.attachmentIds) ? args.attachmentIds : []
  const fs = ctx?.get?.('fs')
  const cwd = exec?.agent?.session?.header?.cwd
  const signal = exec?.signal

  for (const input of paths) {
    if (!fs || typeof fs.resolve !== 'function' || typeof fs.readBytes !== 'function') return undefined
    const target = await fs.resolve(String(input), {
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      ...(signal ? { signal } : {}),
    })
    const bytes = await fs.readBytes(target, signal, 20 * 1024 * 1024)
    hash.update('path\u0000')
    hash.update(createHash('sha256').update(bytes).digest())
    hash.update('\u0000')
  }
  for (const id of attachments) {
    hash.update('attachment\u0000')
    hash.update(String(id))
    hash.update('\u0000')
  }

  const semanticArgs = { ...args }
  delete semanticArgs.paths
  delete semanticArgs.attachmentIds
  hash.update(JSON.stringify(semanticArgs))
  return hash.digest('hex')
}

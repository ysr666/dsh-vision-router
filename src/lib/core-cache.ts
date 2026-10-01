export interface CoreCacheOptions {
  readonly maxBytes?: unknown
  readonly maxEntryBytes?: unknown
}

export interface CoreCache<Value> {
  get(key: unknown): Value | undefined
  set(key: unknown, value: Value): boolean
  readonly size: number
  readonly bytes: number
}

interface CacheEntry<Value> {
  readonly value: Value
  readonly weight: number
  readonly expiresAt: number
}

function cacheWeight(value: unknown): number {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  try {
    const encoded = JSON.stringify(value)
    return Buffer.byteLength(encoded === undefined ? String(value) : encoded, 'utf8')
  } catch {
    return Buffer.byteLength(String(value), 'utf8')
  }
}

/**
 * LRU+TTL cache bounded by both entry count and retained bytes.
 *
 * Keys are normalized to strings at the ownership boundary. A rejected write
 * never remains resident, and every eviction updates retained-byte accounting
 * before the entry is released.
 */
export function createCache<Value = unknown>(
  maxEntries: unknown,
  ttlMsValue: unknown,
  options: CoreCacheOptions = {},
): CoreCache<Value> {
  const entries = new Map<string, CacheEntry<Value>>()
  const entryLimit = Math.max(0, Math.floor(Number(maxEntries) || 0))
  const ttlMs = ttlMsValue as number
  const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) >= 0
    ? Math.floor(Number(options.maxBytes))
    : 8 * 1024 * 1024
  const maxEntryBytes =
    Number.isFinite(Number(options.maxEntryBytes)) && Number(options.maxEntryBytes) >= 0
      ? Math.floor(Number(options.maxEntryBytes))
      : Math.min(maxBytes, 1024 * 1024)
  let retainedBytes = 0

  const remove = (key: string): void => {
    const entry = entries.get(key)
    if (entry === undefined) return
    retainedBytes = Math.max(0, retainedBytes - entry.weight)
    entries.delete(key)
  }

  const evict = (): void => {
    while (entries.size > entryLimit || retainedBytes > maxBytes) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      remove(oldest)
    }
  }

  return {
    get(key: unknown): Value | undefined {
      const rawKey = key as string
      const entry = entries.get(rawKey)
      if (entry === undefined) return undefined
      if (entry.expiresAt <= Date.now()) {
        remove(rawKey)
        return undefined
      }
      entries.delete(rawKey)
      entries.set(rawKey, entry)
      return entry.value
    },

    set(key: unknown, value: Value): boolean {
      const normalizedKey = String(key)
      const weight = Buffer.byteLength(normalizedKey, 'utf8') + cacheWeight(value)
      remove(normalizedKey)
      if (
        entryLimit === 0
        || maxBytes === 0
        || weight > maxEntryBytes
        || weight > maxBytes
      ) {
        return false
      }
      entries.set(normalizedKey, {
        value,
        weight,
        expiresAt: ttlMs <= 0 ? Infinity : Date.now() + ttlMs,
      })
      retainedBytes += weight
      evict()
      return entries.has(normalizedKey)
    },

    get size(): number {
      return entries.size
    },

    get bytes(): number {
      return retainedBytes
    },
  }
}

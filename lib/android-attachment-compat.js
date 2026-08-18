import { createHash } from 'node:crypto'

const wrappedContexts = new WeakMap()
const MIB = 1024 * 1024

export const DEFAULT_ANDROID_TRANSIENT_LIMITS = Object.freeze({
  maxEntries: 64,
  maxBytes: 128 * MIB,
  maxSingleBytes: 64 * MIB,
})

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function positiveInteger(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function isAndroidTermuxRuntime(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'android') return true
  if (nonEmptyString(env?.TERMUX_VERSION)) return true
  const prefix = nonEmptyString(env?.PREFIX) ? env.PREFIX : ''
  return prefix.includes('/com.termux/') || prefix.includes('\\com.termux\\')
}

export function isPermissionBoundaryError(error) {
  let current = error
  const seen = new Set()
  for (let depth = 0; current && depth < 8; depth += 1) {
    if ((typeof current === 'object' || typeof current === 'function') && seen.has(current)) break
    if (typeof current === 'object' || typeof current === 'function') seen.add(current)
    const code = current && typeof current === 'object' ? current.code : undefined
    if (code === 'EACCES' || code === 'EPERM') return true
    current = current && typeof current === 'object' ? current.cause : undefined
  }
  return false
}

function displayName(value) {
  if (!nonEmptyString(value)) return undefined
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

async function probeImage(data, injectedProbe) {
  if (typeof injectedProbe === 'function') return injectedProbe(data)
  const mod = await import('sharp')
  const sharp = mod.default ?? mod
  const metadata = await sharp(data, { failOn: 'none' }).metadata()
  const width = Number(metadata.width ?? 0)
  const height = Number(metadata.height ?? 0)
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('vision-router: Android attachment fallback could not read image dimensions')
  }
  return { width, height }
}

function transientTooLargeError(bytes, limit) {
  const error = new Error(
    `vision-router: Android attachment fallback refuses to keep a ${bytes}-byte image in process memory (limit ${limit} bytes)`,
  )
  error.code = 'ANDROID_TRANSIENT_ATTACHMENT_TOO_LARGE'
  return error
}

async function transientStoredImage(input, injectedProbe, maxSingleBytes) {
  const data = input?.data
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new Error('vision-router: Android attachment fallback received empty image bytes')
  }
  // Enforce the byte boundary BEFORE probing with sharp. Metadata decode can
  // itself allocate native memory, so rejecting after probeImage() would still
  // allow a single pathological input to cross the mobile memory boundary.
  if (data.byteLength > maxSingleBytes) {
    throw transientTooLargeError(data.byteLength, maxSingleBytes)
  }
  const mediaType = input?.mediaType
  if (!nonEmptyString(mediaType)) {
    throw new Error('vision-router: Android attachment fallback received no media type')
  }
  const { width, height } = await probeImage(data, injectedProbe)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const name = displayName(input?.name)
  const ref = {
    attachmentId: `sha256:${sha256}`,
    mediaType,
    bytes: data.byteLength,
    width,
    height,
    ...(name !== undefined ? { name } : {}),
  }
  return { ref, data }
}

/** Byte-weighted LRU for the Android process-local durability fallback. */
export function createTransientAttachmentCache(options = {}) {
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_ANDROID_TRANSIENT_LIMITS.maxEntries)
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_ANDROID_TRANSIENT_LIMITS.maxBytes)
  const map = new Map()
  let bytes = 0

  const remove = (id) => {
    const old = map.get(id)
    if (old === undefined) return false
    bytes = Math.max(0, bytes - Number(old.data?.byteLength ?? 0))
    return map.delete(id)
  }

  const trim = () => {
    while (map.size > maxEntries || bytes > maxBytes) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      remove(oldest)
    }
  }

  return {
    get(id) {
      const stored = map.get(id)
      if (stored === undefined) return undefined
      // Refresh recency so an actively used image survives pressure from newer
      // one-shot attachments.
      map.delete(id)
      map.set(id, stored)
      return stored
    },
    set(stored) {
      const id = String(stored?.ref?.attachmentId ?? '')
      const weight = Number(stored?.data?.byteLength ?? 0)
      if (id === '' || !Number.isFinite(weight) || weight <= 0 || weight > maxBytes) return false
      remove(id)
      map.set(id, stored)
      bytes += weight
      trim()
      return map.has(id)
    },
    stats() {
      return { entries: map.size, bytes, maxEntries, maxBytes }
    },
  }
}

/**
 * Android/Termux compatibility shim for deepseek-harness attachment-local.
 *
 * Current DSH attachment-local proves directory durability by fsyncing every
 * ancestor from DSH_HOME to the filesystem root. Android SELinux lets Termux
 * access its own /data/data/com.termux subtree but intentionally denies opening
 * /data/data itself, so saveImage() is wrapped as ATTACHMENT_WRITE_FAILED even
 * though the image bytes are otherwise readable.
 *
 * Keep the host service authoritative. Only when an Android runtime reaches an
 * EACCES/EPERM boundary do Vision Router's own calls fall back to a byte- and
 * count-bounded, process-local content-addressed attachment. The paired
 * readImage() wrapper makes the direct vision-http path and plugin-side bridge
 * code consume those bytes normally. Once upstream accepts the save, this path
 * is never used.
 */
export function installAndroidAttachmentCompat(ctx, logger, options = {}) {
  if (!ctx || typeof ctx !== 'object' || !isAndroidTermuxRuntime(options.runtime)) return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  let attachments
  try {
    attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  } catch {
    return ctx
  }
  if (!attachments || typeof attachments.saveImage !== 'function' || typeof attachments.readImage !== 'function') {
    return ctx
  }

  const maxTransientBytes = positiveInteger(
    options.maxTransientBytes,
    DEFAULT_ANDROID_TRANSIENT_LIMITS.maxBytes,
  )
  const maxTransientAttachments = positiveInteger(
    options.maxTransientAttachments,
    DEFAULT_ANDROID_TRANSIENT_LIMITS.maxEntries,
  )
  const maxTransientSingleBytes = Math.min(
    maxTransientBytes,
    positiveInteger(options.maxTransientSingleBytes, DEFAULT_ANDROID_TRANSIENT_LIMITS.maxSingleBytes),
  )
  const transient = createTransientAttachmentCache({
    maxEntries: maxTransientAttachments,
    maxBytes: maxTransientBytes,
  })

  const wrappedAttachments = new Proxy(attachments, {
    get(target, property) {
      if (property === 'saveImage') {
        return async (input) => {
          try {
            return await target.saveImage(input)
          } catch (error) {
            if (!isPermissionBoundaryError(error)) throw error
            const stored = await transientStoredImage(input, options.probeImage, maxTransientSingleBytes)
            if (!transient.set(stored)) {
              throw transientTooLargeError(stored.data.byteLength, maxTransientBytes)
            }
            try {
              logger?.warn?.(
                'vision-router: Android/Termux attachment save hit an inaccessible ancestor; using a bounded process-local image ref until DSH attachment-local is fixed upstream',
              )
            } catch {
              /* diagnostics must never block the fallback */
            }
            return stored.ref
          }
        }
      }
      if (property === 'readImage') {
        return async (ref, signal) => {
          signal?.throwIfAborted?.()
          const id = String(ref?.attachmentId ?? '')
          const stored = transient.get(id)
          if (stored !== undefined) return stored
          return target.readImage(ref, signal)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'get') {
        return (name) => (name === 'attachments' ? wrappedAttachments : target.get(name))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedContexts.set(ctx, wrapped)
  return wrapped
}

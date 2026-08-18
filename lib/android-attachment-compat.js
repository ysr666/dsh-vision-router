import { createHash } from 'node:crypto'

const wrappedContexts = new WeakMap()
const MAX_TRANSIENT_ATTACHMENTS = 64

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
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

async function transientStoredImage(input, injectedProbe) {
  const data = input?.data
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new Error('vision-router: Android attachment fallback received empty image bytes')
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

function rememberTransient(map, stored) {
  const id = String(stored.ref.attachmentId)
  if (map.has(id)) map.delete(id)
  map.set(id, stored)
  while (map.size > MAX_TRANSIENT_ATTACHMENTS) {
    const oldest = map.keys().next().value
    map.delete(oldest)
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
 * EACCES/EPERM boundary do Vision Router's own calls fall back to a bounded,
 * process-local content-addressed attachment. The paired readImage() wrapper
 * makes the direct vision-http path and plugin-side bridge code consume those
 * bytes normally. Once upstream accepts the save, this path is never used.
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

  const transient = new Map()
  const wrappedAttachments = new Proxy(attachments, {
    get(target, property) {
      if (property === 'saveImage') {
        return async (input) => {
          try {
            return await target.saveImage(input)
          } catch (error) {
            if (!isPermissionBoundaryError(error)) throw error
            const stored = await transientStoredImage(input, options.probeImage)
            rememberTransient(transient, stored)
            try {
              logger?.warn?.(
                'vision-router: Android/Termux attachment save hit an inaccessible ancestor; using a process-local image ref until DSH attachment-local is fixed upstream',
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

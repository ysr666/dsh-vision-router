import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { format as formatArgs, promisify } from 'node:util'
import { createRequire } from 'node:module'
import { resolveDshHome } from './doctor.js'

export const LOG_FILE_NAME = 'vision-router.log'
export const LOG_BACKUP_FILE_NAME = 'vision-router.1.log'
export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024

const execFileAsync = promisify(execFile)
const installs = new WeakMap()

export function resolveVisionRouterLogPaths(dshHome = resolveDshHome()) {
  const directory = path.join(dshHome, 'logs', 'vision-router')
  return {
    directory,
    file: path.join(directory, LOG_FILE_NAME),
    backup: path.join(directory, LOG_BACKUP_FILE_NAME),
  }
}

/**
 * Diagnostics are intended to be shareable in bug reports. Existing runtime
 * messages should not contain secrets, but redact common credential shapes as
 * defense in depth before anything reaches disk.
 */
export function sanitizeLogText(value) {
  let text = String(value ?? '')
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
  text = text.replace(
    /([?&](?:api[_-]?key|access[_-]?token|token|key|auth)=)[^&\s]+/gi,
    '$1[REDACTED]',
  )
  text = text.replace(
    /\b(authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"',}]+/gi,
    '$1=[REDACTED]',
  )
  return text
}

export function createFileLogSink({
  file,
  backup,
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  onError = () => {},
} = {}) {
  let queue = Promise.resolve()
  let initialized = false
  let size = 0
  let disabled = false
  let reportedError = false

  const reportError = (error) => {
    if (reportedError) return
    reportedError = true
    try {
      onError(error)
    } catch {
      // A diagnostics failure must never affect the plugin runtime.
    }
  }

  const prepare = async () => {
    if (initialized || disabled) return
    await mkdir(path.dirname(file), { recursive: true })
    try {
      size = (await stat(file)).size
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
      size = 0
    }
    initialized = true
  }

  const rotate = async () => {
    try {
      await rm(backup, { force: true })
      await rename(file, backup)
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    size = 0
  }

  const write = (level, args) => {
    if (disabled) return queue
    const rendered = sanitizeLogText(formatArgs(...args))
    const line = `[${new Date().toISOString()}] [${String(level).toUpperCase()}] ${rendered}\n`
    const bytes = Buffer.byteLength(line)
    queue = queue.then(async () => {
      try {
        await prepare()
        if (size > 0 && size + bytes > maxBytes) await rotate()
        await appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
        size += bytes
      } catch (error) {
        disabled = true
        reportError(error)
      }
    })
    return queue
  }

  return {
    write,
    flush: () => queue,
    get disabled() {
      return disabled
    },
  }
}

function packageVersion() {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('../package.json')
    return typeof manifest?.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function teeLogger(baseLogger, sink) {
  const levels = new Set(['debug', 'info', 'warn', 'error'])
  return new Proxy(baseLogger ?? {}, {
    get(target, property) {
      if (levels.has(property)) {
        return (...args) => {
          const method = target && typeof target[property] === 'function' ? target[property] : undefined
          if (method) {
            try {
              method.apply(target, args)
            } catch {
              // Keep the file logger from changing host logger semantics.
            }
          }
          void sink.write(property, args)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function contextWithLogger(ctx, logger) {
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'logger') return logger
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export async function openLogDirectory(directory, {
  platform = process.platform,
  exec = execFileAsync,
} = {}) {
  await mkdir(directory, { recursive: true })
  if (platform === 'darwin') {
    await exec('open', [directory], { timeout: 10_000, windowsHide: true })
    return
  }
  if (platform === 'win32') {
    await exec('explorer.exe', [directory], { timeout: 10_000, windowsHide: true })
    return
  }
  await exec('xdg-open', [directory], { timeout: 10_000, windowsHide: true })
}

function sameOrigin(req) {
  const origin = req?.headers?.origin
  const host = req?.headers?.host
  const fetchSite = req?.headers?.['sec-fetch-site']
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  if (!origin) return true
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function installLogRoute(ctx, paths) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/_dsh/vision-router/logs',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, directory: paths.directory, file: paths.file })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        try {
          await openLogDirectory(paths.directory)
          sendJson(res, 200, { ok: true, directory: paths.directory, file: paths.file })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            directory: paths.directory,
            file: paths.file,
            error: error && error.message ? error.message : String(error),
          })
        }
      },
    }), 'vision-router: diagnostics log route')
  })
}

/**
 * Return a Cordis context whose logger tees this plugin's existing diagnostics
 * to a small rotating file while preserving the host logger. The original
 * context is otherwise untouched.
 */
export function installVisionRouterFileLogging(ctx, options = {}) {
  if (ctx && typeof ctx === 'object' && installs.has(ctx)) return installs.get(ctx)

  const paths = resolveVisionRouterLogPaths(options.dshHome)
  const baseLogger = ctx?.logger
  const sink = createFileLogSink({
    file: paths.file,
    backup: paths.backup,
    maxBytes: options.maxBytes ?? DEFAULT_LOG_MAX_BYTES,
    onError: (error) => {
      try {
        baseLogger?.warn?.(
          'vision-router: diagnostics file logging disabled: %s',
          error && error.message ? error.message : String(error),
        )
      } catch {
        // Logging failure remains non-fatal.
      }
    },
  })
  const logger = teeLogger(baseLogger, sink)
  const wrappedCtx = contextWithLogger(ctx, logger)
  const installed = { ctx: wrappedCtx, logger, sink, ...paths }
  if (ctx && typeof ctx === 'object') installs.set(ctx, installed)

  installLogRoute(ctx, paths)
  logger.info(
    'vision-router: diagnostics log enabled at %s (plugin=%s node=%s platform=%s/%s)',
    paths.file,
    packageVersion(),
    process.version,
    process.platform,
    process.arch,
  )
  return installed
}

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { format as formatArgs, promisify } from 'node:util'
import { createRequire } from 'node:module'
import { resolveDshHome } from './doctor.js'
import { isLoopbackRequest } from './web-capability-boundary.js'

export const LOG_FILE_NAME = 'vision-router.log'
export const LOG_BACKUP_FILE_NAME = 'vision-router.1.log'
export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024
export const DEFAULT_LOG_MAX_PENDING_BYTES = 512 * 1024
export const DEFAULT_LOG_MAX_PENDING_ENTRIES = 2048
export const DEFAULT_LOG_MAX_LINE_BYTES = 64 * 1024

const execFileAsync = promisify(execFile)
const installs = new WeakMap()
const SETTINGS_SAVE_DIAGNOSTICS_PATH = '/_dsh/vision-router/settings-save-diagnostics'
const MAX_DIAGNOSTICS_BODY_BYTES = 16 * 1024

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

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function boundedUtf8Line(value, maxBytes) {
  const line = String(value)
  const buffer = Buffer.from(line)
  if (buffer.length <= maxBytes) return line
  const suffix = Buffer.from('… [truncated]\n')
  const budget = Math.max(1, maxBytes - suffix.length)
  let prefix = buffer.subarray(0, budget).toString('utf8')
  // A byte cut can land inside a multibyte code point. Drop the replacement
  // marker rather than persisting malformed-looking diagnostics.
  prefix = prefix.replace(/\uFFFD+$/g, '')
  return `${prefix}… [truncated]\n`
}

export function createFileLogSink({
  file,
  backup,
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  maxPendingBytes = DEFAULT_LOG_MAX_PENDING_BYTES,
  maxPendingEntries = DEFAULT_LOG_MAX_PENDING_ENTRIES,
  maxLineBytes = DEFAULT_LOG_MAX_LINE_BYTES,
  onError = () => {},
  retryBaseMs = 250,
  retryMaxMs = 10_000,
  now = Date.now,
  fsOps = { appendFile, mkdir, rename, rm, stat },
} = {}) {
  let queue = Promise.resolve()
  let initialized = false
  let size = 0
  let nextRetryAt = 0
  let failureStreak = 0
  let reportedError = false
  let pendingBytes = 0
  let pendingEntries = 0
  let droppedSinceNotice = 0
  let droppedTotal = 0

  const pendingByteLimit = positiveInteger(maxPendingBytes, DEFAULT_LOG_MAX_PENDING_BYTES)
  const pendingEntryLimit = positiveInteger(maxPendingEntries, DEFAULT_LOG_MAX_PENDING_ENTRIES)
  const lineByteLimit = positiveInteger(maxLineBytes, DEFAULT_LOG_MAX_LINE_BYTES)
  const retryBase = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? Number(retryBaseMs) : 250
  const retryMax = Number.isFinite(retryMaxMs) && retryMaxMs >= retryBase
    ? Number(retryMaxMs)
    : Math.max(retryBase, 10_000)
  const clock = typeof now === 'function' ? now : Date.now
  const ops = {
    appendFile: fsOps?.appendFile ?? appendFile,
    mkdir: fsOps?.mkdir ?? mkdir,
    rename: fsOps?.rename ?? rename,
    rm: fsOps?.rm ?? rm,
    stat: fsOps?.stat ?? stat,
  }

  const reportError = (error) => {
    if (reportedError) return
    reportedError = true
    try {
      onError(error)
    } catch {
      // A diagnostics failure must never affect the plugin runtime.
    }
  }

  const markFailure = (error) => {
    initialized = false
    failureStreak += 1
    const exponent = Math.min(10, Math.max(0, failureStreak - 1))
    const delay = Math.min(retryMax, retryBase * (2 ** exponent))
    nextRetryAt = Number(clock()) + delay
    reportError(error)
  }

  const markRecovered = () => {
    nextRetryAt = 0
    failureStreak = 0
    reportedError = false
  }

  const prepare = async () => {
    if (initialized) return
    await ops.mkdir(path.dirname(file), { recursive: true })
    try {
      size = (await ops.stat(file)).size
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
      size = 0
    }
    initialized = true
  }

  const rotate = async () => {
    try {
      await ops.rm(backup, { force: true })
      await ops.rename(file, backup)
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    size = 0
  }

  const appendPrepared = async (line) => {
    const bytes = Buffer.byteLength(line)
    await prepare()
    if (size > 0 && size + bytes > maxBytes) await rotate()
    await ops.appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
    size += bytes
  }

  const write = (level, args) => {
    const rendered = sanitizeLogText(formatArgs(...args))
    const rawLine = `[${new Date().toISOString()}] [${String(level).toUpperCase()}] ${rendered}\n`
    const line = boundedUtf8Line(rawLine, lineByteLimit)
    const bytes = Buffer.byteLength(line)

    // Admission happens BEFORE adding another .then closure to the chain. This
    // is the actual memory boundary; limiting only the rotated disk file leaves
    // an arbitrarily large producer backlog retained in RAM on a slow disk.
    if (
      pendingEntries >= pendingEntryLimit ||
      pendingBytes + bytes > pendingByteLimit
    ) {
      droppedSinceNotice += 1
      droppedTotal += 1
      return queue
    }

    pendingEntries += 1
    pendingBytes += bytes
    queue = queue.then(async () => {
      try {
        // A persistent filesystem failure should not create a tight retry loop,
        // but a transient startup/mount race must never disable logging forever.
        if (nextRetryAt > Number(clock())) return
        await appendPrepared(line)

        // Drops are aggregated into one bounded record after I/O makes progress
        // again. New drops racing this write remain for the next accepted item.
        const dropped = droppedSinceNotice
        if (dropped > 0) {
          droppedSinceNotice = Math.max(0, droppedSinceNotice - dropped)
          const notice = boundedUtf8Line(
            `[${new Date().toISOString()}] [WARN] vision-router: diagnostics backpressure dropped ${dropped} log message(s) while the file writer was saturated\n`,
            lineByteLimit,
          )
          await appendPrepared(notice)
        }
        if (failureStreak > 0 || reportedError) markRecovered()
      } catch (error) {
        markFailure(error)
      } finally {
        pendingEntries = Math.max(0, pendingEntries - 1)
        pendingBytes = Math.max(0, pendingBytes - bytes)
      }
    })
    return queue
  }

  return {
    write,
    flush: () => queue,
    stats: () => ({
      pendingBytes,
      pendingEntries,
      maxPendingBytes: pendingByteLimit,
      maxPendingEntries: pendingEntryLimit,
      maxLineBytes: lineByteLimit,
      dropped: droppedTotal,
    }),
    // Kept for compatibility: disabled now means temporarily in retry
    // backoff, not permanently poisoned for the lifetime of the process.
    get disabled() {
      return nextRetryAt > Number(clock())
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
    try {
      await exec('explorer.exe', [directory], { timeout: 10_000, windowsHide: true })
      return
    } catch (error) {
      // explorer.exe is a shell relay. On some Windows installs it hands the
      // request to the existing Explorer process, opens the folder, then exits
      // with code 1. A numeric exit code therefore means the relay did run and
      // must not be treated as an open failure.
      if (typeof error?.code === 'number') return

      // Spawn-level failures (ENOENT/EPERM/EACCES/UNKNOWN, timeout, etc.) mean
      // the relay did not complete reliably. Fall back to ShellExecute via the
      // built-in `start` command without invoking a Node shell.
      try {
        await exec('cmd.exe', ['/d', '/s', '/c', `start "" "${directory}"`], {
          timeout: 10_000,
          windowsHide: true,
        })
        return
      } catch (startError) {
        const wrapped = new Error(
          `explorer.exe spawn failed (${error?.code ?? 'unknown'}); cmd start failed (${startError?.code ?? 'unknown'})`,
        )
        wrapped.code = 'OPEN_LOG_DIRECTORY_FAILED'
        wrapped.explorer = error
        wrapped.start = startError
        throw wrapped
      }
    }
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

function compactDiagnosticText(value, maxLength) {
  return sanitizeLogText(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

/** Keep client diagnostics bounded and free of settings values before logging. */
export function normalizeSettingsSaveDiagnostics(payload) {
  const operations = new Set(['set', 'unset'])
  const reasons = new Set(['write-error', 'readback-error', 'readback-mismatch'])
  const failures = payload && Array.isArray(payload.failures) ? payload.failures : []
  return failures.slice(0, 16).flatMap((failure) => {
    if (!failure || typeof failure !== 'object') return []
    const field = compactDiagnosticText(failure.field, 80)
    if (field === '') return []
    const operation = operations.has(failure.operation) ? failure.operation : 'unknown'
    const reason = reasons.has(failure.reason) ? failure.reason : 'unknown'
    const detail = compactDiagnosticText(failure.detail, 400)
    return [{ field, operation, reason, detail }]
  })
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_DIAGNOSTICS_BODY_BYTES) {
      const error = new Error('request body too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function installLogRoute(ctx, paths, logger) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/_dsh/vision-router/logs',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const local = isLoopbackRequest(req)
          sendJson(res, 200, local
            ? { ok: true, local: true, canOpen: true, directory: paths.directory, file: paths.file }
            : { ok: true, local: false, canOpen: false })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'opening a local log directory requires a loopback connection' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        try {
          await openLogDirectory(paths.directory)
          sendJson(res, 200, { ok: true, local: true, canOpen: true, directory: paths.directory, file: paths.file })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            directory: paths.directory,
            file: paths.file,
            error: error && error.message ? error.message : String(error),
            code: error && error.code !== undefined ? String(error.code) : undefined,
          })
        }
      },
    }), 'vision-router: diagnostics log route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: SETTINGS_SAVE_DIAGNOSTICS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'local diagnostics writes require a loopback connection' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        try {
          const failures = normalizeSettingsSaveDiagnostics(await readJsonBody(req))
          if (failures.length === 0) {
            sendJson(res, 400, { ok: false, error: 'no valid diagnostics' })
            return
          }
          for (const failure of failures) {
            logger.warn(
              'vision-router: settings save failed field=%s operation=%s reason=%s detail=%s',
              failure.field,
              failure.operation,
              failure.reason,
              failure.detail || 'none',
            )
          }
          sendJson(res, 200, { ok: true, count: failures.length })
        } catch (error) {
          sendJson(res, error && error.code === 'BODY_TOO_LARGE' ? 413 : 400, {
            ok: false,
            error: error && error.message ? error.message : String(error),
          })
        }
      },
    }), 'vision-router: settings save diagnostics route')
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
    maxPendingBytes: options.maxPendingBytes,
    maxPendingEntries: options.maxPendingEntries,
    maxLineBytes: options.maxLineBytes,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
    now: options.now,
    fsOps: options.fsOps,
    onError: (error) => {
      try {
        baseLogger?.warn?.(
          'vision-router: diagnostics file logging write failed; will retry: %s',
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
  if (ctx && typeof ctx === 'object') {
    installs.set(ctx, installed)
    // Cordis can unload/reload this plugin fiber when a required service is
    // replaced. Its child effects (including routes) are disposed at unload,
    // so the installation cache must expire with the same lifecycle or the
    // next apply would reuse an object whose routes are no longer mounted.
    try {
      ctx.effect?.(
        () => () => {
          if (installs.get(ctx) === installed) installs.delete(ctx)
        },
        'vision-router: diagnostics file logger lifecycle',
      )
    } catch {
      // Cache expiry is a hardening aid; logging itself must stay non-fatal.
    }
  }

  installLogRoute(ctx, paths, logger)
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

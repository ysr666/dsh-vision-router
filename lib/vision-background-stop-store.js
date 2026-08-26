import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveDshHome } from './doctor.js'
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from './vision-capability-benchmark.js'

// v1 stops had no expiry and could poison a backend forever. Do not migrate
// them: a cache-version bump intentionally drops that stale authority.
const CACHE_VERSION = 2
const MAX_ENTRIES = 256
const AXES = new Set(['ocr', 'general', 'document', 'structured', 'grounding'])
const CLASSES = new Set(['auth', 'unavailable', 'protocol'])
const CREDENTIAL_FINGERPRINT_RE = /^(?:cred_[0-9a-f]{24}|unresolved|none)$/

function cleanText(value, max = 256) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : ''
}

function cleanStop(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Number(value.suiteRevision) !== CAPABILITY_BENCHMARK_SUITE_REVISION) return undefined
  const fingerprint = cleanText(value.fingerprint, 64)
  if (!/^ep2_[0-9a-f]{32}$/.test(fingerprint)) return undefined
  const key = cleanText(value.key)
  const provider = cleanText(value.provider)
  const model = cleanText(value.model)
  const axis = cleanText(value.axis, 32)
  const errorClass = cleanText(value.errorClass, 48)
  const errorCode = cleanText(value.errorCode, 96)
  const credentialFingerprint = cleanText(value.credentialFingerprint, 64)
  const recordedAt = Number(value.recordedAt)
  const expiresAt = Number(value.expiresAt)
  if (!key || !provider || !model || !AXES.has(axis) || !CLASSES.has(errorClass)) return undefined
  if (!Number.isFinite(recordedAt) || recordedAt <= 0) return undefined
  if (!Number.isFinite(expiresAt) || expiresAt <= recordedAt) return undefined
  if (credentialFingerprint && !CREDENTIAL_FINGERPRINT_RE.test(credentialFingerprint)) return undefined
  return {
    fingerprint,
    key,
    provider,
    model,
    axis,
    errorClass,
    ...(errorCode ? { errorCode } : {}),
    ...(errorClass === 'auth' && credentialFingerprint ? { credentialFingerprint } : {}),
    recordedAt,
    expiresAt,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
  }
}

function recordKey(value) {
  return `${value.fingerprint}\u0000${value.axis}`
}

export function backgroundBenchmarkStopCachePath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cache', 'vision-router', 'background-benchmark-stops.json')
}

async function load(file, fsOps, at) {
  try {
    const raw = await fsOps.readFile(file, 'utf8')
    const body = JSON.parse(raw)
    if (!body || body.version !== CACHE_VERSION || !Array.isArray(body.stops)) return new Map()
    const records = body.stops
      .map(cleanStop)
      .filter((item) => item && item.expiresAt > at)
    return new Map(records.map((item) => [recordKey(item), item]))
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    return new Map()
  }
}

async function save(file, records, fsOps, at) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  const stops = [...records.values()]
    .map(cleanStop)
    .filter((item) => item && item.expiresAt > at)
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .slice(0, MAX_ENTRIES)
  await fsOps.mkdir(path.dirname(file), { recursive: true })
  await fsOps.writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, stops }), { encoding: 'utf8', mode: 0o600 })
  await fsOps.rename(temporary, file)
}

export function createBackgroundBenchmarkStopStore(options = {}) {
  const file = options.cacheFile ?? backgroundBenchmarkStopCachePath(options.dshHome)
  const fsOps = {
    readFile: options.fsOps?.readFile ?? readFile,
    mkdir: options.fsOps?.mkdir ?? mkdir,
    writeFile: options.fsOps?.writeFile ?? writeFile,
    rename: options.fsOps?.rename ?? rename,
  }
  const logger = options.logger
  const now = typeof options.now === 'function' ? options.now : Date.now
  let records = new Map()
  let saveTail = Promise.resolve()
  const ready = load(file, fsOps, Number(now())).then((loaded) => { records = loaded })

  const persist = () => {
    const at = Number(now())
    saveTail = saveTail
      .then(() => save(file, records, fsOps, at))
      .catch((error) => logger?.warn?.('vision-router: background stop cache write failed: %s', cleanText(error?.message ?? error, 240)))
    return saveTail
  }

  const pruneExpired = () => {
    const at = Number(now())
    let removed = false
    for (const [key, record] of records.entries()) {
      if (record.expiresAt > at) continue
      records.delete(key)
      removed = true
    }
    return removed
  }

  return {
    file,
    async list() {
      await ready
      if (pruneExpired()) await persist()
      return [...records.values()].sort((a, b) => b.recordedAt - a.recordedAt)
    },
    async mark({
      fingerprint,
      key,
      provider,
      model,
      axis,
      errorClass,
      errorCode,
      credentialFingerprint,
      recordedAt = Number(now()),
      expiresAt,
    } = {}) {
      await ready
      pruneExpired()
      const clean = cleanStop({
        fingerprint,
        key,
        provider,
        model,
        axis,
        errorClass,
        errorCode,
        credentialFingerprint,
        recordedAt,
        expiresAt,
        suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
      })
      if (!clean) return undefined
      records.set(recordKey(clean), clean)
      await persist()
      return clean
    },
    async clearStop(fingerprint, axis) {
      await ready
      const removed = records.delete(`${String(fingerprint ?? '')}\u0000${String(axis ?? '')}`)
      if (removed) await persist()
      return removed
    },
    async clearFingerprint(fingerprint) {
      await ready
      const wanted = String(fingerprint ?? '')
      let removed = false
      for (const [key, record] of records.entries()) {
        if (record.fingerprint !== wanted) continue
        records.delete(key)
        removed = true
      }
      if (removed) await persist()
      return removed
    },
    async flush() {
      await ready
      await saveTail
    },
  }
}

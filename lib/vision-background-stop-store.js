import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveDshHome } from './doctor.js'
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from './vision-capability-benchmark.js'

const CACHE_VERSION = 1
const MAX_ENTRIES = 256
const AXES = new Set(['ocr', 'general', 'document', 'structured', 'grounding'])
const CLASSES = new Set(['auth', 'unavailable', 'protocol', 'visual-proof', 'infrastructure'])

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
  const recordedAt = Number(value.recordedAt)
  if (!key || !provider || !model || !AXES.has(axis) || !CLASSES.has(errorClass)) return undefined
  if (!Number.isFinite(recordedAt) || recordedAt <= 0) return undefined
  return {
    fingerprint,
    key,
    provider,
    model,
    axis,
    errorClass,
    ...(errorCode ? { errorCode } : {}),
    recordedAt,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
  }
}

function recordKey(value) {
  return `${value.fingerprint}\u0000${value.axis}`
}

export function backgroundBenchmarkStopCachePath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cache', 'vision-router', 'background-benchmark-stops.json')
}

async function load(file, fsOps) {
  try {
    const raw = await fsOps.readFile(file, 'utf8')
    const body = JSON.parse(raw)
    if (!body || body.version !== CACHE_VERSION || !Array.isArray(body.stops)) return new Map()
    const records = body.stops.map(cleanStop).filter(Boolean)
    return new Map(records.map((item) => [recordKey(item), item]))
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    return new Map()
  }
}

async function save(file, records, fsOps) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  const stops = [...records.values()]
    .map(cleanStop)
    .filter(Boolean)
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
  let records = new Map()
  let saveTail = Promise.resolve()
  const ready = load(file, fsOps).then((loaded) => { records = loaded })

  const persist = () => {
    saveTail = saveTail
      .then(() => save(file, records, fsOps))
      .catch((error) => logger?.warn?.('vision-router: background stop cache write failed: %s', cleanText(error?.message ?? error, 240)))
    return saveTail
  }

  return {
    file,
    async list() {
      await ready
      return [...records.values()].sort((a, b) => b.recordedAt - a.recordedAt)
    },
    async mark({ fingerprint, key, provider, model, axis, errorClass, errorCode, recordedAt = Date.now() } = {}) {
      await ready
      const clean = cleanStop({
        fingerprint,
        key,
        provider,
        model,
        axis,
        errorClass,
        errorCode,
        recordedAt,
        suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
      })
      if (!clean) return undefined
      records.set(recordKey(clean), clean)
      await persist()
      return clean
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

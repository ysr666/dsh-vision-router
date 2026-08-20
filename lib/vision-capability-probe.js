import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveDshHome } from './doctor.js'
import { VISION_INTENTS } from './vision-capability-router.js'
import {
  capabilityBenchmarkFingerprint,
  listCapabilityBenchmarkFixtures,
  scoreCapabilityBenchmarkResult,
  aggregateCapabilityBenchmark,
} from './vision-capability-benchmark.js'

export const CAPABILITY_PROFILE_CACHE_VERSION = 1
export const DEFAULT_CAPABILITY_PROFILE_MAX_ENTRIES = 128
export const DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function boundedText(value, max = 256) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : ''
}

function boundedError(error) {
  const text = error && error.message ? error.message : String(error ?? '')
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 240)
}

function abortError() {
  const error = new Error('vision capability benchmark aborted')
  error.name = 'AbortError'
  return error
}

function normalizedIntentList(intents) {
  if (!Array.isArray(intents) || intents.length === 0) return undefined
  const seen = new Set()
  return intents.filter((intent) => {
    if (!VISION_INTENTS.includes(intent) || seen.has(intent)) return false
    seen.add(intent)
    return true
  })
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function cleanScoreMap(value) {
  const out = {}
  for (const intent of VISION_INTENTS) {
    const score = Number(value?.[intent])
    if (Number.isFinite(score)) out[intent] = Math.max(0, Math.min(1, score))
  }
  return out
}

function cleanLatencyMap(value) {
  const out = {}
  for (const intent of VISION_INTENTS) {
    const latencyMs = Number(value?.[intent])
    if (Number.isFinite(latencyMs) && latencyMs >= 0) out[intent] = latencyMs
  }
  return out
}

function cleanCoordinateBox(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const key of ['x1', 'y1', 'x2', 'y2']) {
    const n = Number(value[key])
    if (!Number.isFinite(n)) return undefined
    out[key] = Number(n.toFixed(3))
  }
  return out
}

function cleanGroundingDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const score = Number(value.score)
  const iou = Number(value.iou)
  const parsed = Array.isArray(value.parsed)
    ? value.parsed.slice(0, 8).map((item) => Number.isFinite(Number(item)) ? Number(item) : boundedText(item, 40))
    : undefined
  const normalized = cleanCoordinateBox(value.normalized)
  const candidateSpaces = Array.isArray(value.candidateSpaces)
    ? value.candidateSpaces.slice(0, 8).map((item) => boundedText(item, 48)).filter(Boolean)
    : []
  const diagnostic = {
    score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
    iou: Number.isFinite(iou) ? Math.max(0, Math.min(1, iou)) : 0,
    formatValid: value.formatValid === true,
    parseSource: boundedText(value.parseSource, 64),
    coordinateSpace: boundedText(value.coordinateSpace, 64),
    responseShape: boundedText(value.responseShape, 64),
    candidateSpaces,
    ...(parsed ? { parsed } : {}),
    ...(normalized ? { normalized } : {}),
  }
  return diagnostic
}

function groundingDiagnosticFromResults(results) {
  if (!Array.isArray(results)) return undefined
  const result = results.find((entry) => entry?.intent === 'grounding')
  if (!result) return undefined
  const details = result.details && typeof result.details === 'object' ? result.details : {}
  return cleanGroundingDiagnostic({
    score: result.score,
    iou: details.iou,
    formatValid: details.formatValid,
    parseSource: details.parseSource,
    coordinateSpace: details.coordinateSpace,
    responseShape: details.responseShape,
    parsed: details.parsed,
    normalized: details.normalized,
    candidateSpaces: details.candidateSpaces,
  })
}

export function capabilityProfileCachePath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cache', 'vision-router', 'capability-profiles.json')
}

export function sanitizeCapabilityProfileRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  const fingerprint = boundedText(record.fingerprint, 64)
  if (!/^ep2_[0-9a-f]{32}$/.test(fingerprint)) return undefined
  const provider = boundedText(record.provider)
  const model = boundedText(record.model)
  const measuredAt = Number(record.measuredAt)
  if (provider === '' || model === '' || !Number.isFinite(measuredAt) || measuredAt <= 0) return undefined
  const scores = cleanScoreMap(record.scores)
  if (Object.keys(scores).length === 0) return undefined
  const medianLatencyMs = cleanLatencyMap(record.medianLatencyMs)
  const latencyMs = Number(record.latencyMs)
  const fixtureCount = Math.max(0, Math.floor(Number(record.fixtureCount) || 0))
  const failureCount = Math.max(0, Math.floor(Number(record.failureCount) || 0))
  const groundingDiagnostic = cleanGroundingDiagnostic(record.groundingDiagnostic)
  return {
    fingerprint,
    provider,
    model,
    measuredAt,
    source: 'self-benchmark',
    scores,
    medianLatencyMs,
    ...(Number.isFinite(latencyMs) && latencyMs >= 0 ? { latencyMs } : {}),
    fixtureCount,
    failureCount,
    ...(groundingDiagnostic ? { groundingDiagnostic } : {}),
  }
}

/**
 * Execute synthetic fixtures against exactly one configured backend.
 *
 * invoke() receives exactBackend=true and allowFallback=false. A transport may
 * additionally return usedFingerprint; when it does, any mismatch is rejected
 * instead of poisoning measured evidence with a fallback backend's result.
 */
export async function runExactCapabilityBenchmark({
  backend,
  invoke,
  intents,
  signal,
  now = Date.now,
} = {}) {
  if (!backend || typeof backend !== 'object') throw new TypeError('backend is required')
  if (typeof invoke !== 'function') throw new TypeError('invoke must be a function')
  const provider = boundedText(backend.provider)
  const model = boundedText(backend.model)
  if (provider === '' || model === '') throw new TypeError('backend provider/model are required')

  const fingerprint = capabilityBenchmarkFingerprint(backend)
  const selectedIntents = normalizedIntentList(intents)
  const fixtures = listCapabilityBenchmarkFixtures(selectedIntents)
  const results = []
  let failureCount = 0

  for (const fixture of fixtures) {
    if (signal?.aborted) throw abortError()
    const started = Number(now())
    try {
      const response = await invoke({
        backend: { ...backend, provider, model, fingerprint },
        fixture,
        exactBackend: true,
        allowFallback: false,
        signal,
      })
      if (signal?.aborted) throw abortError()
      const finished = Number(now())
      const latencyMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : undefined
      const usedFingerprint = response && typeof response === 'object' && !Array.isArray(response)
        ? boundedText(response.usedFingerprint, 64)
        : ''
      if (usedFingerprint !== '' && usedFingerprint !== fingerprint) {
        const error = new Error(`benchmark backend mismatch: expected ${fingerprint}, got ${usedFingerprint}`)
        error.code = 'CAPABILITY_BENCHMARK_BACKEND_MISMATCH'
        throw error
      }
      const output = response && typeof response === 'object' && !Array.isArray(response)
        ? response.output ?? response.text ?? ''
        : response
      results.push(scoreCapabilityBenchmarkResult(fixture, output, latencyMs))
    } catch (error) {
      if (
        error?.name === 'AbortError' ||
        error?.code === 'CAPABILITY_BENCHMARK_BACKEND_MISMATCH' ||
        error?.benchmarkFatal === true
      ) throw error
      const finished = Number(now())
      const latencyMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : undefined
      failureCount += 1
      results.push({
        fixture: fixture.id,
        intent: fixture.intent,
        score: 0,
        latencyMs,
        details: { error: boundedError(error) },
      })
    }
  }

  const aggregate = aggregateCapabilityBenchmark(results)
  const measuredAt = Number(now())
  const latencyMs = median(Object.values(aggregate.medianLatencyMs ?? {}).map(Number))
  const groundingDiagnostic = groundingDiagnosticFromResults(results)
  const record = sanitizeCapabilityProfileRecord({
    fingerprint,
    provider,
    model,
    measuredAt: Number.isFinite(measuredAt) && measuredAt > 0 ? measuredAt : Date.now(),
    scores: aggregate.scores,
    medianLatencyMs: aggregate.medianLatencyMs,
    latencyMs,
    fixtureCount: aggregate.fixtureCount,
    failureCount,
    ...(groundingDiagnostic ? { groundingDiagnostic } : {}),
  })
  if (record === undefined) throw new Error('benchmark produced no usable capability evidence')
  return { record, results }
}

function cacheEnvelope(records) {
  return { version: CAPABILITY_PROFILE_CACHE_VERSION, profiles: records }
}

async function loadCache(file, fsOps, { now, maxAgeMs }) {
  try {
    const raw = await fsOps.readFile(file, 'utf8')
    const body = JSON.parse(raw)
    if (!body || body.version !== CAPABILITY_PROFILE_CACHE_VERSION || !Array.isArray(body.profiles)) return new Map()
    const cutoff = Number(now()) - maxAgeMs
    return new Map(
      body.profiles
        .map(sanitizeCapabilityProfileRecord)
        .filter((record) => record !== undefined && record.measuredAt >= cutoff)
        .map((record) => [record.fingerprint, record]),
    )
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    return new Map()
  }
}

async function saveCache(file, records, fsOps, maxEntries) {
  const directory = path.dirname(file)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  const profiles = [...records.values()]
    .map(sanitizeCapabilityProfileRecord)
    .filter(Boolean)
    .sort((a, b) => b.measuredAt - a.measuredAt || a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, maxEntries)
  await fsOps.mkdir(directory, { recursive: true })
  await fsOps.writeFile(temporary, JSON.stringify(cacheEnvelope(profiles)), { encoding: 'utf8', mode: 0o600 })
  await fsOps.rename(temporary, file)
}

export function createCapabilityProfileStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const maxEntries = Math.max(1, Math.min(512, Math.floor(Number(options.maxEntries) || DEFAULT_CAPABILITY_PROFILE_MAX_ENTRIES)))
  const maxAgeMs = Math.max(24 * 60 * 60 * 1000, Number(options.maxAgeMs) || DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS)
  const file = options.cacheFile ?? capabilityProfileCachePath(options.dshHome)
  const fsOps = {
    readFile: options.fsOps?.readFile ?? readFile,
    mkdir: options.fsOps?.mkdir ?? mkdir,
    writeFile: options.fsOps?.writeFile ?? writeFile,
    rename: options.fsOps?.rename ?? rename,
  }
  const logger = options.logger
  let records = new Map()
  let saveTail = Promise.resolve()
  const ready = loadCache(file, fsOps, { now, maxAgeMs }).then((loaded) => { records = loaded })

  const persist = () => {
    saveTail = saveTail
      .then(() => saveCache(file, records, fsOps, maxEntries))
      .catch((error) => logger?.warn?.('vision-router: capability profile cache write failed: %s', boundedError(error)))
    return saveTail
  }

  return {
    file,
    async get(fingerprint) {
      await ready
      return records.get(String(fingerprint ?? ''))
    },
    async list() {
      await ready
      return [...records.values()].sort((a, b) => b.measuredAt - a.measuredAt)
    },
    async put(record) {
      await ready
      const clean = sanitizeCapabilityProfileRecord(record)
      if (clean === undefined) throw new TypeError('invalid capability profile record')
      const existing = records.get(clean.fingerprint)
      // A low-coverage quick retest must never erase a richer full profile.
      // Full tests can replace quick tests; equal-coverage tests may refresh.
      if (existing && Number(existing.fixtureCount) > Number(clean.fixtureCount)) return existing
      records.set(clean.fingerprint, clean)
      await persist()
      return clean
    },
    async remove(fingerprint) {
      await ready
      const removed = records.delete(String(fingerprint ?? ''))
      if (removed) await persist()
      return removed
    },
    async flush() {
      await ready
      await saveTail
    },
  }
}

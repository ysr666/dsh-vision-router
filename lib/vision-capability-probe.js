import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveDshHome } from './doctor.js'
import { VISION_INTENTS } from './vision-capability-router.js'
import {
  CAPABILITY_BENCHMARK_SUITE_REVISION,
  listCapabilityBenchmarkFixtures,
  scoreCapabilityBenchmarkResult,
  aggregateCapabilityBenchmark,
} from './vision-capability-benchmark.js'
import { capabilityEvidenceFingerprint } from './vision-capability-identity.js'

export const CAPABILITY_PROFILE_CACHE_VERSION = 4
export const DEFAULT_CAPABILITY_PROFILE_MAX_ENTRIES = 128

function boundedText(value, max = 256) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : ''
}

function boundedError(error) {
  const text = error && error.message ? error.message : String(error ?? '')
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 240)
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('vision capability benchmark aborted')
  error.name = 'AbortError'
  throw error
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

function cleanMeasuredAtMap(value, scores, fallbackMeasuredAt) {
  const out = {}
  for (const axis of Object.keys(scores)) {
    const axisAt = Number(value?.[axis])
    const fallback = Number(fallbackMeasuredAt)
    const measuredAt = Number.isFinite(axisAt) && axisAt > 0
      ? axisAt
      : Number.isFinite(fallback) && fallback > 0
        ? fallback
        : undefined
    if (measuredAt !== undefined) out[axis] = measuredAt
  }
  return out
}

function cleanFixtureCountMap(value, scores, fixtureCount) {
  const axes = Object.keys(scores)
  const out = {}
  for (const axis of axes) {
    const count = Math.floor(Number(value?.[axis]) || 0)
    if (count > 0) out[axis] = count
  }
  if (Object.keys(out).length > 0) {
    for (const axis of axes) if (!out[axis]) out[axis] = 1
    return out
  }
  for (const axis of axes) out[axis] = 1
  let extra = Math.max(0, Math.floor(Number(fixtureCount) || 0) - axes.length)
  if (extra > 0 && axes.includes('ocr')) {
    out.ocr += extra
    extra = 0
  }
  if (extra > 0 && axes.length > 0) out[axes[0]] += extra
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
  return {
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

function latestMeasuredAt(map = {}) {
  const values = Object.values(map).map(Number).filter((value) => Number.isFinite(value) && value > 0)
  return values.length > 0 ? Math.max(...values) : undefined
}

function summedFixtureCount(map = {}) {
  return Object.values(map).map(Number).filter(Number.isFinite).reduce((sum, value) => sum + Math.max(0, Math.floor(value)), 0)
}

function aggregateLatency(latencies = {}) {
  return median(Object.values(latencies).map(Number))
}

export function capabilityProfileAxisMeasuredAt(record, axis) {
  const direct = Number(record?.measuredAtByAxis?.[axis])
  if (Number.isFinite(direct) && direct > 0) return direct
  const fallback = Number(record?.measuredAt)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : undefined
}

export function capabilityProfileCachePath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cache', 'vision-router', 'capability-profiles.json')
}

export function sanitizeCapabilityProfileRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  const suiteRevision = Number(record.suiteRevision)
  if (suiteRevision !== CAPABILITY_BENCHMARK_SUITE_REVISION) return undefined
  const fingerprint = boundedText(record.fingerprint, 64)
  if (!/^ep2_[0-9a-f]{32}$/.test(fingerprint)) return undefined
  const provider = boundedText(record.provider)
  const model = boundedText(record.model)
  if (provider === '' || model === '') return undefined

  const rawScores = cleanScoreMap(record.scores)
  const measuredAtByAxis = cleanMeasuredAtMap(record.measuredAtByAxis, rawScores, record.measuredAt)
  const scores = Object.fromEntries(
    Object.entries(rawScores).filter(([axis]) => Number.isFinite(Number(measuredAtByAxis[axis]))),
  )
  if (Object.keys(scores).length === 0) return undefined

  const benchmarkMedianLatencyMsByAxis = Object.fromEntries(
    Object.entries(cleanLatencyMap(record.benchmarkMedianLatencyMsByAxis ?? record.medianLatencyMs))
      .filter(([axis]) => Object.prototype.hasOwnProperty.call(scores, axis)),
  )
  const fixtureCountByAxis = cleanFixtureCountMap(record.fixtureCountByAxis, scores, record.fixtureCount)
  const measuredAt = latestMeasuredAt(measuredAtByAxis)
  if (!Number.isFinite(measuredAt) || measuredAt <= 0) return undefined
  const groundingDiagnostic = Object.prototype.hasOwnProperty.call(scores, 'grounding')
    ? cleanGroundingDiagnostic(record.groundingDiagnostic)
    : undefined
  const benchmarkLatencyMs = aggregateLatency(benchmarkMedianLatencyMsByAxis)

  return {
    fingerprint,
    provider,
    model,
    measuredAt,
    measuredAtByAxis,
    source: 'self-benchmark',
    suiteRevision,
    scores,
    benchmarkMedianLatencyMsByAxis,
    fixtureCountByAxis,
    ...(Number.isFinite(benchmarkLatencyMs) && benchmarkLatencyMs >= 0 ? { benchmarkLatencyMs } : {}),
    fixtureCount: summedFixtureCount(fixtureCountByAxis),
    failureCount: 0,
    ...(groundingDiagnostic ? { groundingDiagnostic } : {}),
  }
}

function mergeCapabilityProfiles(existing, incoming) {
  if (!existing) return incoming
  const scores = { ...existing.scores }
  const measuredAtByAxis = { ...existing.measuredAtByAxis }
  const benchmarkMedianLatencyMsByAxis = { ...existing.benchmarkMedianLatencyMsByAxis }
  const fixtureCountByAxis = { ...existing.fixtureCountByAxis }
  let groundingDiagnostic = existing.groundingDiagnostic

  for (const [axis, score] of Object.entries(incoming.scores ?? {})) {
    const nextAt = capabilityProfileAxisMeasuredAt(incoming, axis)
    const previousAt = capabilityProfileAxisMeasuredAt(existing, axis)
    if (!Number.isFinite(nextAt) || (Number.isFinite(previousAt) && nextAt < previousAt)) continue
    scores[axis] = score
    measuredAtByAxis[axis] = nextAt
    if (Number.isFinite(Number(incoming.benchmarkMedianLatencyMsByAxis?.[axis]))) {
      benchmarkMedianLatencyMsByAxis[axis] = Number(incoming.benchmarkMedianLatencyMsByAxis[axis])
    } else {
      delete benchmarkMedianLatencyMsByAxis[axis]
    }
    fixtureCountByAxis[axis] = Math.max(1, Math.floor(Number(incoming.fixtureCountByAxis?.[axis]) || 1))
    if (axis === 'grounding') groundingDiagnostic = incoming.groundingDiagnostic
  }

  return sanitizeCapabilityProfileRecord({
    ...existing,
    provider: incoming.provider,
    model: incoming.model,
    scores,
    measuredAtByAxis,
    benchmarkMedianLatencyMsByAxis,
    fixtureCountByAxis,
    groundingDiagnostic,
  })
}

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

  const fingerprint = capabilityEvidenceFingerprint(backend)
  const selectedIntents = normalizedIntentList(intents)
  const fixtures = listCapabilityBenchmarkFixtures(selectedIntents)
  const results = []

  for (const fixture of fixtures) {
    throwIfAborted(signal)
    const outerStarted = Number(now())
    const response = await invoke({
      backend: { ...backend, provider, model, fingerprint },
      fixture,
      exactBackend: true,
      allowFallback: false,
      signal,
    })
    throwIfAborted(signal)
    const outerFinished = Number(now())
    const reportedLatency = response && typeof response === 'object' && !Array.isArray(response)
      ? Number(response.latencyMs)
      : NaN
    const latencyMs = Number.isFinite(reportedLatency) && reportedLatency >= 0
      ? reportedLatency
      : Number.isFinite(outerStarted) && Number.isFinite(outerFinished)
        ? Math.max(0, outerFinished - outerStarted)
        : undefined
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
  }

  const aggregate = aggregateCapabilityBenchmark(results)
  const measuredAt = Number(now())
  const normalizedMeasuredAt = Number.isFinite(measuredAt) && measuredAt > 0 ? measuredAt : Date.now()
  const measuredAtByAxis = Object.fromEntries(Object.keys(aggregate.scores ?? {}).map((axis) => [axis, normalizedMeasuredAt]))
  const fixtureCountByAxis = {}
  for (const result of results) fixtureCountByAxis[result.intent] = (fixtureCountByAxis[result.intent] ?? 0) + 1
  const groundingDiagnostic = groundingDiagnosticFromResults(results)
  const record = sanitizeCapabilityProfileRecord({
    fingerprint,
    provider,
    model,
    measuredAt: normalizedMeasuredAt,
    measuredAtByAxis,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
    scores: aggregate.scores,
    benchmarkMedianLatencyMsByAxis: aggregate.medianLatencyMs,
    fixtureCountByAxis,
    fixtureCount: aggregate.fixtureCount,
    failureCount: 0,
    ...(groundingDiagnostic ? { groundingDiagnostic } : {}),
  })
  if (record === undefined) throw new Error('benchmark produced no usable capability evidence')
  return { record, results }
}

function cacheEnvelope(records) {
  return { version: CAPABILITY_PROFILE_CACHE_VERSION, profiles: records }
}

async function loadCache(file, fsOps) {
  try {
    const raw = await fsOps.readFile(file, 'utf8')
    const body = JSON.parse(raw)
    if (!body || body.version !== CAPABILITY_PROFILE_CACHE_VERSION || !Array.isArray(body.profiles)) return new Map()
    return new Map(
      body.profiles
        .map(sanitizeCapabilityProfileRecord)
        .filter(Boolean)
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
  const maxEntries = Math.max(1, Math.min(512, Math.floor(Number(options.maxEntries) || DEFAULT_CAPABILITY_PROFILE_MAX_ENTRIES)))
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
  const ready = loadCache(file, fsOps).then((loaded) => { records = loaded })

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
      const merged = mergeCapabilityProfiles(existing, clean)
      if (merged === undefined) throw new TypeError('invalid merged capability profile record')
      if (existing && JSON.stringify(existing) === JSON.stringify(merged)) return existing
      records.set(clean.fingerprint, merged)
      await persist()
      return merged
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

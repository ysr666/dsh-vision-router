import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  BENCHMARK_AXES,
  type BenchmarkAxis,
} from './vision-capability-evidence.js'
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from './vision-capability-fingerprint.js'

const CACHE_VERSION = 3
const MAX_ENTRIES = 256

export type PersistentBackgroundFailureClass = 'unavailable' | 'protocol'

export interface BackgroundBenchmarkStop {
  readonly fingerprint: string
  readonly key: string
  readonly provider: string
  readonly model: string
  readonly axis: BenchmarkAxis
  readonly errorClass: PersistentBackgroundFailureClass
  readonly errorCode?: string
  readonly recordedAt: number
  readonly expiresAt: number
  readonly suiteRevision: typeof CAPABILITY_BENCHMARK_SUITE_REVISION
}

export interface BackgroundBenchmarkStopInput {
  readonly fingerprint?: string
  readonly key?: string
  readonly provider?: string
  readonly model?: string
  readonly axis?: BenchmarkAxis
  readonly errorClass?: PersistentBackgroundFailureClass
  readonly errorCode?: string
  readonly recordedAt?: number
  readonly expiresAt?: number
}

interface BackgroundStopFsOps {
  readonly readFile: typeof readFile
  readonly mkdir: typeof mkdir
  readonly writeFile: typeof writeFile
  readonly rename: typeof rename
}

export interface BackgroundBenchmarkStopStoreLogger {
  warn?: (message: string, ...args: unknown[]) => unknown
}

export interface BackgroundBenchmarkStopStoreOptions {
  readonly file: string
  readonly fsOps?: Partial<BackgroundStopFsOps>
  readonly logger?: BackgroundBenchmarkStopStoreLogger
  readonly now?: () => number
}

export interface BackgroundBenchmarkStopStore {
  readonly file: string
  list(): Promise<BackgroundBenchmarkStop[]>
  mark(input?: BackgroundBenchmarkStopInput): Promise<BackgroundBenchmarkStop | undefined>
  clearStop(fingerprint: string, axis: BenchmarkAxis): Promise<boolean>
  clearFingerprint(fingerprint: string): Promise<boolean>
  flush(): Promise<void>
}

type UnknownRecord = Record<PropertyKey, unknown>

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object'
    ? value as UnknownRecord
    : undefined
}

function cleanText(value: unknown, max = 256): string {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim().slice(0, max)
    : ''
}

function benchmarkAxis(value: string): BenchmarkAxis | undefined {
  return (BENCHMARK_AXES as readonly string[]).includes(value)
    ? value as BenchmarkAxis
    : undefined
}

function persistentFailureClass(
  value: string,
): PersistentBackgroundFailureClass | undefined {
  return value === 'unavailable' || value === 'protocol'
    ? value
    : undefined
}

function cleanStop(value: unknown): BackgroundBenchmarkStop | undefined {
  const record = propertyBag(value)
  if (record === undefined) return undefined
  if (Number(record.suiteRevision) !== CAPABILITY_BENCHMARK_SUITE_REVISION) {
    return undefined
  }

  const fingerprint = cleanText(record.fingerprint, 64)
  if (!/^ep2_[0-9a-f]{32}$/.test(fingerprint)) return undefined
  const key = cleanText(record.key)
  const provider = cleanText(record.provider)
  const model = cleanText(record.model)
  const axis = benchmarkAxis(cleanText(record.axis, 32))
  const errorClass = persistentFailureClass(cleanText(record.errorClass, 48))
  const errorCode = cleanText(record.errorCode, 96)
  const recordedAt = Number(record.recordedAt)
  const expiresAt = Number(record.expiresAt)

  if (!key || !provider || !model || axis === undefined || errorClass === undefined) {
    return undefined
  }
  if (!Number.isFinite(recordedAt) || recordedAt <= 0) return undefined
  if (!Number.isFinite(expiresAt) || expiresAt <= recordedAt) return undefined

  return {
    fingerprint,
    key,
    provider,
    model,
    axis,
    errorClass,
    ...(errorCode ? { errorCode } : {}),
    recordedAt,
    expiresAt,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
  }
}

function recordKey(value: Pick<BackgroundBenchmarkStop, 'fingerprint' | 'axis'>): string {
  return `${value.fingerprint}\u0000${value.axis}`
}

function selectRetainedStops(
  values: Iterable<unknown>,
  at: number,
  maxEntries = MAX_ENTRIES,
): BackgroundBenchmarkStop[] {
  const seen = new Set<string>()
  return [...values]
    .map(cleanStop)
    .filter((item): item is BackgroundBenchmarkStop =>
      item !== undefined && item.expiresAt > at)
    .sort((a, b) =>
      b.recordedAt - a.recordedAt
      || recordKey(a).localeCompare(recordKey(b)))
    .filter((item) => {
      const key = recordKey(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, maxEntries)
}

function retainedStopMap(
  values: Iterable<unknown>,
  at: number,
  maxEntries = MAX_ENTRIES,
): Map<string, BackgroundBenchmarkStop> {
  return new Map(
    selectRetainedStops(values, at, maxEntries)
      .map((item) => [recordKey(item), item]),
  )
}

async function save(
  file: string,
  records: ReadonlyMap<string, BackgroundBenchmarkStop>,
  fsOps: BackgroundStopFsOps,
  at: number,
): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  const stops = selectRetainedStops(records.values(), at)
  await fsOps.mkdir(path.dirname(file), { recursive: true })
  await fsOps.writeFile(
    temporary,
    JSON.stringify({ version: CACHE_VERSION, stops }),
    { encoding: 'utf8', mode: 0o600 },
  )
  await fsOps.rename(temporary, file)
}

async function load(
  file: string,
  fsOps: BackgroundStopFsOps,
  at: number,
): Promise<Map<string, BackgroundBenchmarkStop>> {
  try {
    const raw = await fsOps.readFile(file, 'utf8')
    const body = propertyBag(JSON.parse(raw))
    const stops = body?.stops
    const version = Number(body?.version)
    if (
      !Array.isArray(stops)
      || (version !== 2 && version !== CACHE_VERSION)
    ) {
      return new Map()
    }
    const records = retainedStopMap(stops, at)
    // Rewrite whenever loading changed the persisted set: v2 stored raw entries
    // that this version must drop, and any later retention rule (category,
    // expiry, fingerprint shape) has to reach the file the same way instead of
    // leaving a stale record that only the runtime filter happens to hide.
    if (version === 2 || records.size !== stops.length) {
      try {
        await save(file, records, fsOps, at)
      } catch {
        // This rewrite is opportunistic: a read-only or full disk must not discard the records
        // the load could still read (the catch below returns an empty map). The store's own
        // persist() retries the write and reports it through the logger.
      }
    }
    return records
  } catch (error) {
    if (propertyBag(error)?.code === 'ENOENT') return new Map()
    return new Map()
  }
}

/**
 * Durable stop owner for unattended capability measurement.
 *
 * Only endpoint/model evidence that is benchmark-axis-scoped and safe to
 * persist (protocol or unavailable) can enter this store. AUTH remains a
 * process-local access condition and is rejected by runtime validation even
 * when legacy v2 cache data contains it.
 */
export function createBackgroundBenchmarkStopStoreCore(
  options: BackgroundBenchmarkStopStoreOptions,
): BackgroundBenchmarkStopStore {
  const file = options.file
  const fsOps: BackgroundStopFsOps = {
    readFile: options.fsOps?.readFile ?? readFile,
    mkdir: options.fsOps?.mkdir ?? mkdir,
    writeFile: options.fsOps?.writeFile ?? writeFile,
    rename: options.fsOps?.rename ?? rename,
  }
  const logger = options.logger
  const now = typeof options.now === 'function' ? options.now : Date.now
  let records = new Map<string, BackgroundBenchmarkStop>()
  let saveTail: Promise<void> = Promise.resolve()
  const ready = load(file, fsOps, Number(now()))
    .then((loaded) => {
      records = loaded
    })

  const persist = (): Promise<void> => {
    const at = Number(now())
    saveTail = saveTail
      .then(() => save(file, records, fsOps, at))
      .catch((error: unknown) => {
        logger?.warn?.(
          'vision-router: background stop cache write failed: %s',
          cleanText(propertyBag(error)?.message ?? error, 240),
        )
      })
    return saveTail
  }

  const reconcile = (): boolean => {
    const at = Number(now())
    const retained = retainedStopMap(records.values(), at)
    const changed =
      retained.size !== records.size
      || [...retained.keys()].some((key) => !records.has(key))
    records = retained
    return changed
  }

  return {
    file,

    async list(): Promise<BackgroundBenchmarkStop[]> {
      await ready
      if (reconcile()) await persist()
      return [...records.values()]
        .sort((a, b) => b.recordedAt - a.recordedAt)
    },

    async mark(
      {
        fingerprint,
        key,
        provider,
        model,
        axis,
        errorClass,
        errorCode,
        recordedAt = Number(now()),
        expiresAt,
      }: BackgroundBenchmarkStopInput = {},
    ): Promise<BackgroundBenchmarkStop | undefined> {
      await ready
      reconcile()
      const clean = cleanStop({
        fingerprint,
        key,
        provider,
        model,
        axis,
        errorClass,
        errorCode,
        recordedAt,
        expiresAt,
        suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
      })
      if (clean === undefined) return undefined

      const keyOfStop = recordKey(clean)
      records.set(keyOfStop, clean)
      reconcile()
      await persist()
      return records.get(keyOfStop)
    },

    async clearStop(
      fingerprint: string,
      axis: BenchmarkAxis,
    ): Promise<boolean> {
      await ready
      const removed = records.delete(`${String(fingerprint ?? '')}\u0000${String(axis ?? '')}`)
      if (removed) await persist()
      return removed
    },

    async clearFingerprint(fingerprint: string): Promise<boolean> {
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

    async flush(): Promise<void> {
      await ready
      await saveTail
    },
  }
}

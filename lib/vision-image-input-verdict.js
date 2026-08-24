import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveDshHome } from './doctor.js'
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from './vision-capability-benchmark.js'

const CACHE_VERSION = 1
const MAX_ENTRIES = 128

function cleanText(value, max = 256) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : ''
}

function cleanVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.state !== 'unsupported') return undefined
  if (Number(value.suiteRevision) !== CAPABILITY_BENCHMARK_SUITE_REVISION) return undefined
  const fingerprint = cleanText(value.fingerprint, 64)
  if (!/^ep2_[0-9a-f]{32}$/.test(fingerprint)) return undefined
  const key = cleanText(value.key)
  const provider = cleanText(value.provider)
  const model = cleanText(value.model)
  const measuredAt = Number(value.measuredAt)
  if (!key || !provider || !model || !Number.isFinite(measuredAt) || measuredAt <= 0) return undefined
  return {
    fingerprint,
    key,
    provider,
    model,
    state: 'unsupported',
    reason: 'provider-rejected-image',
    measuredAt,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
  }
}

export function imageInputVerdictCachePath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cache', 'vision-router', 'image-input-verdicts.json')
}

async function load(file, fsOps) {
  try {
    const raw = await fsOps.readFile(file, 'utf8')
    const body = JSON.parse(raw)
    if (!body || body.version !== CACHE_VERSION || !Array.isArray(body.verdicts)) return new Map()
    return new Map(body.verdicts.map(cleanVerdict).filter(Boolean).map((item) => [item.fingerprint, item]))
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    return new Map()
  }
}

async function save(file, records, fsOps) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  const verdicts = [...records.values()]
    .map(cleanVerdict)
    .filter(Boolean)
    .sort((a, b) => b.measuredAt - a.measuredAt)
    .slice(0, MAX_ENTRIES)
  await fsOps.mkdir(path.dirname(file), { recursive: true })
  await fsOps.writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, verdicts }), { encoding: 'utf8', mode: 0o600 })
  await fsOps.rename(temporary, file)
}

export function createImageInputVerdictStore(options = {}) {
  const file = options.cacheFile ?? imageInputVerdictCachePath(options.dshHome)
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
      .catch((error) => logger?.warn?.('vision-router: image input verdict cache write failed: %s', cleanText(error?.message ?? error, 240)))
    return saveTail
  }

  return {
    file,
    async get(fingerprint) {
      await ready
      return records.get(String(fingerprint ?? ''))
    },
    async markUnsupported({ fingerprint, key, provider, model, measuredAt = Date.now() } = {}) {
      await ready
      const clean = cleanVerdict({
        fingerprint,
        key,
        provider,
        model,
        state: 'unsupported',
        measuredAt,
        suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
      })
      if (!clean) return undefined
      records.set(clean.fingerprint, clean)
      await persist()
      return clean
    },
    async clear(fingerprint) {
      await ready
      const removed = records.delete(String(fingerprint ?? ''))
      if (removed) await persist()
      return removed
    },
    async list() {
      await ready
      return [...records.values()].sort((a, b) => b.measuredAt - a.measuredAt)
    },
    async flush() {
      await ready
      await saveTail
    },
  }
}

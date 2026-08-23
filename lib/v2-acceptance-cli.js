#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { V2_ACCEPTANCE_PATH } from './v2-acceptance-service.js'
import { CAPABILITY_BENCHMARK_PATH } from './vision-capability-benchmark-service.js'
import { VISION_ROUTING_PREVIEW_PATH } from './vision-routing-preview-service.js'

const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:3080'
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const J0B_EXPECTED_AXES = Object.freeze({
  quick: Object.freeze(['ocr', 'general']),
  full: Object.freeze(['structured', 'ocr', 'document', 'grounding', 'general']),
  grounding: Object.freeze(['grounding']),
})

function usage() {
  return `dsh-vision-router-acceptance [options]\n\nRuns v2 real-machine acceptance against the currently running local DSH process.\nJ0a safe authority checks and J0b real-provider measurement are independently authorized.\n\nActions:\n  --accept-safe-mutations        Run J0a safe authority acceptance.\n  --list-candidates              Read-only: list exact Benchmark candidate keys; no mutations/provider calls.\n  --provider <backend-key>       Run J0b exact real-provider Benchmark acceptance on this candidate.\n\nJ0b authorization:\n  --allow-provider-requests      Explicitly authorize real provider requests for --provider.\n  --allow-chargeable-cloud       Additionally authorize a selected backend that may incur API charges.\n\nOptions:\n  --runtime-url <url>            Running local DSH Web URL (default: DSH_WEB_URL or ${DEFAULT_RUNTIME_URL}).\n  --mode <quick|full|grounding>  Provider Benchmark mode (default: quick).\n  --force                        Force provider verification when DSH metadata declares the model text-only.\n  --json                         Emit the full machine-readable report.\n  --help                         Show this help.\n\nExamples:\n  dsh-vision-router-acceptance --accept-safe-mutations --json\n  dsh-vision-router-acceptance --list-candidates\n  dsh-vision-router-acceptance --provider vision-http/local-ollama/qwen2.5vl --allow-provider-requests --json\n  dsh-vision-router-acceptance --provider http:cloud/model --allow-provider-requests --allow-chargeable-cloud --json\n  dsh-vision-router-acceptance --accept-safe-mutations --provider vision-http/local-ollama/qwen2.5vl --allow-provider-requests --json\n`
}

export function parseAcceptanceArgs(argv = []) {
  const options = {
    runtimeUrl: process.env.DSH_WEB_URL || DEFAULT_RUNTIME_URL,
    acceptedSafeMutations: false,
    acceptedProviderRequests: false,
    acceptedChargeableCloud: false,
    listCandidates: false,
    provider: undefined,
    mode: 'quick',
    force: false,
    json: false,
  }
  const args = [...argv]
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--help' || value === '-h') return { ...options, help: true }
    if (value === '--accept-safe-mutations') { options.acceptedSafeMutations = true; continue }
    if (value === '--allow-provider-requests') { options.acceptedProviderRequests = true; continue }
    if (value === '--allow-chargeable-cloud') { options.acceptedChargeableCloud = true; continue }
    if (value === '--list-candidates') { options.listCandidates = true; continue }
    if (value === '--force') { options.force = true; continue }
    if (value === '--json') { options.json = true; continue }
    if (value === '--runtime-url') {
      options.runtimeUrl = args[index + 1]
      index += 1
      if (!options.runtimeUrl) throw new Error('--runtime-url requires a URL')
      continue
    }
    if (value.startsWith('--runtime-url=')) {
      options.runtimeUrl = value.slice('--runtime-url='.length)
      if (!options.runtimeUrl) throw new Error('--runtime-url requires a URL')
      continue
    }
    if (value === '--provider') {
      options.provider = args[index + 1]
      index += 1
      if (!options.provider) throw new Error('--provider requires an exact backend key')
      continue
    }
    if (value.startsWith('--provider=')) {
      options.provider = value.slice('--provider='.length)
      if (!options.provider) throw new Error('--provider requires an exact backend key')
      continue
    }
    if (value === '--mode') {
      options.mode = args[index + 1]
      index += 1
      if (!options.mode) throw new Error('--mode requires quick, full, or grounding')
      continue
    }
    if (value.startsWith('--mode=')) {
      options.mode = value.slice('--mode='.length)
      continue
    }
    throw new Error(`unknown argument: ${value}`)
  }
  if (!['quick', 'full', 'grounding'].includes(options.mode)) throw new Error('--mode must be quick, full, or grounding')
  let parsed
  try { parsed = new URL(options.runtimeUrl) } catch { throw new Error(`invalid runtime URL: ${options.runtimeUrl}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`invalid runtime URL protocol: ${parsed.protocol}`)
  if (options.listCandidates && (
    options.acceptedSafeMutations || options.provider || options.acceptedProviderRequests || options.acceptedChargeableCloud || options.force || options.mode !== 'quick'
  )) throw new Error('--list-candidates is read-only and cannot be combined with acceptance/mutation/provider options')
  if (options.provider && options.acceptedProviderRequests !== true) {
    throw new Error('--provider requires --allow-provider-requests')
  }
  if (!options.provider && (options.acceptedProviderRequests || options.acceptedChargeableCloud || options.force || options.mode !== 'quick')) {
    throw new Error('provider authorization/mode options require --provider')
  }
  if (options.acceptedChargeableCloud && options.acceptedProviderRequests !== true) {
    throw new Error('--allow-chargeable-cloud requires --allow-provider-requests')
  }
  return options
}

function joinUrl(base, path) {
  const url = new URL(base)
  url.pathname = path
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(joinUrl(baseUrl, path), {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { ok: false, error: `non-JSON response (${response.status})` } }
  return { status: response.status, ok: response.ok, body }
}

const FORBIDDEN_KEYS = new Set([
  'apikey',
  'api_key',
  'apikeyenv',
  'credential',
  'credentialref',
  'credentialreference',
  'baseurl',
  'rawresponse',
  'rawmodelresponse',
  'messages',
])

export function inspectPublicSurfacePayload(value) {
  const violations = []
  const visit = (node, path = '$') => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (!node || typeof node !== 'object') {
      if (typeof node === 'string') {
        if (/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i.test(node)) violations.push(`${path}: bearer token pattern`)
        if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/i.test(node)) violations.push(`${path}: secret-key pattern`)
        if (/https?:\/\/[^\s]+/i.test(node)) violations.push(`${path}: raw URL`)
      }
      return
    }
    for (const [key, child] of Object.entries(node)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '')
      if (key !== 'endpointFingerprint' && FORBIDDEN_KEYS.has(normalized)) violations.push(`${path}.${key}: forbidden public field`)
      visit(child, `${path}.${key}`)
    }
  }
  visit(value)
  return violations
}

function surfaceCase(id, pass, summary, details = {}) {
  return { id, status: pass ? 'pass' : 'fail', summary, ...(Object.keys(details).length ? { details } : {}) }
}

async function inspectLivePublicSurfaces(runtimeUrl) {
  const cases = []
  const preview = await requestJson(runtimeUrl, VISION_ROUTING_PREVIEW_PATH)
  const previewViolations = preview.ok ? inspectPublicSurfacePayload(preview.body) : [`HTTP ${preview.status}`]
  cases.push(surfaceCase(
    'X-preview',
    preview.ok
      && preview.body?.autoPreviewOnly === true
      && preview.body?.executionActive === false
      && preview.body?.healthIncluded === false
      && previewViolations.length === 0,
    'live routing preview remains read-only, execution-inactive, and secret-minimized',
    {
      status: preview.status,
      autoPreviewOnly: preview.body?.autoPreviewOnly ?? null,
      executionActive: preview.body?.executionActive ?? null,
      healthIncluded: preview.body?.healthIncluded ?? null,
      violations: previewViolations,
    },
  ))

  const benchmark = await requestJson(runtimeUrl, CAPABILITY_BENCHMARK_PATH)
  const benchmarkViolations = benchmark.ok ? inspectPublicSurfacePayload(benchmark.body) : [`HTTP ${benchmark.status}`]
  cases.push(surfaceCase(
    'P-public',
    benchmark.ok && benchmarkViolations.length === 0,
    'live Benchmark snapshot exposes no credential, raw endpoint, raw response, or token material',
    { status: benchmark.status, violations: benchmarkViolations },
  ))
  return { ok: cases.every((entry) => entry.status === 'pass'), cases }
}

function candidateFromSnapshot(snapshot, key) {
  return Array.isArray(snapshot?.candidates) ? snapshot.candidates.find((entry) => entry?.key === key) : undefined
}

function stableValue(value) {
  return JSON.stringify(value ?? null)
}

function publicMeasuredAxis(measured, axis) {
  return {
    score: Number.isFinite(Number(measured?.scores?.[axis])) ? Number(measured.scores[axis]) : undefined,
    measuredAt: Number.isFinite(Number(measured?.measuredAtByAxis?.[axis])) ? Number(measured.measuredAtByAxis[axis]) : undefined,
    benchmarkMedianLatencyMs: Number.isFinite(Number(measured?.benchmarkMedianLatencyMs?.[axis])) ? Number(measured.benchmarkMedianLatencyMs[axis]) : undefined,
    fixtureCount: Number.isFinite(Number(measured?.fixtureCountByAxis?.[axis])) ? Number(measured.fixtureCountByAxis[axis]) : undefined,
  }
}

export function inspectProviderEvidence({ beforeSnapshot, afterSnapshot, providerReport, key, mode = 'quick', startedAt = 0 } = {}) {
  const cases = []
  const before = candidateFromSnapshot(beforeSnapshot, key)
  const after = candidateFromSnapshot(afterSnapshot, key)
  const expectedAxes = [...(J0B_EXPECTED_AXES[mode] ?? J0B_EXPECTED_AXES.quick)]
  const reportCandidate = providerReport?.candidate
  const exactIdentity = Boolean(
    before && after && reportCandidate
      && before.key === key
      && after.key === key
      && before.fingerprint
      && before.fingerprint === after.fingerprint
      && before.provider === after.provider
      && before.model === after.model
      && reportCandidate.key === key
      && reportCandidate.provider === after.provider
      && reportCandidate.model === after.model,
  )
  cases.push(surfaceCase(
    'J0B-exact-identity',
    exactIdentity,
    'the authorized real Benchmark stays bound to the same exact backend identity/fingerprint',
    {
      key,
      provider: after?.provider ?? null,
      model: after?.model ?? null,
      fingerprintStable: Boolean(before?.fingerprint && before.fingerprint === after?.fingerprint),
    },
  ))

  if (providerReport?.ok === true) {
    const freshnessFloor = Math.max(0, Number(startedAt) - 5_000)
    const missing = []
    const stale = []
    for (const axis of expectedAxes) {
      const state = publicMeasuredAxis(after?.measured, axis)
      if (!Number.isFinite(state.score) || !Number.isFinite(state.measuredAt)) missing.push(axis)
      else if (state.measuredAt < freshnessFloor) stale.push(axis)
    }
    cases.push(surfaceCase(
      'J0B-capability-evidence',
      missing.length === 0 && stale.length === 0 && Number(after?.measured?.suiteRevision) === Number(afterSnapshot?.suiteRevision),
      'successful real Benchmark writes fresh capability evidence for every requested direct axis',
      {
        mode,
        expectedAxes,
        measuredAxes: after?.measured?.measuredAxes ?? [],
        missing,
        stale,
        suiteRevision: after?.measured?.suiteRevision ?? null,
      },
    ))

    const allBeforeAxes = Object.keys(before?.measured?.scores ?? {})
    const preservedAxes = allBeforeAxes.filter((axis) => !expectedAxes.includes(axis))
    const changed = preservedAxes.filter((axis) =>
      stableValue(publicMeasuredAxis(before?.measured, axis)) !== stableValue(publicMeasuredAxis(after?.measured, axis)))
    cases.push(surfaceCase(
      'J0B-axis-scope',
      changed.length === 0,
      'remeasuring selected axes does not rewrite pre-existing evidence on other axes',
      { preservedAxes, changed },
    ))
  } else {
    const evidencePreserved = stableValue(before?.measured) === stableValue(after?.measured)
    cases.push(surfaceCase(
      'J0B-failure-preserves-evidence',
      evidencePreserved,
      'a failed real Benchmark leaves previously persisted capability evidence unchanged',
      { preserved: evidencePreserved },
    ))
  }

  return { ok: cases.every((entry) => entry.status === 'pass'), cases }
}

function candidateList(snapshot) {
  return (Array.isArray(snapshot?.candidates) ? snapshot.candidates : []).map((candidate) => ({
    key: candidate.key,
    provider: candidate.provider,
    model: candidate.model,
    local: candidate.local === true,
    cloudCostWarning: candidate.cloudCostWarning === true,
    benchmarkable: candidate.benchmarkable === true,
    imageCapability: candidate.imageCapability,
    fingerprint: candidate.fingerprint,
    measuredAxes: candidate.measured?.measuredAxes ?? [],
  }))
}

function summarize(report) {
  const rows = []
  const append = (section, cases = []) => {
    if (!Array.isArray(cases) || cases.length === 0) return
    rows.push(section)
    for (const entry of cases) rows.push(`  ${entry.status === 'pass' ? 'PASS' : entry.status === 'skip' ? 'SKIP' : 'FAIL'}  ${entry.id}  ${entry.summary}`)
  }
  append('Authority / runtime', report.safe?.cases)
  append('Live HTTP surfaces (before provider)', report.surfaces?.cases)
  append('Authorized real provider', report.provider?.cases)
  append('J0b provider evidence', report.providerEvidence?.cases)
  append('Live HTTP surfaces (after provider)', report.surfacesAfterProvider?.cases)
  rows.push(`Result: ${report.ok ? 'PASS' : 'FAIL'}`)
  return rows.join('\n')
}

export async function runAcceptanceCli(argv = process.argv.slice(2), io = console) {
  let options
  try { options = parseAcceptanceArgs(argv) }
  catch (error) {
    io.error(`dsh-vision-router-acceptance: ${error instanceof Error ? error.message : String(error)}`)
    io.error(usage().trimEnd())
    return 2
  }
  if (options.help) {
    io.log(usage().trimEnd())
    return 0
  }

  if (options.listCandidates) {
    const response = await requestJson(options.runtimeUrl, CAPABILITY_BENCHMARK_PATH)
    const report = {
      ok: response.ok && response.body?.ok === true,
      runtimeUrl: options.runtimeUrl,
      suiteRevision: response.body?.suiteRevision ?? null,
      candidates: response.ok ? candidateList(response.body) : [],
      ...(response.ok ? {} : { error: response.body?.error ?? `HTTP ${response.status}` }),
    }
    if (options.json) io.log(JSON.stringify(report, null, 2))
    else if (!report.ok) io.error(`Candidate discovery failed: ${report.error}`)
    else {
      io.log(`Vision Router Benchmark candidates (suite v${report.suiteRevision ?? '?'})`)
      for (const candidate of report.candidates) {
        io.log(`${candidate.key}  ${candidate.local ? 'local' : candidate.cloudCostWarning ? 'cloud-chargeable' : 'cloud/free-or-unknown'}  ${candidate.benchmarkable ? 'benchmarkable' : 'not-benchmarkable'}  measured=[${candidate.measuredAxes.join(',')}]`)
      }
    }
    return report.ok ? 0 : 1
  }

  const wantsSafe = options.acceptedSafeMutations === true
  const wantsProvider = typeof options.provider === 'string' && options.provider.trim() !== ''
  if (!wantsSafe && !wantsProvider) {
    io.error('dsh-vision-router-acceptance: choose --accept-safe-mutations, --provider ... --allow-provider-requests, or --list-candidates')
    io.error(usage().trimEnd())
    return 2
  }

  if (!options.json) {
    io.log('Vision Router v2 real-machine acceptance')
    io.log(`Runtime: ${options.runtimeUrl}`)
    if (wantsSafe) io.log('J0a safe phase: temporarily toggles routingMode/backgroundBenchmarking, restores exact user-layer values, and makes zero provider requests.')
    if (wantsProvider) {
      io.log(`J0b provider phase: explicitly authorized exact Benchmark for ${options.provider} (${options.mode}).`)
      if (options.acceptedChargeableCloud) io.log('Chargeable-cloud permission: explicitly granted for this run.')
    }
  }

  let safe
  if (wantsSafe) {
    const safeResponse = await requestJson(options.runtimeUrl, V2_ACCEPTANCE_PATH, {
      method: 'POST',
      body: JSON.stringify({ action: 'safe', acceptedSafeMutations: true }),
    })
    safe = safeResponse.body
    if (!safeResponse.ok) {
      const report = {
        ok: false,
        runtimeUrl: options.runtimeUrl,
        safe,
        surfaces: { ok: false, cases: [] },
      }
      if (options.json) io.log(JSON.stringify(report, null, 2))
      else io.error(`Safe acceptance failed: ${safe?.code ?? safeResponse.status} — ${safe?.error ?? 'unknown error'}`)
      return 1
    }
  }

  const surfaces = await inspectLivePublicSurfaces(options.runtimeUrl)
  let provider
  let providerEvidence
  let surfacesAfterProvider
  if (wantsProvider) {
    const beforeResponse = await requestJson(options.runtimeUrl, CAPABILITY_BENCHMARK_PATH)
    const providerStartedAt = Date.now()
    const response = await requestJson(options.runtimeUrl, V2_ACCEPTANCE_PATH, {
      method: 'POST',
      body: JSON.stringify({
        action: 'provider',
        key: options.provider,
        mode: options.mode,
        force: options.force,
        acceptedProviderRequests: true,
        acceptedChargeableCloud: options.acceptedChargeableCloud,
      }),
    })
    provider = response.body
    if (!response.ok && provider?.ok !== false) provider = { ok: false, code: `HTTP_${response.status}`, error: 'provider acceptance request failed' }
    const afterResponse = await requestJson(options.runtimeUrl, CAPABILITY_BENCHMARK_PATH)
    if (beforeResponse.ok && afterResponse.ok) {
      providerEvidence = inspectProviderEvidence({
        beforeSnapshot: beforeResponse.body,
        afterSnapshot: afterResponse.body,
        providerReport: provider,
        key: options.provider,
        mode: options.mode,
        startedAt: providerStartedAt,
      })
    } else {
      providerEvidence = {
        ok: false,
        cases: [surfaceCase(
          'J0B-snapshot',
          false,
          'J0b requires readable Benchmark snapshots immediately before and after the real provider run',
          { beforeStatus: beforeResponse.status, afterStatus: afterResponse.status },
        )],
      }
    }
    surfacesAfterProvider = await inspectLivePublicSurfaces(options.runtimeUrl)
  }

  const report = {
    ok: (!safe || safe.ok === true)
      && surfaces.ok
      && (!provider || provider.ok === true)
      && (!providerEvidence || providerEvidence.ok === true)
      && (!surfacesAfterProvider || surfacesAfterProvider.ok === true),
    runtimeUrl: options.runtimeUrl,
    generatedAt: Date.now(),
    ...(safe ? { safe } : {}),
    surfaces,
    ...(provider ? { provider } : {}),
    ...(providerEvidence ? { providerEvidence } : {}),
    ...(surfacesAfterProvider ? { surfacesAfterProvider } : {}),
  }
  if (options.json) io.log(JSON.stringify(report, null, 2))
  else io.log(summarize(report))
  return report.ok ? 0 : 1
}

export function isCliEntry(entry, moduleUrl = import.meta.url) {
  if (typeof entry !== 'string' || entry.trim() === '') return false
  const real = (value) => {
    try { return realpathSync(value.startsWith('file:') ? fileURLToPath(value) : value) } catch { return value }
  }
  return real(entry) === real(moduleUrl)
}

if (isCliEntry(process.argv[1])) {
  runAcceptanceCli().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`dsh-vision-router-acceptance: crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
  })
}

#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { V2_ACCEPTANCE_PATH } from './v2-acceptance-service.js'
import { CAPABILITY_BENCHMARK_PATH } from './vision-capability-benchmark-service.js'
import { VISION_ROUTING_PREVIEW_PATH } from './vision-routing-preview-service.js'

const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:3080'
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

function usage() {
  return `dsh-vision-router-acceptance --accept-safe-mutations [options]\n\nRuns v2 real-machine acceptance inside the currently running local DSH process.\nThe safe phase temporarily changes only routingMode/backgroundBenchmarking and restores the exact user-layer values before returning. It registers a process-local probe adapter and makes zero provider/API requests.\n\nRequired:\n  --accept-safe-mutations        Explicitly authorize temporary safe settings mutations.\n\nOptions:\n  --runtime-url <url>            Running local DSH Web URL (default: DSH_WEB_URL or ${DEFAULT_RUNTIME_URL}).\n  --provider <backend-key>       Also run an exact real-provider Benchmark acceptance on this candidate.\n  --mode <quick|full|grounding>  Provider Benchmark mode (default: quick).\n  --allow-provider-requests      Explicitly authorize real provider requests for --provider.\n  --allow-chargeable-cloud       Additionally authorize a selected backend that may incur API charges.\n  --force                        Force provider verification when DSH metadata declares the model text-only.\n  --json                         Emit the full machine-readable report.\n  --help                         Show this help.\n\nExamples:\n  dsh-vision-router-acceptance --accept-safe-mutations\n  dsh-vision-router-acceptance --accept-safe-mutations --provider vision-http/local-ollama/qwen2.5vl --allow-provider-requests\n  dsh-vision-router-acceptance --accept-safe-mutations --provider http:cloud/model --allow-provider-requests --allow-chargeable-cloud\n`
}

export function parseAcceptanceArgs(argv = []) {
  const options = {
    runtimeUrl: process.env.DSH_WEB_URL || DEFAULT_RUNTIME_URL,
    acceptedSafeMutations: false,
    acceptedProviderRequests: false,
    acceptedChargeableCloud: false,
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

function summarize(report) {
  const rows = []
  const append = (section, cases = []) => {
    rows.push(section)
    for (const entry of cases) rows.push(`  ${entry.status === 'pass' ? 'PASS' : entry.status === 'skip' ? 'SKIP' : 'FAIL'}  ${entry.id}  ${entry.summary}`)
  }
  append('Authority / runtime', report.safe?.cases)
  append('Live HTTP surfaces', report.surfaces?.cases)
  if (report.provider) append('Authorized real provider', report.provider.cases)
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
  if (options.acceptedSafeMutations !== true) {
    io.error('dsh-vision-router-acceptance: safe acceptance is opt-in; rerun with --accept-safe-mutations after reviewing --help')
    return 2
  }

  if (!options.json) {
    io.log('Vision Router v2 real-machine acceptance')
    io.log(`Runtime: ${options.runtimeUrl}`)
    io.log('Safe phase: temporarily toggles routingMode/backgroundBenchmarking, restores the exact user-layer values, and makes zero provider requests.')
    if (options.provider) {
      io.log(`Provider phase: explicitly authorized exact Benchmark for ${options.provider} (${options.mode}).`)
      if (options.acceptedChargeableCloud) io.log('Chargeable-cloud permission: explicitly granted for this run.')
    }
  }

  const safeResponse = await requestJson(options.runtimeUrl, V2_ACCEPTANCE_PATH, {
    method: 'POST',
    body: JSON.stringify({ action: 'safe', acceptedSafeMutations: true }),
  })
  if (!safeResponse.ok) {
    const report = {
      ok: false,
      runtimeUrl: options.runtimeUrl,
      safe: safeResponse.body,
      surfaces: { ok: false, cases: [] },
    }
    if (options.json) io.log(JSON.stringify(report, null, 2))
    else io.error(`Safe acceptance failed: ${safeResponse.body?.code ?? safeResponse.status} — ${safeResponse.body?.error ?? 'unknown error'}`)
    return 1
  }

  const surfaces = await inspectLivePublicSurfaces(options.runtimeUrl)
  let provider
  if (options.provider) {
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
  }

  const report = {
    ok: safeResponse.body?.ok === true && surfaces.ok && (!provider || provider.ok === true),
    runtimeUrl: options.runtimeUrl,
    generatedAt: Date.now(),
    safe: safeResponse.body,
    surfaces,
    ...(provider ? { provider } : {}),
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

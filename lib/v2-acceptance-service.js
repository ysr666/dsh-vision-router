import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isLocalUiRequest } from './web-capability-boundary.js'
import {
  grantManualMeasurementFromUserAction,
  resolveVisionRoutingAuthority,
} from './vision-routing-authority.js'
import { withVisionRuntimePerformanceScope } from './vision-runtime-performance.js'
import { redactDiagnosticText } from './diagnostic-redaction.js'

export const V2_ACCEPTANCE_PATH = '/_dsh/vision-router/v2-acceptance'
export const V2_ACCEPTANCE_SCHEMA_VERSION = 2

const SETTINGS_NS = 'vision-router'
const REQUEST_MAX_BYTES = 32 * 1024
const DEFAULT_IDLE_WAIT_MS = 3_000
const DEFAULT_PROBE_WAIT_MS = 5_000
const REAL_EXECUTION_TIMEOUT_MS = 180_000
const REAL_EXECUTION_PLAN_WAIT_MS = 15_000
const REAL_EXECUTION_FIXTURE = fileURLToPath(new URL('../assets/vision-settings.png', import.meta.url))
const LOW_GROUNDING_BACKEND = 'opencode-go/minimax-m3'
const HIGH_GROUNDING_BACKEND = 'zhipu-glm/glm-4.6v'

function bounded(value, max = 320) {
  return redactDiagnosticText(value?.message ?? value, max)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, maxBytes = REQUEST_MAX_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maxBytes) {
      const error = new Error('acceptance request body too large')
      error.code = 'V2_ACCEPTANCE_BODY_TOO_LARGE'
      throw error
    }
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return plainObject(parsed) ? parsed : {}
  } catch {
    const error = new Error('invalid acceptance JSON body')
    error.code = 'V2_ACCEPTANCE_INVALID_JSON'
    throw error
  }
}

function namespaceDescriptor(settings) {
  const rows = settings?.describe?.({ redactSecrets: true })
  if (!Array.isArray(rows)) return undefined
  return rows.find((entry) => entry?.ns === SETTINGS_NS)
}

function liveSettings(settings) {
  const value = settings?.get?.(SETTINGS_NS)
  return plainObject(value) ? value : undefined
}

function fieldState(descriptor, field) {
  const user = plainObject(descriptor?.user) ? descriptor.user : {}
  const value = plainObject(descriptor?.value) ? descriptor.value : {}
  return {
    field,
    userPresent: Object.prototype.hasOwnProperty.call(user, field),
    userValue: clone(user[field]),
    resolvedValue: clone(value[field]),
  }
}

async function mutateField(settings, field, operation, value) {
  const descriptor = namespaceDescriptor(settings)
  if (!descriptor || !Number.isInteger(descriptor.revision) || descriptor.revision < 0) {
    const error = new Error('Vision Router settings revision is unavailable')
    error.code = 'V2_ACCEPTANCE_SETTINGS_UNAVAILABLE'
    throw error
  }
  if (settings.writable !== true) {
    const error = new Error('Vision Router settings provider is read-only')
    error.code = 'V2_ACCEPTANCE_SETTINGS_READ_ONLY'
    throw error
  }
  const op = operation === 'unset'
    ? { op: 'unset', path: [field] }
    : { op: 'set', path: [field], value: clone(value) }
  await settings.mutate(SETTINGS_NS, [op], descriptor.revision)
}

async function restoreField(settings, snapshot) {
  if (snapshot.userPresent) await mutateField(settings, snapshot.field, 'set', snapshot.userValue)
  else await mutateField(settings, snapshot.field, 'unset')
}

async function waitUntil(predicate, timeoutMs = DEFAULT_IDLE_WAIT_MS, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

function caseResult(id, pass, summary, details = {}) {
  return {
    id,
    status: pass ? 'pass' : 'fail',
    summary,
    ...Object.keys(details).length > 0 ? { details } : {},
  }
}

function skipCase(id, summary, details = {}) {
  return {
    id,
    status: 'skip',
    summary,
    ...Object.keys(details).length > 0 ? { details } : {},
  }
}

function reportOk(cases) {
  return cases.every((entry) => entry.status !== 'fail')
}

function sampleState(store, backendKey) {
  try {
    const record = store?.get?.(backendKey)
    if (!record) return { count: 0, eligible: false }
    const count = Number(record.sampleCountByAxis?.ocr) || 0
    return {
      count,
      eligible: Number.isFinite(Number(record.runtimeLatencyMsByAxis?.ocr)),
      observed: Number.isFinite(Number(record.observedLatencyMsByAxis?.ocr)),
    }
  } catch {
    return { count: 0, eligible: false }
  }
}

function createEphemeralRuntimeProbe(runtimeCtx, runtimePerformanceStore) {
  const suffix = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const provider = `vision-router-acceptance-${suffix}`
  const model = 'authority-probe'
  const backendKey = `${provider}/${model}`
  let holdNext = false
  let enteredResolve
  let releaseResolve
  let releasePromise

  const armHold = () => {
    holdNext = true
    releasePromise = new Promise((resolve) => { releaseResolve = resolve })
    return new Promise((resolve) => { enteredResolve = resolve })
  }

  const probeModel = (p = provider, m = model) => ({
    provider: p,
    id: m,
    name: 'Vision Router acceptance probe',
    inputModalities: ['text', 'image'],
  })

  // The probe is intentionally process-local, but registration still traverses
  // the released DSH adapter registry. Implement the complete adapter contract
  // instead of relying on the permissive unit-test fake: real hosts synchronously
  // read providerInfo() during registerAdapter().
  const adapter = {
    providerInfo(p) {
      return { id: p, name: 'Vision Router acceptance probe' }
    },
    providerRetryPolicy() {
      return undefined
    },
    async listModels(p) {
      return p === provider ? [probeModel()] : []
    },
    async resolveModel(p, m) {
      return probeModel(p, m)
    },
    async *stream() {
      yield { text: 'acceptance-probe' }
      if (holdNext) {
        holdNext = false
        enteredResolve?.()
        enteredResolve = undefined
        await releasePromise
        releasePromise = undefined
        releaseResolve = undefined
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const register = runtimeCtx?.llm?.registerAdapter
  if (typeof register !== 'function' || typeof runtimeCtx?.llm?.stream !== 'function') {
    const error = new Error('running DSH LLM adapter registry is unavailable')
    error.code = 'V2_ACCEPTANCE_LLM_UNAVAILABLE'
    throw error
  }
  const dispose = register.call(runtimeCtx.llm, [provider], adapter)

  const run = async () => withVisionRuntimePerformanceScope('vision_ocr', {}, async () => {
    const stream = runtimeCtx.llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: 'Vision Router v2 acceptance probe' }],
      maxTokens: 16,
    })
    for await (const _chunk of stream) {
      // Consume the real DSH stream wrapper. The adapter itself is process-local.
    }
  })

  return {
    provider,
    model,
    backendKey,
    run,
    armHold,
    release() { releaseResolve?.() },
    clear() { runtimePerformanceStore?.clear?.(backendKey) },
    dispose() {
      try { runtimePerformanceStore?.clear?.(backendKey) } catch {}
      try { if (typeof dispose === 'function') dispose() } catch {}
    },
  }
}

async function assertManualBoundary(benchmarkManager) {
  if (!benchmarkManager || typeof benchmarkManager.run !== 'function') return false
  try {
    await benchmarkManager.run('__v2_acceptance_no_authority__', ['ocr'])
    return false
  } catch (error) {
    return error?.code === 'CAPABILITY_BENCHMARK_AUTHORITY_REQUIRED'
  }
}

export async function runV2SafeAcceptance({
  runtimeCtx,
  runtimePerformanceStore,
  backgroundProfiler,
  benchmarkManager,
  acceptedSafeMutations,
  logger,
  createRuntimeProbe = createEphemeralRuntimeProbe,
} = {}) {
  if (acceptedSafeMutations !== true) {
    const error = new Error('explicit --accept-safe-mutations consent is required')
    error.code = 'V2_ACCEPTANCE_CONSENT_REQUIRED'
    throw error
  }
  const settings = runtimeCtx?.get?.('settings')
  if (!settings || typeof settings.get !== 'function' || typeof settings.mutate !== 'function') {
    const error = new Error('running DSH settings service is unavailable')
    error.code = 'V2_ACCEPTANCE_SETTINGS_UNAVAILABLE'
    throw error
  }

  const initialDescriptor = namespaceDescriptor(settings)
  if (!initialDescriptor) {
    const error = new Error('Vision Router settings namespace is unavailable')
    error.code = 'V2_ACCEPTANCE_SETTINGS_UNAVAILABLE'
    throw error
  }
  const routingSnapshot = fieldState(initialDescriptor, 'routingMode')
  const backgroundSnapshot = fieldState(initialDescriptor, 'backgroundBenchmarking')
  const profilerBefore = backgroundProfiler?.snapshot?.()
  if (profilerBefore?.running || Number(profilerBefore?.activeForeground) > 0 || Number(profilerBefore?.activeManualBenchmarks) > 0) {
    const error = new Error('Vision Router is busy; rerun acceptance when no visual/background/manual benchmark work is active')
    error.code = 'V2_ACCEPTANCE_BUSY'
    throw error
  }

  const cases = []
  let probe
  let restorationError
  try {
    // Exercise the actual Host default path: remove any user override instead of
    // merely setting "off". This proves absence itself fails closed.
    await mutateField(settings, 'backgroundBenchmarking', 'unset')
    await mutateField(settings, 'routingMode', 'auto', 'auto')
    const missingBackground = liveSettings(settings)
    const missingAuthority = resolveVisionRoutingAuthority(missingBackground)
    cases.push(caseResult(
      'A01',
      missingBackground?.backgroundBenchmarking === 'off' && missingAuthority.backgroundMeasurementAuthorized === false,
      'missing background authority resolves to off',
      { resolved: missingBackground?.backgroundBenchmarking ?? null },
    ))
    cases.push(caseResult(
      'A02',
      missingAuthority.autoSelectionAuthorized === true && missingAuthority.backgroundMeasurementActive === false,
      'Auto authority does not imply background measurement authority',
      {
        execution: missingAuthority.execution,
        backgroundMeasurement: missingAuthority.backgroundMeasurement,
      },
    ))

    const profilerBackoffBefore = Number(backgroundProfiler?.snapshot?.()?.backoffSize) || 0
    if (backgroundProfiler && typeof backgroundProfiler.tick === 'function') {
      await backgroundProfiler.tick()
      const idle = await waitUntil(() => !backgroundProfiler.snapshot?.().running, DEFAULT_IDLE_WAIT_MS)
      const after = backgroundProfiler.snapshot?.() ?? {}
      cases.push(caseResult(
        'A02-runtime',
        idle && !after.running && (Number(after.backoffSize) || 0) === profilerBackoffBefore,
        'live background profiler remains idle without measurement authority',
        { running: after.running ?? null, backoffSize: Number(after.backoffSize) || 0 },
      ))
    } else {
      cases.push(skipCase('A02-runtime', 'background profiler is not exposed by this runtime'))
    }

    const manualBoundary = await assertManualBoundary(benchmarkManager)
    cases.push(caseResult(
      'A09',
      manualBoundary,
      'programmatic Benchmark manager call is rejected without explicit manual authority',
    ))

    probe = createRuntimeProbe(runtimeCtx, runtimePerformanceStore)
    const backendKey = probe.backendKey

    await mutateField(settings, 'routingMode', 'set', 'ordered')
    probe.clear()
    await probe.run()
    const orderedState = sampleState(runtimePerformanceStore, backendKey)
    cases.push(caseResult(
      'A06',
      orderedState.count === 0,
      'Fixed order real stream creates no runtime routing sample',
      orderedState,
    ))

    await mutateField(settings, 'routingMode', 'set', 'auto')
    probe.clear()
    await probe.run()
    const firstAuto = sampleState(runtimePerformanceStore, backendKey)
    const minSamples = Number(runtimePerformanceStore?.minSamples) || 2
    const firstOk = firstAuto.count === 1 && (minSamples <= 1 ? firstAuto.eligible : !firstAuto.eligible)
    cases.push(caseResult(
      'A07-1',
      firstOk,
      'first Auto sample is observed but remains warming when the runtime requires multiple samples',
      { ...firstAuto, minSamples },
    ))
    await probe.run()
    const secondAuto = sampleState(runtimePerformanceStore, backendKey)
    cases.push(caseResult(
      'A07-2',
      secondAuto.count >= Math.min(2, minSamples) && (minSamples <= 2 ? secondAuto.eligible : true),
      'repeated Auto samples become eligible according to the live runtime threshold',
      { ...secondAuto, minSamples },
    ))

    probe.clear()
    await mutateField(settings, 'routingMode', 'set', 'auto')
    const entered = probe.armHold()
    const inFlight = probe.run()
    const reachedAdapter = await Promise.race([
      entered.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), DEFAULT_PROBE_WAIT_MS)),
    ])
    if (!reachedAdapter) {
      probe.release()
      await inFlight.catch(() => {})
      cases.push(caseResult('A08', false, 'in-flight revocation probe did not reach the registered adapter'))
    } else {
      await mutateField(settings, 'routingMode', 'set', 'ordered')
      probe.release()
      await inFlight
      const revokedState = sampleState(runtimePerformanceStore, backendKey)
      cases.push(caseResult(
        'A08',
        revokedState.count === 0,
        'revoking Auto while a real stream is in flight suppresses publication of its runtime sample',
        revokedState,
      ))
    }

    const finalAuthority = resolveVisionRoutingAuthority(liveSettings(settings) ?? {})
    cases.push(caseResult(
      'L00',
      finalAuthority.persistentLearning === false,
      'no current v2 setting grants persistent behavioral learning',
    ))
  } finally {
    try { probe?.release?.() } catch {}
    try { probe?.dispose?.() } catch {}
    try {
      // Keep background disabled while restoring execution authority, then
      // restore the exact user-layer shape (set vs absent) for both fields.
      await mutateField(settings, 'backgroundBenchmarking', 'set', 'off')
      await restoreField(settings, routingSnapshot)
      await restoreField(settings, backgroundSnapshot)
    } catch (error) {
      restorationError = error
      logger?.error?.('vision-router: v2 acceptance settings restore failed: %s', bounded(error))
    }
  }

  const restored = namespaceDescriptor(settings)
  const routingRestored = fieldState(restored, 'routingMode')
  const backgroundRestored = fieldState(restored, 'backgroundBenchmarking')
  const restorationMatches = !restorationError
    && routingRestored.userPresent === routingSnapshot.userPresent
    && backgroundRestored.userPresent === backgroundSnapshot.userPresent
    && JSON.stringify(routingRestored.userValue) === JSON.stringify(routingSnapshot.userValue)
    && JSON.stringify(backgroundRestored.userValue) === JSON.stringify(backgroundSnapshot.userValue)
  cases.push(caseResult(
    'R00',
    restorationMatches,
    'acceptance restores the exact original user-layer authority settings',
    restorationError ? { error: bounded(restorationError) } : {},
  ))

  return {
    ok: reportOk(cases),
    schemaVersion: V2_ACCEPTANCE_SCHEMA_VERSION,
    kind: 'safe-authority',
    generatedAt: Date.now(),
    providerRequestsAuthorized: false,
    providerRequestsMade: 0,
    cases,
  }
}

function providerRowKey(row) {
  const provider = typeof row?.provider === 'string' ? row.provider.trim() : ''
  const model = typeof row?.model === 'string' ? row.model.trim() : ''
  return provider && model ? `${provider}/${model}` : undefined
}

function realExecutionProviderOrder(config) {
  const rows = Array.isArray(config?.providers) ? config.providers.map(clone) : []
  const lowIndex = rows.findIndex((row) => providerRowKey(row) === LOW_GROUNDING_BACKEND)
  const highIndex = rows.findIndex((row) => providerRowKey(row) === HIGH_GROUNDING_BACKEND)
  if (lowIndex < 0 || highIndex < 0) {
    const error = new Error('real execution acceptance requires the measured MiniMax and GLM routes in the configured provider list')
    error.code = 'V2_ACCEPTANCE_REAL_BACKENDS_UNAVAILABLE'
    throw error
  }
  return [rows[lowIndex], rows[highIndex], ...rows.filter((_, index) => index !== lowIndex && index !== highIndex)]
}

function eventOf(events, kind) {
  return events.find((event) => event?.kind === kind)
}

function firstProviderAttempt(events) {
  return events.find((event) => event?.kind === 'adapter-attempt' || event?.kind === 'preflight-bridge-attempt')
}

function terminalProviderEvent(events, backend) {
  return events.find((event) =>
    event?.backend === backend
    && ['adapter-success', 'adapter-failed', 'bridge-success', 'bridge-failed', 'preflight-bridge-success', 'preflight-bridge-failed'].includes(event?.kind))
}

function providerCandidate(snapshot, key) {
  return snapshot?.candidates?.find?.((candidate) => candidate?.key === key)
}

async function executeGroundingTool(tools, capture) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REAL_EXECUTION_TIMEOUT_MS)
  try {
    return await capture.run(() => tools.execute({
      callId: `v2-acceptance-${randomUUID()}`,
      name: 'vision_ground',
      arguments: {
        image: REAL_EXECUTION_FIXTURE,
        target: 'the X close button at the top-right of the white settings dialog',
        annotate: false,
      },
      signal: controller.signal,
    }))
  } finally {
    clearTimeout(timer)
  }
}

function toolOutcome(result) {
  return result?.isError === true ? 'error' : 'success'
}

export async function runV2RealExecutionAcceptance({
  runtimeCtx,
  executionObserver,
  backgroundProfiler,
  benchmarkManager,
  acceptedProviderRequests,
  acceptedChargeableCloud,
  logger,
} = {}) {
  if (acceptedProviderRequests !== true || acceptedChargeableCloud !== true) {
    const error = new Error('real execution acceptance requires explicit provider-request and chargeable-cloud consent')
    error.code = 'V2_ACCEPTANCE_PROVIDER_CONSENT_REQUIRED'
    throw error
  }
  const settings = runtimeCtx?.get?.('settings')
  const tools = runtimeCtx?.tools
  if (!settings || typeof settings.get !== 'function' || typeof settings.mutate !== 'function') {
    const error = new Error('running DSH settings service is unavailable')
    error.code = 'V2_ACCEPTANCE_SETTINGS_UNAVAILABLE'
    throw error
  }
  if (!tools || typeof tools.execute !== 'function' || !executionObserver || typeof executionObserver.createCapture !== 'function') {
    const error = new Error('running DSH visual-tool acceptance seam is unavailable')
    error.code = 'V2_ACCEPTANCE_EXECUTION_UNAVAILABLE'
    throw error
  }
  const profilerBefore = backgroundProfiler?.snapshot?.()
  if (profilerBefore?.running || Number(profilerBefore?.activeForeground) > 0 || Number(profilerBefore?.activeManualBenchmarks) > 0) {
    const error = new Error('Vision Router is busy; rerun real execution acceptance when no visual/background/manual benchmark work is active')
    error.code = 'V2_ACCEPTANCE_BUSY'
    throw error
  }

  const descriptor = namespaceDescriptor(settings)
  if (!descriptor) {
    const error = new Error('Vision Router settings namespace is unavailable')
    error.code = 'V2_ACCEPTANCE_SETTINGS_UNAVAILABLE'
    throw error
  }
  const snapshots = ['routingMode', 'routingPreference', 'providers', 'backgroundBenchmarking']
    .map((field) => fieldState(descriptor, field))
  const initial = liveSettings(settings)
  const testProviders = realExecutionProviderOrder(initial)
  const cases = []
  let reorderResult
  let reorderEvents = []
  let revokedResult
  let revokedEvents = []
  let beforeBenchmark
  let afterBenchmark
  let restorationError

  try {
    if (benchmarkManager?.snapshot) beforeBenchmark = await benchmarkManager.snapshot()
    // Remove all unrelated measurement activity and remove Auto authority while
    // constructing the temporary provider order. No configured route is deleted.
    await mutateField(settings, 'backgroundBenchmarking', 'set', 'off')
    await mutateField(settings, 'routingMode', 'set', 'ordered')
    await mutateField(settings, 'routingPreference', 'set', 'quality')
    await mutateField(settings, 'providers', 'set', testProviders)
    await mutateField(settings, 'routingMode', 'set', 'auto')

    const reorderCapture = executionObserver.createCapture()
    reorderResult = await executeGroundingTool(tools, reorderCapture)
    reorderEvents = reorderCapture.events()

    const revokedCapture = executionObserver.createCapture({ pauseBeforeLiveCheck: true })
    const revokedRunning = executeGroundingTool(tools, revokedCapture)
    // Attach a rejection observer immediately: if the tool fails before it
    // reaches the plan boundary, the bounded wait below must not create a
    // transient unhandled rejection. The later await still propagates it.
    void revokedRunning.catch(() => {})
    let planTimer
    const reachedPlan = await Promise.race([
      revokedCapture.entered.then(() => true),
      new Promise((resolve) => { planTimer = setTimeout(() => resolve(false), REAL_EXECUTION_PLAN_WAIT_MS) }),
    ])
    clearTimeout(planTimer)
    try {
      if (reachedPlan) await mutateField(settings, 'routingMode', 'set', 'ordered')
    } finally {
      revokedCapture.release()
    }
    revokedResult = await revokedRunning
    revokedEvents = revokedCapture.events()
    if (!reachedPlan) revokedEvents.push({ kind: 'acceptance-plan-timeout' })
    if (benchmarkManager?.snapshot) afterBenchmark = await benchmarkManager.snapshot()
  } finally {
    try {
      await mutateField(settings, 'backgroundBenchmarking', 'set', 'off')
      await mutateField(settings, 'routingMode', 'set', 'ordered')
      for (const snapshot of snapshots.filter((entry) => entry.field !== 'routingMode' && entry.field !== 'backgroundBenchmarking')) {
        await restoreField(settings, snapshot)
      }
      await restoreField(settings, snapshots.find((entry) => entry.field === 'routingMode'))
      await restoreField(settings, snapshots.find((entry) => entry.field === 'backgroundBenchmarking'))
    } catch (error) {
      restorationError = error
      logger?.error?.('vision-router: real execution acceptance settings restore failed: %s', bounded(error))
    }
  }

  const reorderPlan = eventOf(reorderEvents, 'auto-plan')
  const reorderScope = eventOf(reorderEvents, 'auto-scope')
  const reorderAttempt = firstProviderAttempt(reorderEvents)
  const reorderTerminal = terminalProviderEvent(reorderEvents, HIGH_GROUNDING_BACKEND)
  const decision = reorderPlan?.decision
  const reorderPass = reorderPlan?.configuredOrder?.[0] === LOW_GROUNDING_BACKEND
    && reorderPlan?.plannedOrder?.[0] === HIGH_GROUNDING_BACKEND
    && reorderPlan?.changed === true
    && reorderScope?.selectedOrder?.[0] === HIGH_GROUNDING_BACKEND
    && reorderAttempt?.backend === HIGH_GROUNDING_BACKEND
    && reorderTerminal?.outcome === 'success'
    && reorderResult?.isError !== true
  cases.push(caseResult(
    'E02-real-auto-reorder',
    reorderPass,
    'real measured Grounding evidence changes Auto first and the real visual tool attempts that backend first',
    {
      configuredOrder: reorderPlan?.configuredOrder ?? [],
      plannedOrder: reorderPlan?.plannedOrder ?? [],
      changed: reorderPlan?.changed ?? false,
      reason: decision?.reason ?? null,
      axis: reorderPlan?.axis ?? null,
      decision: decision ?? null,
      actualFirstAttempt: reorderAttempt?.backend ?? null,
      providerOutcome: reorderTerminal?.outcome ?? null,
      toolOutcome: toolOutcome(reorderResult),
    },
  ))

  const adapterAttempt = eventOf(reorderEvents, 'adapter-attempt')
  const adapterFailure = eventOf(reorderEvents, 'adapter-failed')
  const bridgeAttempt = eventOf(reorderEvents, 'bridge-attempt')
  const bridgeSuccess = eventOf(reorderEvents, 'bridge-success')
  const preflightAttempt = eventOf(reorderEvents, 'preflight-bridge-attempt')
  const preflightSuccess = eventOf(reorderEvents, 'preflight-bridge-success')
  const wireCompat = eventOf(reorderEvents, 'bridge-wire-compat')
  const adapterBridgePath = adapterAttempt?.backend === HIGH_GROUNDING_BACKEND
    && adapterFailure?.backend === HIGH_GROUNDING_BACKEND
    && adapterFailure?.bridge === 'allow'
    && bridgeAttempt?.backend === HIGH_GROUNDING_BACKEND
    && bridgeSuccess?.backend === HIGH_GROUNDING_BACKEND
  const advisoryPreflightPath = preflightAttempt?.backend === HIGH_GROUNDING_BACKEND
    && preflightSuccess?.backend === HIGH_GROUNDING_BACKEND
  cases.push(caseResult(
    'E04-scoped-fallback-transport',
    reorderScope?.selectedOrder?.[0] === HIGH_GROUNDING_BACKEND
      && (adapterBridgePath || advisoryPreflightPath)
      && wireCompat?.backend === HIGH_GROUNDING_BACKEND
      && wireCompat?.maxTokensField === 'max_completion_tokens',
    'the Auto-selected backend identity is preserved through its authorized direct-HTTP compatibility transport',
    {
      selectedFirst: reorderScope?.selectedOrder?.[0] ?? null,
      path: adapterBridgePath ? 'adapter-rejection-to-direct-bridge' : advisoryPreflightPath ? 'host-advisory-preflight-direct-bridge' : 'missing',
      adapterFailureCode: adapterFailure?.code ?? null,
      bridgeBackend: (bridgeAttempt ?? preflightAttempt)?.backend ?? null,
      bridgeOutcome: (bridgeSuccess ?? preflightSuccess)?.outcome ?? null,
      maxTokensField: wireCompat?.maxTokensField ?? null,
    },
  ))

  const revokedPlan = eventOf(revokedEvents, 'auto-plan')
  const revokedSkip = eventOf(revokedEvents, 'auto-skipped')
  const revokedAttempt = firstProviderAttempt(revokedEvents)
  const revokedTerminal = terminalProviderEvent(revokedEvents, LOW_GROUNDING_BACKEND)
  cases.push(caseResult(
    'E03-last-moment-revocation',
    revokedPlan?.plannedOrder?.[0] === HIGH_GROUNDING_BACKEND
      && revokedSkip?.reason === 'authority-revoked'
      && revokedAttempt?.backend === LOW_GROUNDING_BACKEND
      && revokedTerminal !== undefined,
    'revoking live Auto authority after planning discards the stale plan and executes current configured v1 order',
    {
      plannedFirst: revokedPlan?.plannedOrder?.[0] ?? null,
      revokedReason: revokedSkip?.reason ?? null,
      liveConfiguredFirst: LOW_GROUNDING_BACKEND,
      actualFirstAttempt: revokedAttempt?.backend ?? null,
      providerOutcome: revokedTerminal?.outcome ?? null,
      toolOutcome: toolOutcome(revokedResult),
    },
  ))

  const beforeHigh = providerCandidate(beforeBenchmark, HIGH_GROUNDING_BACKEND)
  const afterHigh = providerCandidate(afterBenchmark, HIGH_GROUNDING_BACKEND)
  cases.push(caseResult(
    'E05-provider-identity-stable',
    Boolean(beforeHigh?.fingerprint && beforeHigh.fingerprint === afterHigh?.fingerprint),
    'real execution leaves the selected provider capability identity/fingerprint unchanged',
    { backend: HIGH_GROUNDING_BACKEND, fingerprint: afterHigh?.fingerprint ?? beforeHigh?.fingerprint ?? null },
  ))

  const restoredDescriptor = namespaceDescriptor(settings)
  const restored = snapshots.map((snapshot) => fieldState(restoredDescriptor, snapshot.field))
  const restorationMatches = !restorationError && snapshots.every((snapshot, index) =>
    restored[index]?.userPresent === snapshot.userPresent
    && JSON.stringify(restored[index]?.userValue) === JSON.stringify(snapshot.userValue))
  cases.push(caseResult(
    'R00-real-execution-settings-restore',
    restorationMatches,
    'real execution acceptance restores the exact original user-layer routing and background settings',
    restorationError ? { error: bounded(restorationError) } : {},
  ))

  return {
    ok: reportOk(cases),
    schemaVersion: V2_ACCEPTANCE_SCHEMA_VERSION,
    kind: 'real-execution',
    generatedAt: Date.now(),
    providerRequestsAuthorized: true,
    providerRequestsMaximum: 2,
    cases,
    traces: {
      reorder: reorderEvents,
      revocation: revokedEvents,
    },
  }
}

function axisCounts(record) {
  const source = record?.sampleCountByAxis
  if (!plainObject(source)) return {}
  return Object.fromEntries(
    Object.entries(source)
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([axis, value]) => [axis, Number(value)]),
  )
}

export async function runV2ProviderAcceptance({
  benchmarkManager,
  runtimePerformanceStore,
  key,
  mode = 'quick',
  force = false,
  acceptedProviderRequests,
  acceptedChargeableCloud,
} = {}) {
  if (acceptedProviderRequests !== true) {
    const error = new Error('explicit --allow-provider-requests consent is required')
    error.code = 'V2_ACCEPTANCE_PROVIDER_CONSENT_REQUIRED'
    throw error
  }
  if (!benchmarkManager || typeof benchmarkManager.snapshot !== 'function') {
    const error = new Error('running Benchmark manager is unavailable')
    error.code = 'V2_ACCEPTANCE_BENCHMARK_UNAVAILABLE'
    throw error
  }
  const wanted = typeof key === 'string' ? key.trim() : ''
  if (wanted === '') {
    const error = new Error('provider acceptance requires an exact backend key')
    error.code = 'V2_ACCEPTANCE_BACKEND_REQUIRED'
    throw error
  }
  const beforeSnapshot = await benchmarkManager.snapshot()
  const candidate = beforeSnapshot.candidates?.find((entry) => entry.key === wanted)
  if (!candidate) {
    const error = new Error('backend is not in the current Vision Router candidate pool')
    error.code = 'V2_ACCEPTANCE_BACKEND_UNKNOWN'
    throw error
  }
  if (candidate.cloudCostWarning === true && acceptedChargeableCloud !== true) {
    const error = new Error('selected backend may incur cloud/API charges; explicit --allow-chargeable-cloud consent is required')
    error.code = 'V2_ACCEPTANCE_CHARGEABLE_CONSENT_REQUIRED'
    throw error
  }
  const active = beforeSnapshot.jobs?.find((job) =>
    job.key === wanted && (job.state === 'queued' || job.state === 'running'))
  if (active) {
    const error = new Error('selected backend already has an active Benchmark job')
    error.code = 'V2_ACCEPTANCE_BUSY'
    throw error
  }

  const backendKey = `${candidate.provider}/${candidate.model}`
  const beforeRuntime = axisCounts(runtimePerformanceStore?.get?.(backendKey))
  const authority = grantManualMeasurementFromUserAction('local-ui')
  const queued = await benchmarkManager.enqueue(wanted, mode, force === true, authority)
  if (queued.duplicate === true) {
    const error = new Error('provider acceptance unexpectedly joined an existing Benchmark job')
    error.code = 'V2_ACCEPTANCE_BUSY'
    throw error
  }
  await benchmarkManager.waitForIdle()
  const afterSnapshot = await benchmarkManager.snapshot()
  const job = afterSnapshot.jobs?.find((entry) => entry.id === queued.job?.id)
  const afterRuntime = axisCounts(runtimePerformanceStore?.get?.(backendKey))
  const runtimeUnchanged = JSON.stringify(afterRuntime) === JSON.stringify(beforeRuntime)
  const cases = [
    caseResult(
      'B-live',
      job?.state === 'completed',
      'explicitly authorized exact Benchmark completes on the selected real backend',
      {
        key: wanted,
        mode,
        state: job?.state ?? 'missing',
        errorClass: job?.errorClass ?? null,
        errorCode: job?.errorCode ?? null,
      },
    ),
    caseResult(
      'T06-live',
      runtimeUnchanged,
      'real manual Benchmark does not create runtime-performance samples',
      { before: beforeRuntime, after: afterRuntime },
    ),
  ]
  return {
    ok: reportOk(cases),
    schemaVersion: V2_ACCEPTANCE_SCHEMA_VERSION,
    kind: 'provider-benchmark',
    generatedAt: Date.now(),
    providerRequestsAuthorized: true,
    chargeableCloudAuthorized: candidate.cloudCostWarning === true ? acceptedChargeableCloud === true : false,
    candidate: {
      key: candidate.key,
      provider: candidate.provider,
      model: candidate.model,
      local: candidate.local === true,
      cloudCostWarning: candidate.cloudCostWarning === true,
    },
    cases,
  }
}

function statusForError(error) {
  const code = String(error?.code ?? '')
  if (code.includes('CONSENT_REQUIRED') || code === 'V2_ACCEPTANCE_CHARGEABLE_CONSENT_REQUIRED') return 403
  if (code === 'V2_ACCEPTANCE_BUSY') return 409
  if (code === 'V2_ACCEPTANCE_BODY_TOO_LARGE') return 413
  if (code.includes('BACKEND_REQUIRED') || code.includes('BACKEND_UNKNOWN') || code === 'V2_ACCEPTANCE_INVALID_JSON') return 400
  if (code.includes('UNAVAILABLE') || code.includes('READ_ONLY')) return 503
  return 500
}

export function installV2AcceptanceService(ctx, options = {}) {
  const runtimeCtx = options.runtimeCtx ?? ctx
  const executionCtx = options.executionCtx ?? runtimeCtx
  const executionAcceptanceObserver = options.executionAcceptanceObserver
  const runtimePerformanceStore = options.runtimePerformanceStore
  const backgroundProfiler = options.backgroundProfiler
  const benchmarkManager = options.benchmarkManager
  const logger = options.logger ?? ctx?.logger

  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: V2_ACCEPTANCE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { ok: false, code: 'V2_ACCEPTANCE_METHOD', error: 'method not allowed' })
          return
        }
        // This route can mutate settings and optionally spend provider quota.
        // Do not rely solely on outer route registration: enforce loopback +
        // localhost Host again at the acceptance boundary itself.
        if (!isLocalUiRequest(req)) {
          sendJson(res, 403, {
            ok: false,
            code: 'V2_ACCEPTANCE_LOCAL_ONLY',
            error: 'v2 acceptance is available only from the local DSH machine',
          })
          return
        }
        try {
          const body = await readJsonBody(req)
          if (body.action === 'real-execution') {
            const report = await runV2RealExecutionAcceptance({
              runtimeCtx: executionCtx,
              executionObserver: executionAcceptanceObserver,
              backgroundProfiler,
              benchmarkManager,
              acceptedProviderRequests: body.acceptedProviderRequests === true,
              acceptedChargeableCloud: body.acceptedChargeableCloud === true,
              logger,
            })
            sendJson(res, 200, report)
            return
          }
          if (body.action === 'provider') {
            const report = await runV2ProviderAcceptance({
              benchmarkManager,
              runtimePerformanceStore,
              key: body.key,
              mode: body.mode,
              force: body.force === true,
              acceptedProviderRequests: body.acceptedProviderRequests === true,
              acceptedChargeableCloud: body.acceptedChargeableCloud === true,
            })
            sendJson(res, 200, report)
            return
          }
          if (body.action !== undefined && body.action !== 'safe') {
            sendJson(res, 400, { ok: false, code: 'V2_ACCEPTANCE_ACTION', error: 'unknown acceptance action' })
            return
          }
          const report = await runV2SafeAcceptance({
            runtimeCtx,
            runtimePerformanceStore,
            backgroundProfiler,
            benchmarkManager,
            acceptedSafeMutations: body.acceptedSafeMutations === true,
            logger,
          })
          sendJson(res, 200, report)
        } catch (error) {
          const code = error?.code ?? 'V2_ACCEPTANCE_FAILED'
          logger?.warn?.('vision-router: v2 acceptance failed code=%s error=%s', code, bounded(error))
          sendJson(res, statusForError(error), {
            ok: false,
            code,
            error: bounded(error),
          })
        }
      },
    }), 'vision-router: local v2 real-machine acceptance service')
  })
}

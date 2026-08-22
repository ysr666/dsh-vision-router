import {
  isLocalImageCapabilityAdmissionFailure,
  isLocalUnknownModelFailure,
} from './vision-execution-policy.js'
import { hostImageDeliveryFromInfo } from './vision-backend-runtime-policy.js'

export const VISION_BACKEND_SMOKE_TEST_PATH = '/_dsh/vision-router/test-vision-backend'
export const VISION_BACKEND_SMOKE_TEST_TIMEOUT_MS = 60_000
export const VISION_BACKEND_SMOKE_TEST_CODE = '731'

const REQUEST_MAX_BYTES = 4 * 1024
const RESPONSE_TEXT_MAX = 240
const PROVIDER_MAX = 160
const MODEL_MAX = 320
const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAALQAAABQCAIAAAA/esjxAAAA6UlEQVR42u3dUQqFIBBAUSfc/5btN8I/Jxr0nAWEPS6T8YpijNFg5vITIA7EgTgQB+JAHIgDcSAOxAFvPfdwEfHFKhf/AKq5KpMDcSAO7DnKeW4a6lzpS61quq9aXJXJgTj4/bKSO12zbkFrrsrkQByIA3GAOBAH4kAciANxIA7EgTgQB+IAcSAOkvQTTvKcZ7dMDsSBOBAH4kAcuJXdhJeaTA7EgTgQB+JAHIgDcSAOEAfiQByIA3EgDsSBONial5owORAHmRN3+6/YNR8ANDkQB+LAngOTA3EgDsSBOEAciANxIA7EQUU3wUckp/tmsUsAAAAASUVORK5CYII='
const TEST_PROMPT = 'Read the three-digit number shown in this image. Reply with only the digits.'
const NATIVE_KEY_REF = '__vision_router_smoke_native_key__'

function boundedText(value, max = RESPONSE_TEXT_MAX) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max)
}

function normalizedField(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max || trimmed.includes('\0')) return undefined
  return boundedText(trimmed, max)
}

export function normalizeVisionSmokeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const provider = normalizedField(value.provider, PROVIDER_MAX)
  const model = normalizedField(value.model, MODEL_MAX)
  if (provider === undefined || model === undefined) return undefined
  return { provider, model }
}

export function classifyVisionSmokeFailure(value, core = {}) {
  try {
    const classified = core?.classifyVisionFailure?.(value)
    if (classified && typeof classified.kind === 'string' && classified.kind !== '') {
      return classified.kind
    }
  } catch {
    // Fall through to a tiny UI-oriented classifier.
  }
  const status = Number(value?.status)
  const code = String(value?.code ?? '').toUpperCase()
  const text = boundedText(value?.message ?? value, 800).toLowerCase()
  if (value?.name === 'TimeoutError' || code.includes('TIMEOUT') || /timeout|timed out|deadline/.test(text)) return 'timeout'
  if (status === 401 || status === 403 || /unauthor|forbidden|credential|api[ _-]?key|authentication/.test(text)) return 'auth'
  if (status === 429 || /rate.?limit|too many requests|quota/.test(text)) return 'rate-limit'
  if (/does not support image|unsupported[_ -]?content|image input.*not support|text[- ]only/.test(text)) return 'unsupported-image'
  if (/fetch failed|network|econn|enotfound|socket|dns|connection refused/.test(text)) return 'network'
  return 'provider'
}

function activeSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const current = settings?.get?.('vision-router')
    return current && typeof current === 'object' ? current : fallback
  } catch {
    return fallback
  }
}

async function resolveCredential(ctx, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  try {
    const credentials = ctx?.get?.('credentials')
    const hit = await credentials?.resolve?.(ref)
    if (hit && typeof hit.value === 'string' && hit.value !== '') return hit.value
  } catch {
    // Core falls through to process.env when this returns undefined.
  }
  return undefined
}

function openAIMessages(png) {
  return [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
      { type: 'text', text: TEST_PROMPT },
    ],
  }]
}

async function adapterMessages(ctx, png) {
  const attachments = ctx?.get?.('attachments')
  if (!attachments || typeof attachments.saveImage !== 'function') {
    const error = new Error('attachment service is unavailable for exact vision test')
    error.code = 'VISION_SMOKE_INFRASTRUCTURE'
    throw error
  }
  const ref = await attachments.saveImage({
    data: png,
    mediaType: 'image/png',
    name: 'vision-router-smoke-731.png',
  })
  return [{
    role: 'user',
    content: [
      { type: 'image', attachment: ref },
      { type: 'text', text: TEST_PROMPT },
    ],
  }]
}

function failureError(value, fallback = 'vision backend failed') {
  if (value instanceof Error) return value
  const error = new Error(value && typeof value.message === 'string' && value.message !== '' ? value.message : fallback)
  if (value && typeof value === 'object') {
    for (const key of ['code', 'status', 'name']) {
      if (value[key] !== undefined) error[key] = value[key]
    }
  }
  return error
}

async function collectStreamText(streamLike) {
  const stream = await streamLike
  let text = ''
  for await (const chunk of stream) {
    // Only final answer text participates in the exact probe. Reasoning chunks
    // also carry a .text field in DSH and previously polluted the 731 check.
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') throw failureError(chunk.reason?.failure, kind)
    }
    if (chunk?.type === 'error' || chunk?.type === 'aborted') throw failureError(chunk.failure, chunk.type)
  }
  return text
}

function exactHttpProvider(core, config, selection) {
  if (selection.provider !== 'vision-http') return undefined
  const target = selection.model
  let locals = []
  let http = []
  try { locals = core?.localProvidersOf?.(config) ?? [] } catch { locals = [] }
  try { http = core?.httpProvidersOf?.(config) ?? [] } catch { http = [] }
  for (const provider of Array.isArray(locals) ? locals : []) {
    if (`${provider?.name}/${provider?.model}` === target) return { kind: 'local', provider }
  }
  for (const provider of Array.isArray(http) ? http : []) {
    if (`${provider?.name}/${provider?.model}` === target) return { kind: 'http', provider }
  }
  return undefined
}

function adapterAvailable(ctx, provider) {
  try {
    return ctx?.llm?.registration?.(provider) !== undefined
  } catch {
    return false
  }
}

function rawChannelProfileOf(ctx, provider) {
  try {
    const settings = ctx?.get?.('settings')
    const section = settings?.get?.('llm-pi-ai')
    return section && section.providers ? section.providers[provider] : undefined
  } catch {
    return undefined
  }
}

function resolvedChannelProfileOf(ctx, provider) {
  try {
    const registration = ctx?.llm?.registration?.(provider)
    const config = registration?.adapter?.config
    const profiles = typeof config?.profiles === 'function' ? config.profiles() : undefined
    return typeof profiles?.get === 'function' ? profiles.get(provider) : undefined
  } catch {
    return undefined
  }
}

async function resolveNativeChannelApiKey(ctx, plan) {
  const ref = plan?.transport?.apiKeyEnv
  if (typeof ref === 'string' && ref !== '') {
    const resolved = await resolveCredential(ctx, ref)
    if (resolved) return resolved
    if (typeof process !== 'undefined' && process.env && typeof process.env[ref] === 'string') {
      return process.env[ref]
    }
  }
  try {
    const auth = plan?.resolvedProfile?.piProvider?.auth?.apiKey
    if (auth && typeof auth.resolve === 'function') {
      const hit = await auth.resolve({ credential: undefined })
      const value = hit?.auth?.apiKey
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    // Native auth is optional; anonymous endpoints need no key.
  }
  return undefined
}

function channelBridgePlan(ctx, core, selection) {
  if (typeof core?.resolveChannelBridgeTransport !== 'function') return undefined
  const rawProfile = rawChannelProfileOf(ctx, selection.provider)
  const resolvedProfile = resolvedChannelProfileOf(ctx, selection.provider)
  const transport = core.resolveChannelBridgeTransport(rawProfile, resolvedProfile, selection.model)
  const supported = typeof core?.isOpenAIHttpBridgeTransport === 'function'
    ? core.isOpenAIHttpBridgeTransport(transport)
    : transport?.api === 'openai-completions' && typeof transport?.baseURL === 'string'
  if (!supported) return undefined
  return { rawProfile, resolvedProfile, transport }
}

function mayUseCompatibilityBridge(error, selection, isBridgeEvidence) {
  if (isLocalImageCapabilityAdmissionFailure(error)) return true
  if (!isLocalUnknownModelFailure(error, selection.provider, selection.model)) return false
  try { return isBridgeEvidence?.(selection.provider, selection.model) === true } catch { return false }
}

async function callChannelBridge(ctx, core, selection, png, signal) {
  if (typeof core?.callOpenAICompatible !== 'function') return undefined
  const plan = channelBridgePlan(ctx, core, selection)
  if (plan === undefined) return undefined
  const nativeKey = await resolveNativeChannelApiKey(ctx, plan)
  const configuredRef = typeof plan.transport.apiKeyEnv === 'string' ? plan.transport.apiKeyEnv : ''
  const keyRef = configuredRef || (nativeKey ? NATIVE_KEY_REF : '')
  const directProvider = {
    name: selection.provider,
    baseURL: plan.transport.baseURL,
    model: selection.model,
    apiKeyEnv: keyRef,
    maxTokens: 64,
  }
  return core.callOpenAICompatible(directProvider, openAIMessages(png), {
    maxTokens: 64,
    signal,
    resolveCredential: async (ref) => {
      if (ref === NATIVE_KEY_REF && nativeKey) return nativeKey
      if (configuredRef !== '' && ref === configuredRef && nativeKey) return nativeKey
      return resolveCredential(ctx, ref)
    },
  })
}

function normalizeDigits(value) {
  return String(value ?? '').replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xFF10))
}

export function verifyVisionSmokeOutput(output) {
  const text = normalizeDigits(output)
  const candidates = [...text.matchAll(/(?<!\d)\d{3}(?!\d)/g)].map((match) => match[0])
  const unique = new Set(candidates)
  return unique.size === 1 && unique.has(VISION_BACKEND_SMOKE_TEST_CODE)
}

async function resolvedSmokeModelInfo(ctx, selection, signal) {
  if (typeof ctx?.llm?.prepareCall === 'function') {
    try {
      const prepared = await ctx.llm.prepareCall({ provider: selection.provider, model: selection.model }, signal)
      if (Array.isArray(prepared?.inputModalities)) return { inputModalities: [...prepared.inputModalities] }
    } catch {
      // Exact adapter execution below remains authoritative when metadata lookup fails.
    }
  }
  try {
    return await ctx?.llm?.resolveModelInfo?.(selection.provider, selection.model)
  } catch {
    return undefined
  }
}

export async function runExactVisionBackendSmokeTest({
  ctx,
  core,
  config,
  provider,
  model,
  signal,
  isBridgeEvidence,
  now = Date.now,
} = {}) {
  const selection = normalizeVisionSmokeSelection({ provider, model })
  if (selection === undefined) {
    const error = new Error('provider and model are required')
    error.code = 'VISION_SMOKE_INVALID_SELECTION'
    throw error
  }
  const started = Number(now())
  const png = Buffer.from(TEST_IMAGE_BASE64, 'base64')
  const effectiveSignal = signal ?? AbortSignal.timeout(VISION_BACKEND_SMOKE_TEST_TIMEOUT_MS)
  let output
  let transport

  if (selection.provider === 'vision-http') {
    const direct = exactHttpProvider(core, config, selection)
    if (direct === undefined) {
      const error = new Error(`vision-http backend "${selection.model}" is not configured`)
      error.code = 'VISION_SMOKE_UNKNOWN_BACKEND'
      throw error
    }
    if (direct.kind === 'local') {
      if (typeof core?.callLocalBackend !== 'function') {
        const error = new Error('local vision dispatch is unavailable')
        error.code = 'VISION_SMOKE_INFRASTRUCTURE'
        throw error
      }
      output = await core.callLocalBackend(direct.provider, openAIMessages(png), {
        maxTokens: 64,
        signal: effectiveSignal,
        resolveCredential: (ref) => resolveCredential(ctx, ref),
      })
      transport = 'local-direct'
    } else {
      if (typeof core?.callOpenAICompatible !== 'function') {
        const error = new Error('OpenAI-compatible vision dispatch is unavailable')
        error.code = 'VISION_SMOKE_INFRASTRUCTURE'
        throw error
      }
      output = await core.callOpenAICompatible(direct.provider, openAIMessages(png), {
        maxTokens: 64,
        signal: effectiveSignal,
        resolveCredential: (ref) => resolveCredential(ctx, ref),
      })
      transport = 'http-direct'
    }
  } else {
    if (!adapterAvailable(ctx, selection.provider)) {
      const error = new Error(`provider "${selection.provider}" is not active`)
      error.code = 'VISION_SMOKE_UNKNOWN_PROVIDER'
      throw error
    }

    // Match runtime's preflight rule. When DSH explicitly declares this model
    // text-only it will replace the image with a SHA marker before the adapter
    // runs, producing a false-success response. The exact smoke test must use
    // the same safe direct pixel transport instead of testing that projection.
    const info = await resolvedSmokeModelInfo(ctx, selection, effectiveSignal)
    const delivery = hostImageDeliveryFromInfo(info)
    const capability = typeof core?.decideVisionBackendCapability === 'function'
      ? core.decideVisionBackendCapability(info, selection.provider, selection.model, config?.extraVisionModels)
      : { image: false }
    if (delivery === 'text-projected' && (capability.image === true || selection.provider !== 'vision-http')) {
      const bridged = await callChannelBridge(ctx, core, selection, png, effectiveSignal)
      if (bridged === undefined) {
        const error = new Error('Host declares this backend text-only and no safe pixel bridge is available')
        error.code = 'VISION_IMAGE_DELIVERY_UNAVAILABLE'
        throw error
      }
      output = bridged
      transport = 'preflight-bridge'
    } else {
      const messages = await adapterMessages(ctx, png)
      try {
        output = await collectStreamText(ctx.llm.stream({
          provider: selection.provider,
          model: selection.model,
          messages,
          maxTokens: 64,
          reasoningEffort: undefined,
          signal: effectiveSignal,
        }))
        transport = 'adapter'
      } catch (adapterError) {
        if (!mayUseCompatibilityBridge(adapterError, selection, isBridgeEvidence)) throw adapterError
        const bridged = await callChannelBridge(ctx, core, selection, png, effectiveSignal)
        if (bridged === undefined) throw adapterError
        output = bridged
        transport = 'adapter-bridge'
      }
    }
  }

  const finished = Number(now())
  const latencyMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : undefined
  const text = boundedText(output)
  return {
    ok: true,
    exact: true,
    fallbackUsed: false,
    imageRequest: true,
    verified: verifyVisionSmokeOutput(text),
    provider: selection.provider,
    model: selection.model,
    transport,
    latencyMs,
    output: text,
  }
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > REQUEST_MAX_BYTES) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    const error = new Error('invalid JSON request body')
    error.status = 400
    throw error
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function requestLooksSameOrigin(req) {
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return false
  const origin = req?.headers?.origin
  const host = req?.headers?.host
  if (typeof origin !== 'string' || origin === '' || typeof host !== 'string' || host === '') return true
  try { return new URL(origin).host === host } catch { return false }
}

export function installVisionBackendSmokeTest(ctx, fallbackConfig, core, options = {}) {
  const logger = options.logger
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: VISION_BACKEND_SMOKE_TEST_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          res.writeHead(405)
          res.end()
          return
        }
        if (!requestLooksSameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin vision test request rejected' })
          return
        }
        let selection
        try {
          selection = normalizeVisionSmokeSelection(await readJsonBody(req))
          if (selection === undefined) {
            sendJson(res, 400, { ok: false, error: 'provider and model are required' })
            return
          }
          const result = await runExactVisionBackendSmokeTest({
            ctx: webCtx,
            core,
            config: activeSettings(webCtx, fallbackConfig),
            ...selection,
            signal: AbortSignal.timeout(VISION_BACKEND_SMOKE_TEST_TIMEOUT_MS),
            isBridgeEvidence: options.isBridgeEvidence,
          })
          sendJson(res, 200, result)
        } catch (error) {
          const failureClass = classifyVisionSmokeFailure(error, core)
          try {
            logger?.warn?.(
              'vision-router: exact vision smoke test failed [%s/%s] class=%s detail=%s',
              selection?.provider ?? 'unknown',
              selection?.model ?? 'unknown',
              failureClass,
              boundedText(error?.message ?? error, 400),
            )
          } catch {
            // Diagnostics must never change the response.
          }
          const status = Number(error?.status)
          sendJson(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 502, {
            ok: false,
            exact: true,
            fallbackUsed: false,
            imageRequest: true,
            provider: selection?.provider,
            model: selection?.model,
            failureClass,
            error: boundedText(error?.message ?? error, 400) || 'vision backend test failed',
          })
        }
      },
    }), 'vision-router: exact vision backend smoke test')
  })
}

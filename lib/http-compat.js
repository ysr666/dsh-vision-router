import { currentVisionProviderTransport } from './vision-provider-transport.js'

const GLM_4V_FLASH = /^glm-4v-flash(?:$|[-_.])/i
export const DEFAULT_HTTP_ERROR_DETAIL_MAX_BYTES = 64 * 1024

/**
 * Known OpenAI-compatible transport quirks. Rules are intentionally sparse:
 * unknown/new models stay on the generic OpenAI-compatible path first, while
 * model-family rules only constrain behavior we have evidence for.
 *
 * Add future compatibility here instead of scattering provider-specific
 * conditionals through vision_describe / vision-http / pixel tools.
 */
export const HTTP_PROVIDER_COMPAT_PRESETS = [
  {
    id: 'glm-4v-flash-max-output',
    model: GLM_4V_FLASH,
    // Zhipu GLM-4V-Flash rejects larger values with error 1210.
    maxTokensCap: 1024,
  },
]

function asUrl(value) {
  try {
    return value instanceof URL ? value : new URL(String(value))
  } catch {
    return undefined
  }
}

function ruleMatches(rule, { model, url, providerName }) {
  if (rule.model && !rule.model.test(String(model ?? ''))) return false
  if (rule.provider && !rule.provider.test(String(providerName ?? ''))) return false
  if (rule.host) {
    const host = asUrl(url)?.hostname ?? ''
    if (!rule.host.test(host)) return false
  }
  return true
}

/** Resolve all family/model presets that apply to one OpenAI-compatible call. */
export function resolveHttpProviderCompatibility({ model, url, providerName } = {}) {
  const matched = HTTP_PROVIDER_COMPAT_PRESETS.filter((rule) =>
    ruleMatches(rule, { model, url, providerName }),
  )
  let maxTokensCap
  let tokenParameter
  for (const rule of matched) {
    if (Number.isFinite(rule.maxTokensCap) && rule.maxTokensCap > 0) {
      maxTokensCap =
        maxTokensCap === undefined ? rule.maxTokensCap : Math.min(maxTokensCap, rule.maxTokensCap)
    }
    if (typeof rule.tokenParameter === 'string' && rule.tokenParameter !== '') {
      tokenParameter = rule.tokenParameter
    }
  }
  return {
    presetIds: matched.map((rule) => rule.id),
    maxTokensCap,
    tokenParameter,
  }
}

function cloneMessages(messages) {
  return (messages ?? []).map((message) => {
    if (!message || !Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((block) =>
        block && typeof block === 'object' ? { ...block } : block,
      ),
    }
  })
}

/**
 * Ensure an image-only user message also carries the question/prompt. Some
 * OpenAI-compatible vision endpoints (notably Zhipu GLM) reject pure-image
 * content even though more permissive endpoints accept it.
 */
export function appendPromptToImageOnlyMessage(messages, prompt) {
  const text = String(prompt ?? '')
  if (text === '') return { messages, changed: false }
  const next = cloneMessages(messages)
  for (let i = 0; i < next.length; i++) {
    const message = next[i]
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) continue
    const hasImage = message.content.some((block) => block && block.type === 'image_url')
    const hasText = message.content.some(
      (block) => block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '',
    )
    if (!hasImage || hasText) continue
    message.content = [...message.content, { type: 'text', text }]
    return { messages: next, changed: true }
  }
  return { messages, changed: false }
}

function positiveInteger(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Parse a server-advertised max-token upper bound from common error wording. */
export function parseMaxTokensLimit(detail) {
  const text = String(detail ?? '')
  // Require token-specific context before considering a generic "range" phrase;
  // otherwise e.g. a temperature range error could accidentally shrink output.
  // Both OpenAI-style output-limit field names are recognized.
  if (!/(?:max(?:_completion)?[_ -]?tokens?|token[^\n]{0,24}(?:limit|max)|最大[^\n]{0,12}(?:token|输出))/i.test(text)) {
    return undefined
  }
  const patterns = [
    /(?:限制数值范围|range)\s*[\[(]\s*\d+\s*,\s*(\d+)\s*[\])]/i,
    /(?:less than or equal to|at most|maximum(?: allowed)?|max(?:imum)?(?: value)?|<=)\D{0,24}(\d+)/i,
    /(?:上限|最大(?:值|输出)?)[^\d]{0,16}(\d+)/i,
    /(?:max(?:_completion)?[_ -]?tokens?)[^\d]{0,40}(\d+)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const value = positiveInteger(match && match[1])
    if (value !== undefined) return value
  }
  return undefined
}

/** Detect the common OpenAI migration error that asks for max_completion_tokens. */
export function shouldUseMaxCompletionTokens(detail) {
  const text = String(detail ?? '')
  return (
    /max_tokens/i.test(text) &&
    /max_completion_tokens/i.test(text) &&
    /(?:unsupported|not supported|use|instead|不支持|请使用)/i.test(text)
  )
}

/**
 * Read only the small diagnostic prefix needed by compatibility heuristics.
 * The original Response is never consumed. A declared oversized body is not
 * cloned at all; an unknown-length stream is read only up to the byte cap and
 * the clone branch is cancelled immediately so error parsing cannot become an
 * unbounded memory sink.
 */
export async function readResponseTextLimited(
  response,
  maxBytes = DEFAULT_HTTP_ERROR_DETAIL_MAX_BYTES,
) {
  const limit = positiveInteger(maxBytes) ?? DEFAULT_HTTP_ERROR_DETAIL_MAX_BYTES
  const declared = Number(response?.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) return ''

  let clone
  try {
    clone = response.clone()
  } catch {
    return ''
  }
  const body = clone.body
  if (!body || typeof body.getReader !== 'function') return ''

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? [])
      const remaining = limit - total
      const accepted = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining)
      total += accepted.byteLength
      text += decoder.decode(accepted, { stream: total < limit })
      if (bytes.byteLength > remaining || total >= limit) {
        try { await reader.cancel('compatibility error detail byte limit reached') } catch { /* best effort */ }
        break
      }
    }
    text += decoder.decode()
    return text
  } catch {
    return ''
  } finally {
    try { reader.releaseLock() } catch { /* best effort */ }
  }
}

/**
 * Apply known presets plus the per-tool prompt context to a parsed request
 * body. Explicit user values are respected when already stricter than a cap.
 */
export function prepareOpenAICompatibleBody(body, { url, providerName, prompt } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { body, changed: false, presetIds: [] }
  }
  let next = { ...body }
  let changed = false
  const compatibility = resolveHttpProviderCompatibility({
    model: next.model,
    url,
    providerName,
  })

  const cap = positiveInteger(compatibility.maxTokensCap)
  const currentMax = positiveInteger(next.max_tokens)
  if (cap !== undefined && currentMax !== undefined && currentMax > cap) {
    next.max_tokens = cap
    changed = true
  }

  if (compatibility.tokenParameter === 'max_completion_tokens' && next.max_tokens !== undefined) {
    next.max_completion_tokens = next.max_tokens
    delete next.max_tokens
    changed = true
  }

  if (Array.isArray(next.messages) && String(prompt ?? '') !== '') {
    const appended = appendPromptToImageOnlyMessage(next.messages, prompt)
    if (appended.changed) {
      next.messages = appended.messages
      changed = true
    }
  }

  return { body: next, changed, presetIds: compatibility.presetIds }
}

function isCompatibleChatCompletionRequest(input, init) {
  if (!init || typeof init.body !== 'string') return false
  const method = String(init.method ?? 'GET').toUpperCase()
  if (method !== 'POST') return false
  const url = asUrl(typeof input === 'string' || input instanceof URL ? input : input?.url)
  return url !== undefined && /\/chat\/completions\/?$/.test(url.pathname)
}

function bodyWithTokenLimit(body, limit) {
  const max = positiveInteger(limit)
  if (max === undefined) return undefined
  if (positiveInteger(body.max_tokens) !== undefined && body.max_tokens > max) {
    return { ...body, max_tokens: max }
  }
  if (
    positiveInteger(body.max_completion_tokens) !== undefined &&
    body.max_completion_tokens > max
  ) {
    return { ...body, max_completion_tokens: max }
  }
  return undefined
}

function nextCompatibilityBody(body, detail) {
  const advertisedLimit = parseMaxTokensLimit(detail)
  const limited = bodyWithTokenLimit(body, advertisedLimit)
  if (limited !== undefined) return limited

  if (shouldUseMaxCompletionTokens(detail) && body.max_tokens !== undefined) {
    const migrated = { ...body, max_completion_tokens: body.max_tokens }
    delete migrated.max_tokens
    return migrated
  }
  return undefined
}

/**
 * Fetch wrapper for vision-router's own OpenAI-compatible requests only.
 *
 * When the P2 provider transport is installed, every active Router-owned call
 * goes through that facade. The `fetchImpl` parameter remains as a compatibility
 * fallback for direct/unit callers, so the behavior outside the public plugin
 * composition is unchanged.
 *
 * Layer 1: generic request shape (works for unknown/new models).
 * Layer 2: known model-family presets.
 * Layer 3: bounded, evidence-driven retries when the server reports an output
 * token ceiling or explicitly requests max_completion_tokens. At most two
 * corrective retries are allowed so two independent quirks can be resolved
 * sequentially without creating an unbounded retry loop.
 */
export async function fetchWithOpenAICompatibility(fetchImpl, input, init, context = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required')
  const transport = context.active === true ? currentVisionProviderTransport() : undefined
  const requestFetch = transport
    ? (nextInput, nextInit) => transport.fetch(nextInput, nextInit, {
        providerName: context.providerName,
        allowProxy: context.allowProxy !== false,
      })
    : fetchImpl

  if (context.active !== true) {
    return requestFetch(input, init)
  }
  if (!isCompatibleChatCompletionRequest(input, init)) {
    return requestFetch(input, init)
  }

  let parsed
  try {
    parsed = JSON.parse(init.body)
  } catch {
    return requestFetch(input, init)
  }

  const url = typeof input === 'string' || input instanceof URL ? input : input?.url
  const prepared = prepareOpenAICompatibleBody(parsed, {
    url,
    providerName: context.providerName,
    prompt: context.prompt,
  })
  let requestBody = prepared.body
  let response = await requestFetch(input, { ...init, body: JSON.stringify(requestBody) })

  for (let correction = 0; correction < 2; correction++) {
    if (response.ok || (response.status !== 400 && response.status !== 422)) return response

    const detail = await readResponseTextLimited(
      response,
      context.errorDetailMaxBytes ?? DEFAULT_HTTP_ERROR_DETAIL_MAX_BYTES,
    )
    if (detail === '') return response

    const retryBody = nextCompatibilityBody(requestBody, detail)
    if (retryBody === undefined || JSON.stringify(retryBody) === JSON.stringify(requestBody)) {
      return response
    }

    requestBody = retryBody
    response = await requestFetch(input, { ...init, body: JSON.stringify(requestBody) })
  }

  return response
}

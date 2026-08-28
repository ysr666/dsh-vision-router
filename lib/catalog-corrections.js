// Known catalog-routing corrections: provider/model entries where the
// installed pi-ai model catalog disagrees with the provider's OFFICIAL
// endpoint table. Each entry names the wire protocol (api) and baseURL the
// model actually speaks. A correction only engages when the harness-resolved
// catalog entry still routes that pair to a DIFFERENT protocol — the moment
// the upstream catalog is fixed, the correction disarms itself and the normal
// harness path resumes. This is deliberately data, not scattered if-blocks:
// when a gateway renames or adds an affected model, extend the table.

import { kindForHttpStatus } from './vision-resilience.js'
import {
  ERROR_RESPONSE_MAX_BYTES,
  MODEL_RESPONSE_MAX_BYTES,
  readResponseJsonBounded,
  readResponseTextBounded,
} from './http-body-limit.js'
import { stripTrailingSlashes } from './string-normalization.js'
import { currentVisionProviderTransport } from './vision-provider-transport.js'

export const CATALOG_ROUTING_CORRECTIONS = [
  {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
    // OpenCode Go official endpoints (https://opencode.ai/docs/go): Qwen3.6
    // Plus is served ONLY through the Anthropic Messages endpoint
    // (https://opencode.ai/zen/go/v1/messages, @ai-sdk/anthropic). The pi-ai
    // catalog still classifies it as openai-completions, so the harness sends
    // vision requests to /v1/chat/completions where the gateway falls back to
    // a different model (user report: MiniMax M3 answered instead).
    api: 'anthropic-messages',
    baseURL: 'https://opencode.ai/zen/go',
    // The exact broken configuration this correction recognizes. A route the
    // user pointed elsewhere (or a catalog fixed upstream) never engages it.
    wrongApi: 'openai-completions',
    wrongBaseURLPrefix: 'opencode.ai/zen/go',
  },
  {
    provider: 'opencode-go',
    model: 'minimax-m2.7',
    // Same misclassification as qwen3.6-plus; the catalog marks it text-only,
    // so it never appears as a vision backend today — corrected for chat use
    // and in case a future catalog declares image input on the wrong protocol.
    api: 'anthropic-messages',
    baseURL: 'https://opencode.ai/zen/go',
    wrongApi: 'openai-completions',
    wrongBaseURLPrefix: 'opencode.ai/zen/go',
  },
]

/**
 * Decide whether a routing correction engages for one resolved backend.
 *
 * @param facts - the harness-resolved catalog facts for the pair:
 *   `{ api, baseUrl }`. Undefined (or an unknown api) fails closed — the
 *   plugin never bypasses the harness for a route it cannot fingerprint.
 * @param provider - provider id.
 * @param model - model id.
 * @param enabled - the runtime switch (settings `catalogCorrections`).
 * @returns the correction entry to dispatch through, or undefined to use the
 *   normal harness path.
 */
export function routingCorrectionFor(facts, provider, model, enabled = true) {
  if (enabled === false) return undefined
  if (!facts || typeof facts.api !== 'string' || facts.api === '') return undefined
  const entry = CATALOG_ROUTING_CORRECTIONS.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  )
  if (entry === undefined) return undefined
  // Upstream fixed: the catalog now agrees with the correction — stand down.
  if (entry.api === facts.api) return undefined
  // The resolved route is broken in some OTHER way (or speaks yet another
  // protocol); not the configuration this correction was written for.
  if (entry.wrongApi !== undefined && entry.wrongApi !== facts.api) return undefined
  // A user route pointed at their own gateway keeps its own routing: only the
  // exact catalog baseURL this correction documents gets intercepted.
  if (entry.wrongBaseURLPrefix !== undefined) {
    const baseUrl = String(facts.baseUrl ?? '')
    if (!baseUrl.includes(entry.wrongBaseURLPrefix)) return undefined
  }
  return entry
}

/** Normalize attachment media types to the set the Anthropic wire accepts. */
export function anthropicMediaType(mediaType) {
  const value = String(mediaType ?? '').toLowerCase()
  if (value === 'image/jpg') return 'image/jpeg'
  return value
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* keep the empty object below */
    }
  }
  return {}
}

async function convertBlocks(blocks, bytesOf, depth = 0) {
  const out = []
  if (!Array.isArray(blocks) || depth > 4) return out
  for (const block of blocks) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      out.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      if (typeof bytesOf !== 'function') continue
      let bytes
      try {
        bytes = await bytesOf(block.attachment)
      } catch {
        continue // an unreadable image must not sink the whole request
      }
      if (!bytes || bytes.length === 0) continue
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: anthropicMediaType(block.attachment && block.attachment.mediaType) || 'image/png',
          data: Buffer.from(bytes).toString('base64'),
        },
      })
    } else if (block.type === 'tool-call') {
      out.push({
        type: 'tool_use',
        id: typeof block.id === 'string' ? block.id : `call_${out.length}`,
        name: typeof block.name === 'string' ? block.name : 'tool',
        input: parseArguments(block.arguments),
      })
    } else if (block.type === 'tool-result') {
      const nested = await convertBlocks(block.content, bytesOf, depth + 1)
      if (nested.length > 0) {
        out.push({
          type: 'tool_result',
          tool_use_id: typeof block.toolCallId === 'string' ? block.toolCallId : '',
          content: nested,
        })
      }
    } else if (block.type === 'reasoning' || block.type === 'thinking') {
      // Prior reasoning does not belong in a vision request; skip it.
      continue
    } else if (Array.isArray(block.content)) {
      out.push(...(await convertBlocks(block.content, bytesOf, depth + 1)))
    }
  }
  return out
}

/**
 * Convert harness messages into the Anthropic Messages wire shape.
 * Consecutive same-role messages are merged (the wire requires alternation),
 * system messages fold into the `system` string, and tool results follow the
 * `tool_result` block convention. Unrepresentable blocks are skipped rather
 * than failing the request — vision answers only need the visible content.
 *
 * @param messages - harness chat messages (array-form content blocks).
 * @param bytesOf - async (attachment) => image bytes; image blocks are dropped
 *   when it throws or returns nothing.
 * @returns { system, messages } ready for the /v1/messages request body.
 */
export async function toAnthropicMessages(messages, bytesOf) {
  const system = []
  const wire = []
  const push = (role, content) => {
    if (content.length === 0) return
    const last = wire[wire.length - 1]
    if (last && last.role === role) last.content.push(...content)
    else wire.push({ role, content })
  }
  for (const message of messages ?? []) {
    if (!message) continue
    const role = message.role
    if (role === 'system') {
      const text = await convertBlocks(message.content, bytesOf)
      const joined = text.map((block) => (block.type === 'text' ? block.text : '')).join('\n').trim()
      if (joined !== '') system.push(joined)
      continue
    }
    if (role === 'user') {
      push('user', await convertBlocks(message.content, bytesOf))
      continue
    }
    if (role === 'assistant') {
      push('assistant', await convertBlocks(message.content, bytesOf))
      continue
    }
    // Any other role (tool results carried outside assistant tool-call
    // frames, future harness shapes) folds into the user stream as text —
    // the same posture as the vision-http route's OpenAI conversion.
    if (typeof message.content === 'string') {
      push('user', [{ type: 'text', text: message.content }])
    } else if (Array.isArray(message.content)) {
      push('user', await convertBlocks(message.content, bytesOf))
    }
  }
  // The Anthropic wire rejects a conversation that does not open with a user
  // message (e.g. history starting mid-turn with an assistant reply). Open
  // with a synthetic marker instead of dropping real history.
  if (wire.length > 0 && wire[0].role !== 'user') {
    wire.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation history)' }] })
  }
  return { system: system.join('\n').trim(), messages: wire }
}

/**
 * One non-streaming Anthropic Messages call. Parallel to callOpenAICompatible:
 * same credential seam, same typed failures (status/code/retry-after) so the
 * circuit breaker and fallback chains classify it identically.
 *
 * @param provider - { name, baseURL, model, apiKeyEnv? }; baseURL without the
 *   /v1 suffix (the client appends /v1/messages).
 * @param messages - anthropic wire messages (see toAnthropicMessages).
 * @param options - { maxTokens, signal, apiKey, resolveCredential, system, allowKeyless }.
 *   `allowKeyless` (default false) permits a missing key for local keyless
 *   servers (LM Studio / Ollama); when true and no key resolves, the
 *   x-api-key header is omitted instead of throwing.
 * @returns the joined assistant text content.
 */
export async function callAnthropicCompatible(provider, messages, options = {}) {
  const apiKeyEnv = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : ''
  let resolvedApiKey = typeof options.apiKey === 'string' ? options.apiKey : ''
  if (resolvedApiKey === '' && apiKeyEnv !== '') {
    if (typeof options.resolveCredential === 'function') {
      const hit = await options.resolveCredential(apiKeyEnv)
      if (hit) resolvedApiKey = String(hit)
    }
    if (resolvedApiKey === '' && typeof process !== 'undefined' && process.env) {
      resolvedApiKey = process.env[apiKeyEnv] ?? ''
    }
  }
  if (resolvedApiKey === '' && options.allowKeyless !== true) {
    throw new Error(`anthropic provider "${provider.name}": api key is not set`)
  }
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    // Local keyless servers reject an empty x-api-key; omit it when allowed.
    ...(resolvedApiKey === '' ? {} : { 'x-api-key': resolvedApiKey }),
  }
  const body = {
    model: provider.model,
    messages,
    max_tokens: options.maxTokens ?? provider.maxTokens ?? 4096,
    stream: false,
    // Local backends may carry explicit sampling options. Existing callers
    // never pass them, so the wire body stays byte-identical for main paths.
    ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    ...(typeof options.top_p === 'number' ? { top_p: options.top_p } : {}),
  }
  const system = options.system && String(options.system).trim() !== '' ? options.system : undefined
  const url = `${stripTrailingSlashes(provider.baseURL)}/v1/messages`
  let response
  try {
    const transport = currentVisionProviderTransport()
    const requestFetch = transport
      ? (input, init) => transport.fetch(input, init, { providerName: provider.name, allowProxy: true })
      : fetch
    response = await requestFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(system === undefined ? body : { ...body, system }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const abort = new Error(`anthropic provider "${provider.name}": request aborted`)
      abort.name = 'AbortError'
      throw abort
    }
    throw new Error(`anthropic provider "${provider.name}": ${error && error.message ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = (await readResponseTextBounded(
      response,
      ERROR_RESPONSE_MAX_BYTES,
      { label: `anthropic provider \"${provider.name}\" error response` },
    ).catch(() => '')).slice(0, 300)
    const retryAfter = Number(response.headers.get('retry-after'))
    const error = new Error(`anthropic provider "${provider.name}": ${response.status} ${detail}`)
    error.status = response.status
    error.code = kindForHttpStatus(response.status) ?? 'HTTP_PROVIDER_FAILED'
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      error.providerRetryAfterMs = Math.min(retryAfter * 1000, 60 * 60 * 1000)
    }
    throw error
  }
  const data = await readResponseJsonBounded(
    response,
    MODEL_RESPONSE_MAX_BYTES,
    { label: `anthropic provider \"${provider.name}\" response` },
  )
  const blocks = Array.isArray(data && data.content) ? data.content : []
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
  if (text === '') {
    throw new Error(`anthropic provider "${provider.name}": response carried no text content`)
  }
  return text
}

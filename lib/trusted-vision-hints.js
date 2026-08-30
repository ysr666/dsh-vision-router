import { configuredProviderTransports, providerTransportFor } from './live-model-discovery.js'
import { stripTrailingSlashes } from './string-normalization.js'

const BIGMODEL_API_BASE = 'https://open.bigmodel.cn/api/paas/v4'

const BIGMODEL_VISION_HINTS = Object.freeze([
  Object.freeze({ id: 'glm-4.6v', name: 'GLM-4.6V' }),
  Object.freeze({ id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash' }),
  Object.freeze({ id: 'glm-4.1v-thinking-flash', name: 'GLM-4.1V-Thinking-Flash' }),
  Object.freeze({ id: 'glm-4v-flash', name: 'GLM-4V-Flash' }),
])

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return undefined
    url.hash = ''
    url.search = ''
    return stripTrailingSlashes(url.toString())
  } catch {
    return undefined
  }
}

function transportMatchesBigModel(transport) {
  if (!transport || transport.api !== 'openai-completions') return false
  return normalizeEndpoint(transport.baseURL) === BIGMODEL_API_BASE
}

/**
 * Small, intentionally curated provider hints for visual models that official
 * endpoints accept but their OpenAI-compatible GET /models listing may omit.
 *
 * A hint is not "live discovery". It is endpoint-scoped compatibility evidence
 * used only by Vision Router's isolated image backend. The route must resolve
 * to the exact trusted official endpoint; matching a provider id or hostname
 * substring is deliberately insufficient.
 */
export function trustedVisionHintsForTransport(transport) {
  return transportMatchesBigModel(transport) ? BIGMODEL_VISION_HINTS : []
}

export function trustedVisionHintsForProvider(ctx, provider) {
  const transport = providerTransportFor(ctx, provider)
  return trustedVisionHintsForTransport(transport)
}

export function trustedVisionHintEntries(ctx) {
  return configuredProviderTransports(ctx).flatMap((transport) => {
    const models = trustedVisionHintsForTransport(transport)
    if (models.length === 0) return []
    return [{
      provider: transport.provider,
      baseURL: transport.baseURL,
      api: transport.api,
      models: models.map((model) => ({ ...model })),
    }]
  })
}

export function hasTrustedVisionHint(ctx, provider, model) {
  if (typeof model !== 'string' || model.trim() === '') return false
  return trustedVisionHintsForProvider(ctx, provider).some((candidate) => candidate.id === model)
}

export const TRUSTED_VISION_HINTS = Object.freeze({
  bigmodel: Object.freeze({
    baseURL: BIGMODEL_API_BASE,
    models: BIGMODEL_VISION_HINTS,
  }),
})

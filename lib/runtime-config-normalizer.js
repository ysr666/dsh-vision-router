export const MAX_RUNTIME_PROVIDER_ROWS = 32
export const MAX_RUNTIME_FALLBACKS_PER_ROW = 32
export const MAX_RUNTIME_MODEL_ID_CHARS = 512

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RUNTIME_MODEL_ID_CHARS
}

function normalizeFallbacks(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const fallback of value) {
    if (!validIdentifier(fallback)) continue
    out.push(fallback)
    if (out.length >= MAX_RUNTIME_FALLBACKS_PER_ROW) break
  }
  return out
}

/**
 * Normalize only the provider/model chain fields that runtime code iterates.
 *
 * Settings normally validates these fields through Schemastery, but direct
 * apply() callers, migrations, corrupted profile data, or a future settings
 * bridge can still hand runtime code a structurally invalid object. Keep the
 * authorization parser and the execution parser on one bounded shape instead
 * of letting each boundary improvise its own coercion rules.
 */
export function normalizeRuntimeVisionConfig(value) {
  const source = plainObject(value) ? value : {}
  const providers = []
  if (Array.isArray(source.providers)) {
    for (const entry of source.providers) {
      if (!plainObject(entry) || !validIdentifier(entry.provider) || !validIdentifier(entry.model)) continue
      providers.push({
        ...entry,
        provider: entry.provider,
        model: entry.model,
        fallbacks: normalizeFallbacks(entry.fallbacks),
      })
      if (providers.length >= MAX_RUNTIME_PROVIDER_ROWS) break
    }
  }

  return {
    ...source,
    providers,
    fallbacks: normalizeFallbacks(source.fallbacks),
  }
}

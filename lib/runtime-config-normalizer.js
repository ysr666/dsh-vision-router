import { Buffer } from 'node:buffer'

import {
  normalizeVisionRoutingMode,
  normalizeVisionRoutingPreference,
} from './vision-routing-product.js'

export const MAX_RUNTIME_PROVIDER_ROWS = 32
export const MAX_RUNTIME_FALLBACKS_PER_ROW = 32
export const MAX_RUNTIME_MODEL_ID_CHARS = 512
export const MAX_RUNTIME_EXTRA_VISION_MODELS = 256
export const MAX_RUNTIME_WRAPPED_PROVIDER_ROWS = 32
export const MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER = 128
export const MAX_RUNTIME_COMPLEX_FIELD_BYTES = 256 * 1024
export const RETIRED_RUNTIME_CONFIG_KEYS = Object.freeze([
  'visionGuideStep',
  'instantDescribe',
  'localDescribeStyle',
])

const MAX_RUNTIME_EXTRA_SCAN_ITEMS = MAX_RUNTIME_EXTRA_VISION_MODELS * 4
const MAX_RUNTIME_WRAPPED_PROVIDER_SCAN_ITEMS = MAX_RUNTIME_WRAPPED_PROVIDER_ROWS * 4
const MAX_RUNTIME_WRAPPED_MODEL_SCAN_ITEMS = MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER * 4

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RUNTIME_MODEL_ID_CHARS
}

function identifierBytes(value) {
  return Buffer.byteLength(value, 'utf8')
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

function boundedIdentifiers(value, { maxEntries, maxBytes, scanItems }) {
  if (!Array.isArray(value)) return { values: [], bytes: 0 }
  const values = []
  let bytes = 0
  const inspected = Math.min(value.length, scanItems)
  for (let index = 0; index < inspected; index += 1) {
    const entry = value[index]
    if (!validIdentifier(entry)) continue
    const weight = identifierBytes(entry)
    if (weight > maxBytes - bytes) break
    values.push(entry)
    bytes += weight
    if (values.length >= maxEntries) break
  }
  return { values, bytes }
}

function normalizeExtraVisionModels(value) {
  return boundedIdentifiers(value, {
    maxEntries: MAX_RUNTIME_EXTRA_VISION_MODELS,
    maxBytes: MAX_RUNTIME_COMPLEX_FIELD_BYTES,
    scanItems: MAX_RUNTIME_EXTRA_SCAN_ITEMS,
  }).values
}

function normalizeWrappedProviders(value) {
  if (!Array.isArray(value)) return []
  const out = []
  let bytes = 0
  const inspected = Math.min(value.length, MAX_RUNTIME_WRAPPED_PROVIDER_SCAN_ITEMS)
  for (let index = 0; index < inspected; index += 1) {
    const entry = value[index]
    if (!plainObject(entry) || !validIdentifier(entry.provider) || !Array.isArray(entry.models)) continue
    const providerBytes = identifierBytes(entry.provider)
    if (providerBytes > MAX_RUNTIME_COMPLEX_FIELD_BYTES - bytes) break

    const models = boundedIdentifiers(entry.models, {
      maxEntries: MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER,
      maxBytes: MAX_RUNTIME_COMPLEX_FIELD_BYTES - bytes - providerBytes,
      scanItems: MAX_RUNTIME_WRAPPED_MODEL_SCAN_ITEMS,
    })
    // An explicit non-empty model scope must never become the broader "all
    // models" scope merely because malformed/oversized values were dropped.
    if (entry.models.length > 0 && models.values.length === 0) continue

    out.push({
      ...entry,
      provider: entry.provider,
      models: models.values,
    })
    bytes += providerBytes + models.bytes
    if (out.length >= MAX_RUNTIME_WRAPPED_PROVIDER_ROWS || bytes >= MAX_RUNTIME_COMPLEX_FIELD_BYTES) break
  }
  return out
}

/**
 * Return a resource-budget error for complex settings fields, or undefined
 * when this layer has no budget objection. Structural/type validation remains
 * owned by the settings schema; this helper exists so remote admission and
 * runtime normalization share the same resource contract without making old
 * persisted profiles fail to load.
 */
export function runtimeConfigFieldBudgetError(field, value) {
  if (field === 'extraVisionModels') {
    if (!Array.isArray(value)) return undefined
    if (value.length > MAX_RUNTIME_EXTRA_VISION_MODELS) {
      return `extraVisionModels may contain at most ${MAX_RUNTIME_EXTRA_VISION_MODELS} entries`
    }
    let bytes = 0
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      if (entry.length > MAX_RUNTIME_MODEL_ID_CHARS) {
        return `extraVisionModels entries may contain at most ${MAX_RUNTIME_MODEL_ID_CHARS} characters`
      }
      bytes += identifierBytes(entry)
      if (bytes > MAX_RUNTIME_COMPLEX_FIELD_BYTES) {
        return `extraVisionModels exceeds the ${MAX_RUNTIME_COMPLEX_FIELD_BYTES}-byte runtime budget`
      }
    }
    return undefined
  }

  if (field === 'wrappedProviders') {
    if (!Array.isArray(value)) return undefined
    if (value.length > MAX_RUNTIME_WRAPPED_PROVIDER_ROWS) {
      return `wrappedProviders may contain at most ${MAX_RUNTIME_WRAPPED_PROVIDER_ROWS} provider rows`
    }
    let bytes = 0
    for (const entry of value) {
      if (!plainObject(entry)) continue
      if (typeof entry.provider === 'string') {
        if (entry.provider.length > MAX_RUNTIME_MODEL_ID_CHARS) {
          return `wrappedProviders provider ids may contain at most ${MAX_RUNTIME_MODEL_ID_CHARS} characters`
        }
        bytes += identifierBytes(entry.provider)
      }
      if (Array.isArray(entry.models)) {
        if (entry.models.length > MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER) {
          return `wrappedProviders rows may contain at most ${MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER} models`
        }
        for (const model of entry.models) {
          if (typeof model !== 'string') continue
          if (model.length > MAX_RUNTIME_MODEL_ID_CHARS) {
            return `wrappedProviders model ids may contain at most ${MAX_RUNTIME_MODEL_ID_CHARS} characters`
          }
          bytes += identifierBytes(model)
          if (bytes > MAX_RUNTIME_COMPLEX_FIELD_BYTES) {
            return `wrappedProviders exceeds the ${MAX_RUNTIME_COMPLEX_FIELD_BYTES}-byte runtime budget`
          }
        }
      }
      if (bytes > MAX_RUNTIME_COMPLEX_FIELD_BYTES) {
        return `wrappedProviders exceeds the ${MAX_RUNTIME_COMPLEX_FIELD_BYTES}-byte runtime budget`
      }
    }
  }
  return undefined
}

/**
 * Normalize only bounded runtime-facing fields. Settings normally validates
 * these through Schemastery, but direct apply() callers, migrations, corrupted
 * profile data, or a future settings bridge can still hand runtime code a
 * structurally invalid object.
 *
 * routingMode/routingPreference are product semantics rather than executor
 * implementation toggles. Unknown fields from older settings documents are
 * preserved by the Host but do not influence these product controls.
 *
 * The three retired UI-era keys are deliberately stripped here. Their schema
 * tombstones remain temporarily load-tolerant for 1.7.x profiles while the
 * settings migration removes persisted overrides; user values can no longer
 * reach live runtime decisions.
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

  const {
    visionGuideStep: _visionGuideStep,
    instantDescribe: _instantDescribe,
    localDescribeStyle: _localDescribeStyle,
    ...active
  } = source

  return {
    ...active,
    providers,
    fallbacks: normalizeFallbacks(source.fallbacks),
    extraVisionModels: normalizeExtraVisionModels(source.extraVisionModels),
    wrappedProviders: normalizeWrappedProviders(source.wrappedProviders),
    routingMode: normalizeVisionRoutingMode(source.routingMode),
    routingPreference: normalizeVisionRoutingPreference(source.routingPreference),
  }
}

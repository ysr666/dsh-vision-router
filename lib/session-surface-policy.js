import { currentSessionVisionPolicy } from './native-image-coexistence.js'

const OWNERSHIP = Object.freeze({
  PLUGIN_OWNED: 'vision-router-owned',
  NATIVE: 'native-image',
  TEXT_ONLY: 'text-only',
  UNKNOWN: 'unknown',
})

const KNOWN_OWNERSHIP = new Set(Object.values(OWNERSHIP))

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizedOwnership(policy) {
  if (!isObject(policy)) return undefined
  return KNOWN_OWNERSHIP.has(policy.ownership) ? policy.ownership : OWNERSHIP.UNKNOWN
}

/**
 * Resolve one immutable, read-only snapshot of the Vision Router capability
 * surface for the current session.
 *
 * This layer does not classify model capability and does not grant authority.
 * `visionPolicy` is evidence produced by native-image-coexistence; this module
 * only projects that already-authoritative ownership decision onto the legacy
 * configuration/surface questions that used to be answered in several places.
 *
 * Durable transcript invariant: once a real session policy exists, Core may
 * observe/index image blocks but may never replace a user-owned image message
 * before the Agent loop appends it to the Session log. Image projection belongs
 * at the adapter/request boundary. The historical `rewriteCurrentImages` bit is
 * therefore intentionally ignored even when an older policy producer still
 * exposes it; the compatibility field below is permanently false.
 */
export function resolveSessionSurfacePolicy({
  visionPolicy,
  config = {},
  schemaBootstrapping = false,
} = {}) {
  const source = isObject(visionPolicy) ? visionPolicy : undefined
  const value = isObject(config) ? config : {}
  const ownership = normalizedOwnership(source)
  const native = ownership === OWNERSHIP.NATIVE
  const pluginOwned = ownership === OWNERSHIP.PLUGIN_OWNED
  const textOnly = ownership === OWNERSHIP.TEXT_ONLY

  // No active session policy means no session-specific preservation authority.
  // During a real pre-step, every ownership result — including explicit
  // text-only and unknown — preserves the durable user message unchanged.
  const preserveRawImages = source !== undefined
  const rewriteCurrentImages = false
  const allowStructuredBootstrap = source?.allowStructuredBootstrap !== false
  const allowGenericAutoMount = source?.suppressGenericAutoMount !== true

  const surface = Object.freeze({
    preserveRawImages,
    rewriteCurrentImages,
    visionTools: value.tool !== false,
    structuredBootstrap:
      value.structuredVisionBootstrap === true && allowStructuredBootstrap,
    genericAutoMount:
      value.autoActivateOnImage !== false && allowGenericAutoMount,
    instantDescribe:
      value.instantDescribe !== false && !native,
  })

  const overrides = {}
  if (schemaBootstrapping === true && value.tool === false) overrides.tool = true
  // Core's historical rewriteImages switch controls an agent/pre-step message
  // transform. Disable it for every real session policy so neither current nor
  // historical user image blocks can be persisted as internal attachment text.
  // Vision Router-owned adapters still perform their private request projection.
  if (source !== undefined && value.rewriteImages !== false) overrides.rewriteImages = false
  if (native && value.instantDescribe !== false) overrides.instantDescribe = false
  if (native && value.autoActivateOnImage !== false) overrides.autoActivateOnImage = false
  if (!allowStructuredBootstrap && value.structuredVisionBootstrap !== false) {
    overrides.structuredVisionBootstrap = false
  }

  return Object.freeze({
    ownership,
    participates:
      source !== undefined && (
        pluginOwned ||
        textOnly ||
        surface.visionTools ||
        surface.structuredBootstrap ||
        surface.genericAutoMount
      ),
    preserveRawImages,
    rewriteCurrentImages,
    allowStructuredBootstrap,
    allowGenericAutoMount,
    surface,
    legacyConfigOverrides: Object.freeze(overrides),
  })
}

/** Read the turn-local ownership snapshot and resolve its capability surface. */
export function currentSessionSurfacePolicy(config = {}, options = {}) {
  return resolveSessionSurfacePolicy({
    visionPolicy: currentSessionVisionPolicy(),
    config,
    schemaBootstrapping: options?.schemaBootstrapping === true,
  })
}

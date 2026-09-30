import { currentSessionVisionPolicy } from './native-image-coexistence.js'
import { currentSessionVisionModeAuthority } from './session-vision-mode-authority.js'

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
 * Image ownership and Vision-mode authority are intentionally distinct. The
 * native-image policy answers who can consume raw pixels; the mode authority
 * answers whether this Session explicitly selected a Vision Router-owned
 * wrapper/twin for the current step. Only the latter can grant plugin tools or
 * automatic visual work. This prevents a historical image, a native multimodal
 * source model, or a stale request header from silently turning Vision back on.
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
  visionModeAuthority,
  config = {},
  schemaBootstrapping = false,
} = {}) {
  const source = isObject(visionPolicy) ? visionPolicy : undefined
  const authority = isObject(visionModeAuthority) ? visionModeAuthority : undefined
  const value = isObject(config) ? config : {}
  const ownership = normalizedOwnership(source)
  const pluginOwned = ownership === OWNERSHIP.PLUGIN_OWNED

  // During schema bootstrap there is no real Session policy, so global Settings
  // still decide which definitions Core registers. During a real step, an
  // explicit authority snapshot wins; direct helper callers fall back to the
  // already-classified plugin ownership instead of inventing an enabled mode.
  const visionModeEnabled = authority !== undefined
    ? authority.enabled === true
    : source === undefined
      ? true
      : pluginOwned

  // No active session policy means no session-specific preservation authority.
  // During a real pre-step, every ownership result — including explicit
  // text-only and unknown — preserves the durable user message unchanged.
  const preserveRawImages = source !== undefined
  const rewriteCurrentImages = false
  const allowStructuredBootstrap = visionModeEnabled
  const allowGenericAutoMount = visionModeEnabled

  const surface = Object.freeze({
    preserveRawImages,
    rewriteCurrentImages,
    visionTools: value.tool !== false && visionModeEnabled,
    structuredBootstrap:
      value.structuredVisionBootstrap === true && visionModeEnabled,
    genericAutoMount:
      value.autoActivateOnImage !== false && visionModeEnabled,
    instantDescribe:
      value.instantDescribe !== false && visionModeEnabled,
  })

  const overrides = {}
  if (schemaBootstrapping === true && source === undefined && value.tool === false) {
    overrides.tool = true
  }
  // Core's historical rewriteImages switch controls an agent/pre-step message
  // transform. Disable it for every real session policy so neither current nor
  // historical user image blocks can be persisted as internal attachment text.
  // Vision Router-owned adapters still perform their private request projection.
  if (source !== undefined && value.rewriteImages !== false) overrides.rewriteImages = false

  // The composer/model selection is the Session authority. When it is OFF,
  // suppress every automatic/plugin-owned visual surface while preserving the
  // durable image itself. Settings remain unchanged; these are turn-local Core
  // projections only.
  if (source !== undefined && !visionModeEnabled) {
    if (value.tool !== false) overrides.tool = false
    if (value.instantDescribe !== false) overrides.instantDescribe = false
    if (value.autoActivateOnImage !== false) overrides.autoActivateOnImage = false
    if (value.structuredVisionBootstrap !== false) overrides.structuredVisionBootstrap = false
  }

  return Object.freeze({
    ownership,
    visionModeEnabled,
    participates: source !== undefined,
    preserveRawImages,
    rewriteCurrentImages,
    allowStructuredBootstrap,
    allowGenericAutoMount,
    surface,
    legacyConfigOverrides: Object.freeze(overrides),
  })
}

/** Read the turn-local ownership + mode snapshots and resolve the Core surface. */
export function currentSessionSurfacePolicy(config = {}, options = {}) {
  return resolveSessionSurfacePolicy({
    visionPolicy: currentSessionVisionPolicy(),
    visionModeAuthority: currentSessionVisionModeAuthority(),
    config,
    schemaBootstrapping: options?.schemaBootstrapping === true,
  })
}

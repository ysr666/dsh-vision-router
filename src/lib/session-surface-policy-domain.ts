export type SessionImageOwnership =
  | 'vision-router-owned'
  | 'native-image'
  | 'text-only'
  | 'unknown'

export type SessionSurfaceConfigKey =
  | 'tool'
  | 'rewriteImages'
  | 'instantDescribe'
  | 'autoActivateOnImage'
  | 'structuredVisionBootstrap'

export interface SessionSurfaceCapabilities {
  readonly preserveRawImages: boolean
  readonly rewriteCurrentImages: false
  readonly visionTools: boolean
  readonly structuredBootstrap: boolean
  readonly genericAutoMount: boolean
  readonly instantDescribe: boolean
}

export interface SessionSurfacePolicy {
  readonly ownership: SessionImageOwnership | undefined
  readonly visionModeEnabled: boolean
  readonly participates: boolean
  readonly preserveRawImages: boolean
  readonly rewriteCurrentImages: false
  readonly allowStructuredBootstrap: boolean
  readonly allowGenericAutoMount: boolean
  readonly surface: Readonly<SessionSurfaceCapabilities>
  readonly legacyConfigOverrides: Readonly<
    Partial<Record<SessionSurfaceConfigKey, boolean>>
  >
}

export interface ResolveSessionSurfacePolicyOptions {
  readonly visionPolicy?: unknown
  readonly visionModeAuthority?: unknown
  readonly config?: unknown
  readonly schemaBootstrapping?: boolean
}

type UnknownRecord = Record<PropertyKey, unknown>

const OWNERSHIP = Object.freeze({
  PLUGIN_OWNED: 'vision-router-owned',
  NATIVE: 'native-image',
  TEXT_ONLY: 'text-only',
  UNKNOWN: 'unknown',
} as const)

const KNOWN_OWNERSHIP = new Set<SessionImageOwnership>(
  Object.values(OWNERSHIP),
)

function objectRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function normalizedOwnership(
  policy: unknown,
): SessionImageOwnership | undefined {
  const source = objectRecord(policy)
  if (source === undefined) return undefined
  return typeof source.ownership === 'string'
    && KNOWN_OWNERSHIP.has(source.ownership as SessionImageOwnership)
    ? source.ownership as SessionImageOwnership
    : OWNERSHIP.UNKNOWN
}

/**
 * Resolve one immutable Core-facing capability snapshot for the current Session.
 *
 * Image ownership and Vision-mode authority remain separate facts. Durable
 * transcript preservation is fail-safe: every real Session policy preserves
 * the user-owned image, while the step authority alone decides whether DVR
 * automatic/tool surfaces are active.
 */
export function resolveSessionSurfacePolicy({
  visionPolicy,
  visionModeAuthority,
  config = {},
  schemaBootstrapping = false,
}: ResolveSessionSurfacePolicyOptions = {}): SessionSurfacePolicy {
  const source = objectRecord(visionPolicy)
  const authority = objectRecord(visionModeAuthority)
  const value = objectRecord(config) ?? {}
  const ownership = normalizedOwnership(source)
  const pluginOwned = ownership === OWNERSHIP.PLUGIN_OWNED

  const visionModeEnabled = authority !== undefined
    ? authority.enabled === true
    : source === undefined
      ? true
      : pluginOwned

  const preserveRawImages = source !== undefined
  const rewriteCurrentImages = false as const
  const allowStructuredBootstrap = visionModeEnabled
  const allowGenericAutoMount = visionModeEnabled

  const surface: Readonly<SessionSurfaceCapabilities> = Object.freeze({
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

  const overrides: Partial<Record<SessionSurfaceConfigKey, boolean>> = {}

  if (
    schemaBootstrapping === true
    && source === undefined
    && value.tool === false
  ) {
    overrides.tool = true
  }

  if (source !== undefined && value.rewriteImages !== false) {
    overrides.rewriteImages = false
  }

  if (source !== undefined && !visionModeEnabled) {
    if (value.tool !== false) overrides.tool = false
    if (value.instantDescribe !== false) overrides.instantDescribe = false
    if (value.autoActivateOnImage !== false) {
      overrides.autoActivateOnImage = false
    }
    if (value.structuredVisionBootstrap !== false) {
      overrides.structuredVisionBootstrap = false
    }
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

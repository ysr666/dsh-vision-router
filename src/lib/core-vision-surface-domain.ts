import {
  resolveSessionSurfacePolicy,
  type SessionImageOwnership,
  type SessionSurfacePolicy,
} from './session-surface-policy-domain.js'

export const CORE_VISION_SURFACE_KEYS = [
  'tool',
  'rewriteImages',
  'instantDescribe',
  'autoActivateOnImage',
  'structuredVisionBootstrap',
] as const

export type CoreVisionSurfaceKey =
  (typeof CORE_VISION_SURFACE_KEYS)[number]

export type CoreVisionSurfaceValues =
  Readonly<Record<CoreVisionSurfaceKey, unknown>>

export interface CoreVisionSurface {
  readonly ownership: SessionImageOwnership | undefined
  readonly preserveRawImages: boolean
  readonly rewriteCurrentImages: boolean
  readonly toolAvailable: boolean
  readonly rewriteEnabled: boolean
  readonly instantDescribe: boolean
  readonly autoActivateOnImage: boolean
  readonly structuredBootstrap: boolean
  readonly values: CoreVisionSurfaceValues
}

export interface ResolveCoreVisionSurfaceOptions {
  readonly visionPolicy?: unknown
  readonly config?: unknown
  readonly schemaBootstrapping?: boolean
}

type UnknownRecord = Record<PropertyKey, unknown>

function objectRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function own(object: UnknownRecord, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function coreFlags(
  values: CoreVisionSurfaceValues,
): Pick<
  CoreVisionSurface,
  | 'toolAvailable'
  | 'rewriteEnabled'
  | 'instantDescribe'
  | 'autoActivateOnImage'
  | 'structuredBootstrap'
> {
  return {
    toolAvailable: values.tool !== false,
    rewriteEnabled: values.rewriteImages !== false,
    instantDescribe: values.instantDescribe === true,
    autoActivateOnImage: values.autoActivateOnImage !== false,
    structuredBootstrap: values.structuredVisionBootstrap === true,
  }
}

/**
 * Explicit Core-facing projection of SessionSurfacePolicy.
 *
 * Only the five historical Core switches cross this boundary. Unrelated plugin
 * Settings cannot masquerade as a Core config/Settings object.
 */
export function projectCoreVisionSurface(
  config: unknown = {},
  sessionPolicy?: SessionSurfacePolicy | unknown,
): CoreVisionSurface {
  const value = objectRecord(config) ?? {}
  const policyRecord = objectRecord(sessionPolicy)
  const policy = policyRecord !== undefined
    ? policyRecord
    : resolveSessionSurfacePolicy({ config: value })
  const overrides = objectRecord(policy.legacyConfigOverrides) ?? {}
  const projected = {} as Record<CoreVisionSurfaceKey, unknown>

  for (const key of CORE_VISION_SURFACE_KEYS) {
    projected[key] = own(overrides, key)
      ? overrides[key]
      : value[key]
  }

  const values = Object.freeze(projected) as CoreVisionSurfaceValues

  return Object.freeze({
    ownership:
      typeof policy.ownership === 'string'
        ? policy.ownership as SessionImageOwnership
        : undefined,
    preserveRawImages: policy.preserveRawImages === true,
    rewriteCurrentImages: policy.rewriteCurrentImages === true,
    ...coreFlags(values),
    values,
  })
}

export function resolveCoreVisionSurface({
  visionPolicy,
  config = {},
  schemaBootstrapping = false,
}: ResolveCoreVisionSurfaceOptions = {}): CoreVisionSurface {
  const value = objectRecord(config) ?? {}
  return projectCoreVisionSurface(
    value,
    resolveSessionSurfacePolicy({
      visionPolicy,
      config: value,
      schemaBootstrapping,
    }),
  )
}

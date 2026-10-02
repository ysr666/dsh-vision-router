import '@deepseek-ai/schemastery'

export const name: 'vision-router'
export const inject: readonly ['tools', 'llm']
export const SETTINGS_CONTRACT_REVISION: 7

export const Config: Schemastery<
  Record<string, unknown>,
  Record<string, unknown>
>

/**
 * Minimum Cordis shape the plugin requires at the package root.
 *
 * Every supported DSH Host line mounts a Cordis lifecycle context, so this is a
 * precondition rather than an optional capability: cords are installed through
 * `ctx.effect()`, and a generation that cannot own its cleanup is refused
 * instead of publishing routes, wrappers or global mutations without an owner.
 */
export interface CordisLifecycleContext {
  readonly effect: (...args: any[]) => unknown
}

/**
 * Install the plugin on a Cordis plugin context.
 *
 * @param ctx Host plugin context. Must expose `effect()`, otherwise a
 *   `TypeError` is thrown before anything is published.
 * @throws {TypeError} when `ctx.effect` is not callable.
 */
export function apply(
  ctx: CordisLifecycleContext,
  config?: Record<string, unknown>,
): unknown

export interface LegacySessionSurfaceReplacementIntent {
  readonly surfaceOp: Readonly<{
    op: 'replace'
    start: number
    end: number
  }>
  readonly sourceEventSeqs: readonly [number]
}

export interface CurrentSessionSurfaceReplacementIntent {
  readonly surfaceOp: Readonly<{
    op: 'replace'
    startSeq: number
    endSeq: number
  }>
  readonly sourceEventSeqs: readonly [number]
}

export type SessionSurfaceReplacementIntent =
  | LegacySessionSurfaceReplacementIntent
  | CurrentSessionSurfaceReplacementIntent

/**
 * Build the Host-owned Session surface replacement intent for one exact node.
 *
 * @param seq Non-negative safe integer sequence number. `-0`, fractional,
 *   `NaN` and `Infinity` are rejected.
 * @throws {TypeError} when `seq` is not a non-negative safe integer.
 */
export function sessionSurfaceReplacementIntent(
  session: unknown,
  seq: number,
): SessionSurfaceReplacementIntent | undefined

export interface VisionAttachmentAdmissionLogger {
  info?: (message: string, ...args: unknown[]) => unknown
  warn?: (message: string, ...args: unknown[]) => unknown
}

export interface VisionAttachmentAdmissionOptions {
  readonly maxImageDimension?: number
  readonly normalizedImageMaxPixels?: number
  readonly normalizedImageMaxDimension?: number
  readonly normalizedImageMaxBytes?: number
}

export interface VisionAttachmentAdmissionResult {
  readonly changed: boolean
  readonly reason: string
  readonly limits?: Readonly<Record<string, unknown>>
  readonly normalizationPolicy?: Readonly<Record<string, unknown>>
}

export function hasBatchAttachmentContract(ctx: unknown): boolean

export function hostOwnsOfficialDeepSeekProvider(ctx: unknown): boolean

export function ensureVisionAttachmentAdmissionPolicy(
  ctx: unknown,
  logger?: VisionAttachmentAdmissionLogger,
  options?: VisionAttachmentAdmissionOptions,
): VisionAttachmentAdmissionResult

export function installVisionAttachmentAdmissionPolicy(
  ctx: unknown,
  logger?: VisionAttachmentAdmissionLogger,
  options?: VisionAttachmentAdmissionOptions,
): VisionAttachmentAdmissionResult

/**
 * Service reads this helper performs on the given context.
 *
 * `llm` is read through the non-owning `get()` probe when the context provides
 * one; a context without it must not throw on an unresolved `llm` property.
 */
export interface HostOwnershipContext {
  readonly get?: (name: string) => unknown
  readonly llm?: unknown
}

export function protectHostProviderOwnership<Context extends HostOwnershipContext>(
  ctx: Context,
): Context

export interface HostSettingsCompatibilityOptions {
  readonly namespace: string
  readonly Config: unknown
  readonly installSettingsSection?: (
    ctx: unknown,
    namespace: unknown,
    Config: unknown,
    entryConfig: Record<string, unknown>,
    hooks: unknown,
  ) => unknown
}

/** Context shape required to register and own the compatibility settings section. */
export interface HostSettingsCompatibilityContext {
  readonly inject?: (...args: any[]) => unknown
}

/**
 * Present DVR's settings face on Hosts whose Settings service predates the
 * current contract.
 *
 * @throws {TypeError} when `ctx.inject` is not callable, before any settings
 *   section or watcher is registered.
 */
export function installHostSettingsCompatibility<Context extends HostSettingsCompatibilityContext>(
  ctx: Context,
  entryConfig: Record<string, unknown>,
  options: HostSettingsCompatibilityOptions,
): Context

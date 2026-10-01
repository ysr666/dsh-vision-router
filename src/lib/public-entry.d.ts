import '@deepseek-ai/schemastery'

export const name: 'vision-router'
export const inject: readonly ['tools', 'llm']
export const SETTINGS_CONTRACT_REVISION: 7

export const Config: Schemastery<
  Record<string, unknown>,
  Record<string, unknown>
>

export function apply(
  ctx: unknown,
  config?: Record<string, unknown>,
  runtime?: Record<string, unknown>,
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

export function protectHostProviderOwnership<Context>(ctx: Context): Context

export interface HostSettingsCompatibilityOptions {
  readonly namespace?: string
  readonly Config?: unknown
  readonly installSettingsSection?: (
    ctx: unknown,
    namespace: unknown,
    Config: unknown,
    entryConfig: Record<string, unknown>,
    hooks: unknown,
  ) => unknown
}

export function installHostSettingsCompatibility<Context>(
  ctx: Context,
  entryConfig: Record<string, unknown>,
  options?: HostSettingsCompatibilityOptions,
): Context

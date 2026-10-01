import { createHash } from 'node:crypto'
import { capabilityBenchmarkFingerprint } from './vision-capability-benchmark.js'

type UnknownRecord = Record<PropertyKey, unknown>

export interface CapabilityEvidenceIdentityInput {
  readonly provider?: unknown
  readonly model?: unknown
  readonly endpoint?: unknown
  readonly config?: unknown
}

export type VisionCredentialResolutionSource =
  | 'none'
  | 'credentials'
  | 'credentials-miss'
  | 'credentials-error'
  | 'launch-environment'
  | 'launch-environment-miss'
  | 'launch-environment-error'
  | 'ambient'
  | 'ambient-miss'

export interface VisionCredentialResolution {
  readonly required: boolean
  readonly value: string | undefined
  readonly fingerprint: string
  readonly source: VisionCredentialResolutionSource
}

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as UnknownRecord
    : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function contextGetter(ctx: unknown): ((name: string) => unknown) | undefined {
  const get = propertyBag(ctx)?.get
  return typeof get === 'function'
    ? (name: string) => get.call(ctx, name)
    : undefined
}

function credentialValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function visionCredentialFingerprint(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return 'none'
  return `cred_${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
}

/**
 * Capability identity deliberately excludes credential identity.
 *
 * Credentials decide whether a route can be accessed right now; they do not
 * define what the same model deployment is capable of. Deployment/project
 * identity belongs in endpoint/config when it actually changes the served
 * model, never in secret material.
 */
export function capabilityEvidenceFingerprint({
  provider,
  model,
  endpoint,
  config,
}: CapabilityEvidenceIdentityInput = {}): string {
  return capabilityBenchmarkFingerprint({ provider, model, endpoint, config })
}

export async function resolveVisionCredential(
  ctx: unknown,
  ref: unknown,
): Promise<VisionCredentialResolution> {
  const key = nonEmpty(ref)
  if (key === undefined) {
    return {
      required: false,
      value: undefined,
      fingerprint: 'none',
      source: 'none',
    }
  }

  let credentials: unknown
  try {
    credentials = contextGetter(ctx)?.('credentials')
  } catch {
    credentials = undefined
  }
  if (credentials !== undefined) {
    try {
      const resolve = propertyBag(credentials)?.resolve
      const hit = typeof resolve === 'function'
        ? await resolve.call(credentials, key)
        : undefined
      const value = credentialValue(propertyBag(hit)?.value)
      return {
        required: true,
        value,
        fingerprint: value === undefined
          ? 'unresolved'
          : visionCredentialFingerprint(value),
        source: value === undefined ? 'credentials-miss' : 'credentials',
      }
    } catch {
      return {
        required: true,
        value: undefined,
        fingerprint: 'unresolved',
        source: 'credentials-error',
      }
    }
  }

  let launchEnvironment: unknown
  try {
    launchEnvironment = contextGetter(ctx)?.('launchEnvironment')
  } catch {
    return {
      required: true,
      value: undefined,
      fingerprint: 'unresolved',
      source: 'launch-environment-error',
    }
  }
  if (launchEnvironment !== undefined) {
    try {
      const get = propertyBag(launchEnvironment)?.get
      const hit = typeof get === 'function'
        ? get.call(launchEnvironment, key)
        : undefined
      const value = credentialValue(propertyBag(hit)?.value)
      return {
        required: true,
        value,
        fingerprint: value === undefined
          ? 'unresolved'
          : visionCredentialFingerprint(value),
        source: value === undefined
          ? 'launch-environment-miss'
          : 'launch-environment',
      }
    } catch {
      return {
        required: true,
        value: undefined,
        fingerprint: 'unresolved',
        source: 'launch-environment-error',
      }
    }
  }

  const ambient = process.env[key]
  const value = typeof ambient === 'string' && ambient !== '' ? ambient : undefined
  return {
    required: true,
    value,
    fingerprint: value === undefined
      ? 'unresolved'
      : visionCredentialFingerprint(value),
    source: value === undefined ? 'ambient-miss' : 'ambient',
  }
}

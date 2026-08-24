import { createHash } from 'node:crypto'
import { capabilityBenchmarkFingerprint } from './vision-capability-benchmark.js'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function visionCredentialFingerprint(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return 'none'
  return `cred_${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
}

// Capability identity deliberately excludes credential identity. Credentials
// decide whether a route can be accessed right now; they do not define what
// the same model deployment is capable of. Deployment/project identity must
// be represented explicitly in endpoint/config when it actually changes the
// served model, rather than inferred from secret material.
export function capabilityEvidenceFingerprint({
  provider,
  model,
  endpoint,
  config,
} = {}) {
  return capabilityBenchmarkFingerprint({ provider, model, endpoint, config })
}

export async function resolveVisionCredential(ctx, ref) {
  const key = nonEmpty(ref)
  if (key === undefined) return { required: false, value: undefined, fingerprint: 'none', source: 'none' }

  let credentials
  try { credentials = ctx?.get?.('credentials') } catch { credentials = undefined }
  if (credentials !== undefined) {
    try {
      const hit = await credentials?.resolve?.(key)
      const value = hit && typeof hit.value === 'string' && hit.value !== '' ? hit.value : undefined
      return {
        required: true,
        value,
        fingerprint: value === undefined ? 'unresolved' : visionCredentialFingerprint(value),
        source: value === undefined ? 'credentials-miss' : 'credentials',
      }
    } catch {
      return { required: true, value: undefined, fingerprint: 'unresolved', source: 'credentials-error' }
    }
  }

  try {
    const launchEnvironment = ctx?.get?.('launchEnvironment')
    if (launchEnvironment !== undefined) {
      const hit = launchEnvironment?.get?.(key)
      const value = hit && typeof hit.value === 'string' && hit.value !== '' ? hit.value : undefined
      return {
        required: true,
        value,
        fingerprint: value === undefined ? 'unresolved' : visionCredentialFingerprint(value),
        source: value === undefined ? 'launch-environment-miss' : 'launch-environment',
      }
    }
  } catch {
    return { required: true, value: undefined, fingerprint: 'unresolved', source: 'launch-environment-error' }
  }

  const ambient = process.env[key]
  const value = typeof ambient === 'string' && ambient !== '' ? ambient : undefined
  return {
    required: true,
    value,
    fingerprint: value === undefined ? 'unresolved' : visionCredentialFingerprint(value),
    source: value === undefined ? 'ambient-miss' : 'ambient',
  }
}

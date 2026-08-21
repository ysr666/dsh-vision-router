import { createHash } from 'node:crypto'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function visionCredentialFingerprint(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return 'none'
  return `cred_${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
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
        fingerprint: visionCredentialFingerprint(value),
        source: value === undefined ? 'credentials-miss' : 'credentials',
      }
    } catch {
      return { required: true, value: undefined, fingerprint: 'unresolved', source: 'credentials-error' }
    }
  }

  try {
    const launchEnvironment = ctx?.get?.('launchEnvironment')
    const hit = launchEnvironment?.get?.(key)
    const value = hit && typeof hit.value === 'string' && hit.value !== '' ? hit.value : undefined
    if (value !== undefined) {
      return { required: true, value, fingerprint: visionCredentialFingerprint(value), source: 'launch-environment' }
    }
  } catch {
    // Fall through to the legacy ambient environment only when DSH does not
    // expose the credentials seam.
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

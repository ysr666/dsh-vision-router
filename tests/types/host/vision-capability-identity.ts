import {
  capabilityEvidenceFingerprint,
  resolveVisionCredential,
  type CapabilityEvidenceIdentityInput,
  type VisionCredentialResolution,
} from '../../../src/lib/vision-capability-identity.js'

const identity: CapabilityEvidenceIdentityInput = {
  provider: 'p',
  model: 'm',
  endpoint: 'https://example.test/v1',
  config: { api: 'openai' },
}
void capabilityEvidenceFingerprint(identity)

// Capability identity must never accept secret/credential identity.
// @ts-expect-error credentials decide access, not model capability identity
capabilityEvidenceFingerprint({ provider: 'p', model: 'm', credentialFingerprint: 'secret-derived' })

declare const ctx: unknown
const resolution: Promise<VisionCredentialResolution> =
  resolveVisionCredential(ctx, 'API_KEY')
void resolution

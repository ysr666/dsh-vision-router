import { createHash } from 'node:crypto'
import process from 'node:process'

export const CAPABILITY_BENCHMARK_SUITE_REVISION = 5

// Renderer-only fixes must invalidate prior evidence even when the scoring and
// prompt contract (the suite revision) is unchanged.
export const CAPABILITY_BENCHMARK_RENDERER_SCOPE =
  `${process.platform}/${process.arch}-proof-badge-v2`

export interface CapabilityBenchmarkFingerprintInput {
  readonly provider?: unknown
  readonly model?: unknown
  readonly endpoint?: unknown
  readonly config?: unknown
  readonly credentialFingerprint?: unknown
}

function isSensitiveKey(key: unknown): boolean {
  return /(^|[_-])(api[_-]?key|key|token|secret|password|authorization|auth|signature|sig)([_-]|$)/i
    .test(String(key ?? ''))
}

function normalizeEndpoint(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch {
    return raw.replace(/\/+$/, '')
  }
}

function sanitizeFingerprintValue(
  value: unknown,
  keyHint = '',
): unknown {
  if (value === null || value === undefined) return value ?? null
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeFingerprintValue(item))
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSensitiveKey(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [
          key,
          sanitizeFingerprintValue(child, key),
        ]),
    )
  }
  if (
    typeof value === 'string'
    && /(endpoint|base[_-]?url|url)$/i.test(keyHint)
  ) {
    return normalizeEndpoint(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (
    typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'string'
  ) {
    return value
  }
  return String(value)
}

export function capabilityBenchmarkFingerprint({
  provider,
  model,
  endpoint,
  config,
  credentialFingerprint,
}: CapabilityBenchmarkFingerprintInput = {}): string {
  const payload = JSON.stringify({
    schema: 'vision-capability-endpoint-v2',
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
    rendererScope: CAPABILITY_BENCHMARK_RENDERER_SCOPE,
    provider: String(provider ?? '').trim(),
    model: String(model ?? '').trim(),
    endpoint: normalizeEndpoint(endpoint),
    config: sanitizeFingerprintValue(
      config && typeof config === 'object' ? config : null,
    ),
    credentialFingerprint: String(credentialFingerprint ?? 'none'),
  })
  return `ep2_${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`
}

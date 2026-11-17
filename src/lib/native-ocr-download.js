import { createHash } from 'node:crypto'

// A platform entry requires reviewed exact archive identity, notices/SBOM,
// and release provenance. Deliberately empty until that audit is complete
// AND the repository owner explicitly authorizes native asset publication.
// Never substitute a lab bundle, a mutable latest URL or a user URL.
export const APPROVED_NATIVE_OCR_ARCHIVES = Object.freeze({})
const MAX_BYTES = 64 * 1024 * 1024
export function approvedNativeArchive(platform = process.platform, arch = process.arch) {
  return APPROVED_NATIVE_OCR_ARCHIVES[platform + '-' + arch] ?? null
}
function trustedReleaseUrl(url) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    url.hostname === 'github.com' &&
    /^\/ysr666\/dsh-vision-router\/releases\/download\/[a-zA-Z0-9._-]+\/ppocrv6-small-(darwin-arm64|win32-x64)\.tar\.gz$/.test(url.pathname) &&
    !url.search && !url.hash
}
function trustedRedirect(url) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    !url.hash && (trustedReleaseUrl(url) || url.hostname === 'release-assets.githubusercontent.com' || url.hostname === 'objects.githubusercontent.com')
}
export async function downloadVerifiedNativeArchive(entry, {
  fetchImpl = globalThis.fetch,
  signal = AbortSignal.timeout(120_000),
} = {}) {
  if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 128 ||
      entry.bytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))
    throw Error('native OCR download unavailable: no reviewed archive identity')
  let url = new URL(entry.url)
  if (!trustedReleaseUrl(url)) throw Error('untrusted native OCR download source')
  for (let redirects = 0; redirects <= 4; redirects++) {
    const res = await fetchImpl(url, { redirect: 'manual', signal, credentials: 'omit', cache: 'no-store' })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel()
      const loc = res.headers.get('location')
      if (!loc) throw Error('invalid native OCR download redirect')
      url = new URL(loc, url)
      if (!trustedRedirect(url)) throw Error('untrusted native OCR download redirect')
      continue
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      throw Error('native OCR download failed')
    }
    const declared = res.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== entry.bytes)) {
      await res.body.cancel()
      throw Error('native OCR archive size mismatch')
    }
    const reader = res.body.getReader()
    const hash = createHash('sha256')
    const parts = []
    let length = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > entry.bytes) throw Error('native OCR archive exceeds reviewed size')
        hash.update(value)
        parts.push(Buffer.from(value))
      }
      if (length !== entry.bytes || hash.digest('hex') !== entry.sha256)
        throw Error('native OCR archive integrity mismatch')
      return Buffer.concat(parts, length)
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  throw Error('native OCR archive redirect limit exceeded')
}

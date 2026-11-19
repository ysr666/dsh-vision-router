import { createHash } from 'node:crypto'
import { readNativeOcrNpmTarball } from './native-ocr-tar-reader.js'

const moduleFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined

// A platform entry requires reviewed exact archive identity, notices/SBOM,
// and release provenance. Deliberately empty until that audit is complete
// AND the repository owner explicitly authorizes native asset publication.
// Never substitute a lab bundle, a mutable npm dist-tag or a user URL.
// An admitted entry pins both the npm tarball and its exact reviewed inner bundle.
export const APPROVED_NATIVE_OCR_ARCHIVES = Object.freeze({})
const MAX_BYTES = 64 * 1024 * 1024
export function approvedNativeArchive(platform = process.platform, arch = process.arch) {
  return APPROVED_NATIVE_OCR_ARCHIVES[platform + '-' + arch] ?? null
}
export function nativeOcrNpmAssetIdentity(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      url.hostname !== 'registry.npmjs.org' || url.search || url.hash)
    throw Error('untrusted native OCR download source')
  const match = /^\/(dsh-vision-router-ocr-(darwin-arm64|win32-x64))\/-\/\1-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)\.tgz$/.exec(url.pathname)
  if (!match || match[0] !== url.pathname || url.href !== value)
    throw Error('untrusted native OCR download source')
  return { url, name: match[1], target: match[2], version: match[3] }
}

export async function downloadVerifiedNativeArchive(entry, {
  fetchImpl = moduleFetch,
  signal = AbortSignal.timeout(120_000),
} = {}) {
  if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 128 ||
      entry.bytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') ||
      !Number.isSafeInteger(entry.npmBytes) || entry.npmBytes < 128 ||
      entry.npmBytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(entry.npmSha256 ?? ''))
    throw Error('native OCR download unavailable: no reviewed archive identity')
  const identity = nativeOcrNpmAssetIdentity(entry.url)
  let url = identity.url
  for (let redirects = 0; redirects <= 4; redirects++) {
    const res = await fetchImpl(url, { redirect: 'manual', signal, credentials: 'omit', cache: 'no-store' })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel()
      const loc = res.headers.get('location')
      if (!loc) throw Error('invalid native OCR download redirect')
      url = new URL(loc, url)
      if (url.href !== identity.url.href) throw Error('untrusted native OCR download redirect')
      continue
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      throw Error('native OCR download failed')
    }
    const declared = res.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== entry.npmBytes)) {
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
        if (length > entry.npmBytes) throw Error('native OCR archive exceeds reviewed size')
        hash.update(value)
        parts.push(Buffer.from(value))
      }
      if (length !== entry.npmBytes || hash.digest('hex') !== entry.npmSha256)
        throw Error('native OCR npm tarball integrity mismatch')
      const archive = readNativeOcrNpmTarball(Buffer.concat(parts, length), identity)
      if (archive.length !== entry.bytes || createHash('sha256').update(archive).digest('hex') !== entry.sha256)
        throw Error('native OCR inner archive integrity mismatch')
      return archive
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  throw Error('native OCR archive redirect limit exceeded')
}

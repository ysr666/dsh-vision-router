import { createHash } from 'node:crypto'
import { readNativeOcrNpmTarball } from './native-ocr-tar-reader.js'

const moduleFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined

// Owner-published 1.0.0 resource pair; genuine public HTTPS readback passed
// in run 44545420734 (job 135660956937). Both exact inner archives retain their
// original audit metadata. Admission is not legal certification or lowest-OS proof.
// Never substitute a lab bundle, a mutable npm dist-tag or a user URL.
export const APPROVED_NATIVE_OCR_ARCHIVES = Object.freeze({"darwin-arm64":{"url":"https://registry.npmjs.org/dsh-vision-router-ocr-darwin-arm64/-/dsh-vision-router-ocr-darwin-arm64-1.0.0.tgz","bytes":27917268,"sha256":"a5245c2420fa10ab9da124e2f8e308930a202c6239b4711b0dd73c14f29b78cd","npmBytes":27915270,"npmSha256":"905085d59e9daa1dc6c6f9be377f47d59c99aafb82924baff2325a4b9cc17aaa"},"win32-x64":{"url":"https://registry.npmjs.org/dsh-vision-router-ocr-win32-x64/-/dsh-vision-router-ocr-win32-x64-1.0.0.tgz","bytes":35313963,"sha256":"fd5791ed9697dbd32ac59b1025600a8a299d8884c607acf6f977445310734ae0","npmBytes":35312250,"npmSha256":"acca7abc14b92b8d6441ce84e02cb67b18535cc29a57c299425fe16260229c75"}})
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

import { lstat } from 'node:fs/promises'
import { readNativeOcrRegularFile, sameNativeOcrDirectory } from './native-ocr-installation.js'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BLOCK = 512
const MAX_MEMBER = 32 * 1024 * 1024
const MAX_TOTAL = 128 * 1024 * 1024

// Native OCR has a small, fixed set of ASCII regular-file names. Restrict
// output to ordinary ustar records, avoiding PAX/ACL/mtime/owner variation.
function header(name, size) {
  const h = Buffer.alloc(BLOCK)
  const ascii = (value, at, width) => {
    if (Buffer.byteLength(value, 'ascii') > width) throw Error('native OCR tar field overflow')
    h.write(value, at, width, 'ascii')
  }
  const octal = (value, at, width) => ascii(value.toString(8).padStart(width - 1, '0') + '\0', at, width)
  ascii(name, 0, 100)
  octal(/\/worker(?:\.exe)?$/.test(name) ? 0o700 : 0o600, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(size, 124, 12)
  octal(0, 136, 12)
  h.fill(32, 148, 156)
  ascii('0', 156, 1)
  ascii('ustar\0', 257, 6)
  ascii('00', 263, 2)
  ascii(h.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return h
}

export async function deterministicNativeOcrArchive(workspace, names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > 32 ||
    new Set(names).size !== names.length) throw Error('invalid native OCR tar member set')
  const parts = []
  let total = 0
  const roots = new Map()
  for (const name of [...names].sort()) {
    if (typeof name !== 'string' || !/^ppocrv6-small\/(?:models\/)?[A-Za-z0-9._-]+$/.test(name) ||
      name.split('/').some(part => part === '.' || part === '..') || name.length > 100) {
      throw Error('invalid native OCR tar member name')
    }
    const segments = name.split('/')
    for (let i = 0; i < segments.length; i++) {
      const dir = join(workspace, ...segments.slice(0, i))
      const snapshot = await lstat(dir)
      if (!sameNativeOcrDirectory(roots.get(dir) ?? snapshot, snapshot))
        throw Error('invalid native OCR tar directory size or type')
      roots.set(dir, snapshot)
    }
    const file = join(workspace, ...segments)
    const bytes = await readNativeOcrRegularFile(file, Math.min(MAX_MEMBER, MAX_TOTAL - total))
    total += bytes.length
    parts.push(header(name, bytes.length), bytes, Buffer.alloc((BLOCK - bytes.length % BLOCK) % BLOCK))
  }
  for (const [dir, snapshot] of roots) {
    if (!sameNativeOcrDirectory(snapshot, await lstat(dir))) throw Error('native OCR tar directory changed during read')
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  const result = gzipSync(Buffer.concat(parts), { level: 9 })
  // RFC 1952 OS byte is informational; canonicalize it. Node emits zero
  // mtime; explicitly set it to make the invariant visible.
  result.fill(0, 4, 8)
  result[9] = 255
  if (result.length > 64 * 1024 * 1024) throw Error('native OCR archive exceeds installer limit')
  return result
}

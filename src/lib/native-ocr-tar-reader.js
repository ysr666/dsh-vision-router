// Parse the bounded, regular-file-only ustar archives emitted by the native
// OCR staging pipeline. No external tar command or filesystem extraction.
import { gunzipSync } from 'node:zlib'

const BLOCK = 512
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_RAW_BYTES = 128 * 1024 * 1024
const MAX_MEMBER_BYTES = 32 * 1024 * 1024
const MAX_MEMBERS = 32
const NAME = /^ppocrv6-small\/(?:models\/)?[A-Za-z0-9._-]+$/

function fail(message) {
  throw Error('invalid native OCR archive: ' + message)
}

function octal(header, start, length) {
  const value = header.subarray(start, start + length).toString('latin1')
  const stripped = value.replace(/\0[\s\S]*$/, '').trim()
  if (!/^[0-7]+$/.test(stripped)) fail('non-octal tar header field')
  const number = Number.parseInt(stripped, 8)
  if (!Number.isSafeInteger(number)) fail('oversized tar header field')
  return number
}

function tarName(header) {
  const raw = header.subarray(0, 100)
  const end = raw.indexOf(0)
  const name = raw.subarray(0, end < 0 ? raw.length : end).toString('latin1')
  if (!NAME.test(name) || name.split('/').some(part => part === '.' || part === '..') ||
      !header.subarray(345, 500).every(byte => byte === 0)) {
    fail('unreviewed tar member name')
  }
  return name
}

export function readNativeOcrTarArchive(compressed) {
  if (!Buffer.isBuffer(compressed) || compressed.length < 128 ||
      compressed.length > MAX_ARCHIVE_BYTES) fail('compressed archive size')
  let raw
  try {
    raw = gunzipSync(compressed, { maxOutputLength: MAX_RAW_BYTES })
  } catch {
    fail('compressed stream invalid or too large')
  }
  if (raw.length < BLOCK * 3 || raw.length % BLOCK !== 0)
    fail('missing or partial tar trailer')
  const contents = new Map()
  let offset = 0
  let terminated = false
  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) {
      if (offset + BLOCK * 2 > raw.length ||
          !raw.subarray(offset).every(byte => byte === 0))
        fail('nonzero or missing tar trailer')
      terminated = true
      break
    }
    if (contents.size >= MAX_MEMBERS) fail('too many tar members')
    if (!header.subarray(257, 263).equals(Buffer.from('ustar\0')) ||
        !header.subarray(263, 265).equals(Buffer.from('00')))
      fail('unsupported tar format')
    if (header[156] !== 48 && header[156] !== 0)
      fail('nonregular tar entry')
    const checksum = octal(header, 148, 8)
    let computed = 0
    for (let i = 0; i < BLOCK; i++)
      computed += i >= 148 && i < 156 ? 32 : header[i]
    if (checksum !== computed) fail('tar header checksum mismatch')
    const name = tarName(header)
    if (contents.has(name)) fail('duplicate tar member')
    const size = octal(header, 124, 12)
    if (size > MAX_MEMBER_BYTES) fail('tar member too large')
    const start = offset + BLOCK
    const padded = Math.ceil(size / BLOCK) * BLOCK
    if (start + padded > raw.length - BLOCK * 2)
      fail('truncated tar member')
    if (!raw.subarray(start + size, start + padded).every(byte => byte === 0))
      fail('nonzero tar member padding')
    contents.set(name, raw.subarray(start, start + size))
    offset = start + padded
  }
  if (!terminated || contents.size === 0) fail('empty or unterminated tar')
  return contents
}

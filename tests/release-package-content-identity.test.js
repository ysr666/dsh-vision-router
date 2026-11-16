import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { comparePackageTarballs } from '../scripts/release-package-content-identity.mjs'

const execFileAsync = promisify(execFile)

async function tarball(root, name) {
  const output = path.join(root, name)
  await execFileAsync('tar', ['-czf', output, '-C', path.join(root, name + '-src'), 'package'])
  return output
}

async function fixture(root, name, value, timestamp) {
  const base = path.join(root, name + '-src', 'package')
  await mkdir(base, { recursive: true })
  const file = path.join(base, 'index.js')
  await writeFile(file, value)
  await utimes(file, timestamp, timestamp)
  return tarball(root, name)
}

test('package content identity ignores tar metadata but preserves the package file tree', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-release-content-'))
  try {
    const first = await fixture(root, 'first', 'same\n', new Date('2020-01-01T00:00:00Z'))
    const second = await fixture(root, 'second', 'same\n', new Date('2025-01-01T00:00:00Z'))
    const result = await comparePackageTarballs(first, second)
    assert.equal(result.exact, true)
    assert.equal(result.leftManifest.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('package content identity rejects a registry tarball with different package bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-release-content-mismatch-'))
  try {
    const first = await fixture(root, 'first', 'one\n', new Date('2020-01-01T00:00:00Z'))
    const second = await fixture(root, 'second', 'two\n', new Date('2020-01-01T00:00:00Z'))
    const result = await comparePackageTarballs(first, second)
    assert.equal(result.exact, false)
    assert.notDeepEqual(result.leftManifest, result.rightManifest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function tarHeader(name, type, linkTarget = '') {
  // Build a valid ustar entry in memory so the symlink rejection test does
  // not depend on a Unix 'ln' executable or Windows symlink privileges.
  const header = Buffer.alloc(512)
  const field = (text, offset, length) => header.write(text, offset, length, 'ascii')
  field(name, 0, 100)
  field('0000755\0', 100, 8)
  field('0000000\0', 108, 8)
  field('0000000\0', 116, 8)
  field('00000000000\0', 124, 12)
  field('00000000000\0', 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = type.charCodeAt(0)
  field(linkTarget, 157, 100)
  field('ustar\0', 257, 6)
  field('00', 263, 2)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  field(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return header
}

test('package content identity rejects symlink entries without extracting the archive', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-release-content-symlink-'))
  try {
    const archive = path.join(root, 'symlink.tgz')
    const tarBytes = Buffer.concat([
      tarHeader('package/', '5'),
      tarHeader('package/escape', '2', '/etc/passwd'),
      Buffer.alloc(1024),
    ])
    await writeFile(archive, gzipSync(tarBytes))
    await assert.rejects(
      () => comparePackageTarballs(archive, archive),
      /unsupported npm tar entry type/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

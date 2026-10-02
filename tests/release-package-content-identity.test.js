import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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

test('package content identity rejects symlink entries without extracting the archive', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-release-content-symlink-'))
  try {
    const source = path.join(root, 'symlink-src', 'package')
    await mkdir(source, { recursive: true })
    await execFileAsync('ln', ['-s', '/etc/passwd', path.join(source, 'escape')])
    const archive = await tarball(root, 'symlink')
    await assert.rejects(
      () => comparePackageTarballs(archive, archive),
      /unsupported npm tar entry type/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

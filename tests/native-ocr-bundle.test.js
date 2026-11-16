import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { localNativeOcrInstallPaths } from '../src/lib/native-ocr-installation.js'
import { EXPERIMENTAL_OCR_BINARY_SHA256 } from '../src/lib/native-ocr-canary.js'

const installer = resolve('scripts/install-native-ocr.mjs')
const target = process.platform + '-' + process.arch
const isApprovedNativePlatform = target === 'darwin-arm64' || target === 'win32-x64'
const invoke = archive => spawnSync(process.execPath, [installer, '--bundle', archive], {
  encoding: 'utf8', timeout: 45_000,
})
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

test('bundle member validation rejects extra files without extracting them', { skip: !isApprovedNativePlatform }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dvr-ocr-malformed-bundle-'))
  try {
    writeFileSync(join(dir, 'unexpected.txt'), 'SHOULD_NOT_BE_INSTALLED')
    const archive = join(dir, 'unexpected.tar.gz')
    const packed = spawnSync('tar', ['-czf', archive, '-C', dir, 'unexpected.txt'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const result = invoke(archive)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unknown\/missing entries/)
    assert.equal(existsSync(join(homedir(), '.dsh-vision-router', 'ocr', 'ppocrv6-small', 'unexpected.txt')), false)
  } finally { rmSync(dir, { force: true, recursive: true }) }
})

test('verified single-file bundle installs without lab environment or source tree assets', {
  skip: !isApprovedNativePlatform || !process.env.DVR_OCR_PRIVATE_BUNDLE,
}, () => {
  const archive = process.env.DVR_OCR_PRIVATE_BUNDLE
  const result = invoke(archive)
  assert.equal(result.status, 0, result.stderr)
  const installed = localNativeOcrInstallPaths()
  assert.equal(hash(installed.binaryPath), EXPERIMENTAL_OCR_BINARY_SHA256[target])
  for (const name of ['NCNN-LICENSE.txt', 'APACHE-2.0.txt', 'SOURCE-NOTICE.md']) {
    assert.ok(existsSync(join(installed.root, name)), 'missing '+name)
  }
})

test('tampered bundles fail closed and do not modify an installed worker', {
  skip: !isApprovedNativePlatform || !process.env.DVR_OCR_PRIVATE_BUNDLE,
}, () => {
  const install = localNativeOcrInstallPaths()
  const before = hash(install.binaryPath)
  const dir = mkdtempSync(join(tmpdir(), 'dvr-ocr-corrupt-'))
  try {
    const bytes = Buffer.from(readFileSync(process.env.DVR_OCR_PRIVATE_BUNDLE))
    bytes[Math.floor(bytes.length / 2)] ^= 0xFF
    const archive = join(dir, 'tampered.tar.gz')
    writeFileSync(archive, bytes)
    const run = invoke(archive)
    assert.notEqual(run.status, 0)
    assert.equal(hash(install.binaryPath), before)
  } finally { rmSync(dir, { force:true, recursive:true }) }
})

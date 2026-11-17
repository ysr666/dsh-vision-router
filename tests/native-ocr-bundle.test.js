import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { localNativeOcrInstallPaths } from '../src/lib/native-ocr-installation.js'
import { EXPERIMENTAL_OCR_BINARY_SHA256 } from '../src/lib/native-ocr-canary.js'
import { nativeBundleLicenseFiles, readVerifiedNativeBundleLicense } from '../src/lib/native-ocr-bundle-metadata.js'

const installer = resolve('scripts/install-native-ocr.mjs')
const target = process.platform + '-' + process.arch
const isApprovedNativePlatform = target === 'darwin-arm64' || target === 'win32-x64'
const invoke = archive => spawnSync(process.execPath, [installer, '--bundle', archive], {
  encoding: 'utf8', timeout: 45_000,
})
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

test('native package creation rejects stale CRLF and changed canonical license sources', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'dvr-ocr-stale-checkout-'))
  try {
    for (const [name] of nativeBundleLicenseFiles('win32')) {
      const original = await readVerifiedNativeBundleLicense(resolve('.'), name)
      const file = join(fixture, name)
      mkdirSync(resolve(file, '..'), { recursive: true })
      writeFileSync(file, original)
      assert.deepEqual(await readVerifiedNativeBundleLicense(fixture, name), original)
      writeFileSync(file, Buffer.concat([original, Buffer.from('changed')]))
      await assert.rejects(readVerifiedNativeBundleLicense(fixture, name), /canonical license source mismatch/)
      if (name === 'LICENSE' || name === 'assets/licenses/apache-2.0.txt') {
        writeFileSync(file, original.toString('utf8').replace(/\n/g, '\r\n'))
        await assert.rejects(readVerifiedNativeBundleLicense(fixture, name), /canonical license source mismatch/)
      }
    }
    await assert.rejects(readVerifiedNativeBundleLicense(fixture, '../outside'), /unknown native OCR license source/)
  } finally { rmSync(fixture, { force: true, recursive: true }) }
})

test('Windows runtime attribution is required for new bundles, while prior member sets stay explicit', () => {
  const names = opts => nativeBundleLicenseFiles('win32', opts).map(([,name]) => name)
  const old = names({includeSourceNotices:false,includeRuntimeNotices:false,includePaddleLicense:false})
  const source = names({includeSourceNotices:true,includeRuntimeNotices:false,includePaddleLicense:false})
  const v2 = names({includePaddleLicense:false})
  const current = names()
  assert.ok(!old.includes('MINGW-SOURCE-NOTICES.txt'))
  assert.deepEqual(source.filter(name => !old.includes(name)), ['MINGW-SOURCE-NOTICES.txt'])
  assert.deepEqual(v2.filter(name => !source.includes(name)), ['WINDOWS-RUNTIME-NOTICES.txt'])
  assert.deepEqual(current.filter(name => !v2.includes(name)), ['PADDLEOCR-LICENSE.txt'])
  assert.ok(nativeBundleLicenseFiles('darwin').some(([,name]) => name === 'PADDLEOCR-LICENSE.txt'))
  for (const name of ['LLVM-LICENSE.txt','MINGW-RUNTIME-COPYING.txt']) assert.ok(old.includes(name))
  assert.ok(!nativeBundleLicenseFiles('darwin').some(([,name]) => name === 'WINDOWS-RUNTIME-NOTICES.txt'))
})

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
  for (const name of ['NCNN-LICENSE.txt', 'APACHE-2.0.txt', 'PADDLEOCR-LICENSE.txt', 'SOURCE-NOTICE.md']) {
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

test('bundle metadata is verified and upgraded to v3, and cannot be replaced by archive-supplied claims', {
  skip: !isApprovedNativePlatform || !process.env.DVR_OCR_PRIVATE_BUNDLE,
}, () => {
  const archive = process.env.DVR_OCR_PRIVATE_BUNDLE
  const installed = localNativeOcrInstallPaths()
  const before = hash(installed.binaryPath)
  const manifest = JSON.parse(readFileSync(join(installed.root, 'MANIFEST.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 3)
  assert.equal(manifest.files['PADDLEOCR-LICENSE.txt'].sha256, hash(join(installed.root, 'PADDLEOCR-LICENSE.txt')))
  assert.equal(manifest.distributionReady, false)
  const sbom = JSON.parse(readFileSync(join(installed.root, 'SBOM.cdx.json'), 'utf8'))
  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.equal(sbom.compositions[0].aggregate, 'incomplete')
  assert.ok(existsSync(join(installed.root, 'PROJECT-LICENSE.txt')))
  if (process.platform === 'win32') {
    assert.ok(existsSync(join(installed.root, 'MINGW-SOURCE-NOTICES.txt')))
    assert.equal(manifest.files['MINGW-SOURCE-NOTICES.txt'].sha256, hash(join(installed.root, 'MINGW-SOURCE-NOTICES.txt')))
    assert.equal(manifest.files['WINDOWS-RUNTIME-NOTICES.txt'].sha256, hash(join(installed.root, 'WINDOWS-RUNTIME-NOTICES.txt')))
    for (const name of ['libcxx','libcxxabi','libunwind','compiler-rt']) assert.ok(sbom.components.some(c => c['bom-ref'] === 'llvm:' + name))
  }
  const dir = mkdtempSync(join(tmpdir(),'dvr-ocr-notice-tamper-'))
  try {
    const listing = spawnSync('tar',['-tzf',archive],{encoding:'utf8'})
    assert.equal(listing.status,0)
    const members = listing.stdout.trim().split(/\r?\n/)
    // The caller's archive has already passed the installer's validation.
    if (!members.includes('ppocrv6-small/SBOM.cdx.json')) return
    for (const member of members) {
      assert.match(member,/^ppocrv6-small\/(?:models\/)?[A-Za-z0-9._-]+$/)
      assert.ok(!member.endsWith('/..') && !member.endsWith('/.'))
      const output=join(dir,member)
      mkdirSync(resolve(output,'..'),{recursive:true})
      const part=spawnSync('tar',['-xOzf',archive,member],{maxBuffer:32*1024*1024})
      assert.equal(part.status,0)
      writeFileSync(output,part.stdout)
    }
    writeFileSync(join(dir,'ppocrv6-small','SOURCE-NOTICE.md'),'forged notice')
    const bad = join(dir,'notice-tamper.tar.gz')
    const packed = spawnSync('tar',['-czf',bad,'-C',dir,...members],{encoding:'utf8',
      env:{...process.env,COPYFILE_DISABLE:'1'}})
    assert.equal(packed.status,0,packed.stderr)
    const result = invoke(bad)
    assert.notEqual(result.status,0)
    assert.match(result.stderr,/metadata integrity mismatch/)
    assert.equal(hash(installed.binaryPath),before)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('a valid legacy v2 archive imports with the pinned v3 PaddleOCR copyright', {
  skip: !isApprovedNativePlatform || !process.env.DVR_OCR_PREVIOUS_BUNDLE,
}, () => {
  const result = invoke(process.env.DVR_OCR_PREVIOUS_BUNDLE)
  assert.equal(result.status, 0, result.stderr)
  const installed = localNativeOcrInstallPaths()
  const manifest = JSON.parse(readFileSync(join(installed.root, 'MANIFEST.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 3)
  assert.equal(hash(installed.binaryPath), EXPERIMENTAL_OCR_BINARY_SHA256[target])
  assert.equal(hash(join(installed.root, 'PADDLEOCR-LICENSE.txt')), '3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e')
})

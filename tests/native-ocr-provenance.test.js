import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EXPERIMENTAL_OCR_MODEL_FILES } from '../src/lib/native-ocr-integrity.js'
import { EXPERIMENTAL_OCR_BINARY_SHA256 } from '../src/lib/native-ocr-canary.js'

const fixture = fileURLToPath(new URL('../quality/native-ocr-provenance-LAB.json', import.meta.url))
const sha = /^[0-9a-f]{64}$/
const revision = /^[0-9a-f]{40}$/
const load = async () => JSON.parse(await readFile(fixture, 'utf8'))

test('lab model/binary identities match the code integrity gates exactly', async () => {
  const manifest = await load()
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(manifest.nativeAssets, EXPERIMENTAL_OCR_MODEL_FILES)
  const actualBinaries = Object.fromEntries(Object.entries(manifest.experimentalBinaries)
    .map(([target, info]) => [target, info.sha256]))
  assert.deepEqual(actualBinaries, EXPERIMENTAL_OCR_BINARY_SHA256)
  // A buildable architecture is not automatically safe to advertise. In
  // particular Rosetta x64 ran dangerously close to the 21-second budget.
  for (const [target, prototype] of Object.entries(manifest.unadmittedPrototypes ?? {})) {
    assert.match(prototype.sha256, sha)
    assert.equal(prototype.inCanaryAllowlist, false)
    assert.ok(!Object.hasOwn(EXPERIMENTAL_OCR_BINARY_SHA256, target),
      'unqualified prototype must not become an executable canary target')
  }
  for (const value of Object.values(manifest.nativeAssets)) {
    assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0)
    assert.match(value.sha256, sha)
  }
})

test('source provenance is immutable and original converted output is not falsely attested', async () => {
  const manifest = await load()
  for (const item of Object.values(manifest.modelSources)) {
    assert.match(item.revision, revision)
    assert.match(item.sha256, sha)
    assert.equal(item.license, 'Apache-2.0')
    assert.equal(item.onDiskVerified, true,
      'official ONNX source has been SHA-verified in an isolated lab')
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 1_000_000)
    assert.match(item.verifiedOn, /Windows isolated experimental cache/)
    assert.ok(item.licenseEvidence.includes(item.revision))
  }
  assert.match(manifest.dictionary.revision, revision)
  assert.equal(manifest.dictionary.sha256,
    manifest.nativeAssets['ppocrv6_dict.txt'].sha256)
  assert.equal(manifest.dictionary.bytes, manifest.nativeAssets['ppocrv6_dict.txt'].bytes)
  assert.equal(manifest.dictionary.lines, 18708)
  assert.equal(manifest.dictionary.verifiedByteEqualToSource, true)
  assert.equal(manifest.dictionary.license, 'Apache-2.0')
  assert.match(manifest.ncnn.revision, revision)
  assert.equal(manifest.ncnn.license, 'BSD-3-Clause')
  assert.deepEqual(manifest.ncnn.thirdPartyLicenseCategories,
    ['zlib', 'BSD-2-Clause', 'BSD-3-Clause'])
  // Re-running a pinned standalone converter in an isolated directory is
  // stronger than source identity alone, but still NOT a clean signed CI gate.
  const rerun = manifest.conversionReproduction
  assert.equal(rerun.packageVersion, '20261020')
  assert.match(rerun.standaloneWindowsExeSha256, sha)
  assert.deepEqual(rerun.detectorArgs,
    ['inputshape=[1,3,640,640]', 'inputshape2=[1,3,960,960]', 'fp16=0', 'optlevel=2'])
  assert.deepEqual(rerun.recognizerArgs,
    ['inputshape=[1,3,48,320]', 'inputshape2=[1,3,48,640]', 'fp16=0', 'optlevel=2'])
  assert.equal(rerun.fourOutputFilesByteIdentical, true)
  assert.equal(rerun.releaseCiReproducible, false)
  assert.equal(manifest.releaseGates.originalOnnxReacquiredAndVerified, true)
  assert.equal(manifest.releaseGates.conversionReproducedInCleanBuild, false)
})

test('distribution-ready flag cannot be enabled while any release gate remains open', async () => {
  const manifest = await load()
  const checks = Object.values(manifest.releaseGates)
  assert.ok(checks.length >= 5)
  assert.ok(checks.every(v => typeof v === 'boolean'))
  const allClosed = checks.every(Boolean)
  assert.equal(manifest.distributionReady, allClosed)
  assert.equal(manifest.distributionReady, false,
    'lab fixture is not a legal release authorization')
})

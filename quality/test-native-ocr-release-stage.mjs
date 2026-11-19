import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, mkdir, rm, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidates, readCandidateWorker, readCanonicalModels, stageCandidate } from './native-ocr-release-stage.mjs'
import { APPROVED_NATIVE_OCR_ARCHIVES } from '../src/lib/native-ocr-download.js'
import { EXPERIMENTAL_OCR_BINARY_SHA256 } from '../src/lib/native-ocr-canary.js'
import { assertNativePromotionState } from './native-ocr-staged-acceptance.mjs'

test('staging pins cannot be confused with production admission', () => {
  assert.deepEqual(Object.keys(candidates).sort(), ['darwin-arm64', 'win32-x64'])
  assertNativePromotionState(APPROVED_NATIVE_OCR_ARCHIVES, EXPERIMENTAL_OCR_BINARY_SHA256, candidates)
  for (const [target, candidate] of Object.entries(candidates)) {
    assert.match(candidate.workerSha256, /^[0-9a-f]{64}$/)
    assert.ok(Object.hasOwn(EXPERIMENTAL_OCR_BINARY_SHA256, target))
    assert.equal(candidate.minimumOsRuntimeVerified, false)
  }
})
test('wrong candidate and unsupported target fail before creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dvr-stage-negative-'))
  try {
    const binary = join(root, 'worker'), models = join(root, 'models'), out = join(root, 'out')
    await writeFile(binary, 'not an approved executable')
    await mkdir(models)
    await assert.rejects(readCandidateWorker('linux-x64', binary), /unsupported/)
    await assert.rejects(stageCandidate({target:'win32-x64', binary, models, out}), /SHA-256 mismatch/)
    await assert.rejects(lstat(out), {code:'ENOENT'})
    await writeFile(join(models,'det.ncnn.bin'), 'wrong bytes')
    await assert.rejects(readCanonicalModels(models), /canonical model identity mismatch/)
  } finally { await rm(root, {recursive:true, force:true}) }
})
test('worker symlink is not accepted even before digest verification', {skip:process.platform==='win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(),'dvr-stage-link-'))
  try {
    const binary=join(root,'worker'), link=join(root,'link')
    await writeFile(binary,'not a worker')
    await symlink(binary,link)
    await assert.rejects(readCandidateWorker('darwin-arm64',link))
  } finally { await rm(root,{recursive:true,force:true}) }
})

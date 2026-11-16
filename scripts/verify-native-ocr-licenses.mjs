import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = rel => readFileSync(join(root, rel), 'utf8')
const sha256 = text => createHash('sha256').update(text).digest('hex')
const ncnn = read('assets/licenses/ncnn-LICENSE.txt')
assert.equal(sha256(ncnn), '7c974bac98848df46be1af5bdaa3c3c9c01f6082a90f55caeb7f60c6208aa255')
assert.match(ncnn, /BSD 3-Clause License/)
assert.match(ncnn, /zlib License/)
assert.match(ncnn, /BSD 2-Clause License/)
const apache = read('assets/licenses/apache-2.0.txt')
assert.match(apache, /Apache License/)
assert.match(apache, /Version 2\.0, January 2004/)
const llvmLicense = read('assets/licenses/llvm-mingw-LICENSE.txt')
assert.equal(sha256(llvmLicense), '8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee')
assert.match(llvmLicense, /LLVM Exceptions to the Apache 2\.0 License/)
const mingwRuntimeLicense = read('assets/licenses/mingw-w64-runtime-COPYING.txt')
assert.equal(sha256(mingwRuntimeLicense), '1db8da07b436c68833c0673ffee3d9fcb2526047f3820b81661865dfedc79a1f')
assert.match(mingwRuntimeLicense, /MinGW-w64 runtime licensing/)
assert.match(mingwRuntimeLicense, /Headers and IDLs imported from Wine/)
const notice = read('THIRD_PARTY_NOTICES.md')
const provenance = JSON.parse(read('quality/native-ocr-provenance-LAB.json'))
for (const key of ['detector','recognizer']) {
  const model = provenance.modelSources[key]
  assert.equal(model.license,'Apache-2.0')
  assert.match(notice, new RegExp(model.source.split('/')[1]))
  assert.ok(notice.includes(model.revision), 'missing immutable model revision')
}
assert.equal(provenance.dictionary.license, 'Apache-2.0')
assert.ok(notice.includes(provenance.dictionary.revision))
assert.equal(provenance.ncnn.license, 'BSD-3-Clause')
assert.ok(notice.includes(provenance.ncnn.revision))
const windows = provenance.experimentalBinaries['win32-x64']
assert.equal(windows.sha256, '2e4b96a204c34eebe11f117049b1a3b966f43a8402a66065c28773528cd18a33')
assert.equal(windows.stdlibHeaderOverlay.usingLlvmApacheHeaderSha256,
  'ce6e43d79dc89b50208ecf259b1ffd519f5a78cd3a2c7fcaac6386f376b89fef')
assert.equal(windows.stdlibHeaderOverlay.recompiledAffectedNcnnObjects, 549)
assert.equal(windows.stdlibHeaderOverlay.observedUsedToolchainHeaders, 743)
assert.equal(windows.stdlibHeaderOverlay.observedGplLgplHeadersAfterOverlay, 0)
assert.match(windows.linkedSystemDllPolicy, /KERNEL32.*UCRT/)
assert.match(notice, /Public Domain/)
assert.ok(notice.includes('llvm-mingw-LICENSE.txt'))
assert.ok(notice.includes('mingw-w64-runtime-COPYING.txt'))
const pkg = JSON.parse(read('package.json'))
assert.equal(pkg.license, 'MIT')
assert.ok(pkg.files.includes('scripts/install-native-ocr.mjs'))
assert.ok(pkg.files.includes('assets'))
const selection = read('src/lib/native-ocr-installation.js')
assert.ok(selection.includes("target !== 'darwin-arm64' && target !== 'win32-x64'"))
const args = ['pack','--dry-run','--ignore-scripts','--json']
const npm = spawnSync('npm', args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
assert.equal(npm.status, 0, npm.stderr.slice(-400))
const files = JSON.parse(npm.stdout)[0].files.map(f=>f.path)
for (const required of [
  'assets/licenses/ncnn-LICENSE.txt','assets/licenses/apache-2.0.txt',
  'assets/licenses/llvm-mingw-LICENSE.txt','assets/licenses/mingw-w64-runtime-COPYING.txt',
  'scripts/install-native-ocr.mjs','THIRD_PARTY_NOTICES.md',
]) assert.ok(files.includes(required), 'missing license/installer from package: '+required)
assert.equal(files.some(p=>/\.ncnn\.(?:bin|param)$|inference\.onnx|chemistry_user|native-ocr-lab(?:$|\.)|\.exe$|\.dylib$|\.so(?:\.|$)/.test(p)), false,
  'unexpected binary, model or private fixture in npm package')
console.log('NATIVE_OCR_SOURCE_NOTICE_GATE_OK models=Apache-2.0 ncnn=BSD-3-Clause LLVM=Apache-2.0-LLVM-exceptions mingw=ZPL-BSD-Wine-header-LGPL-disclosed npm_native_assets=none mac_arm64=yes windows_x64=review-required')

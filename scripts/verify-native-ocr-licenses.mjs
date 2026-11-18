import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = rel => readFileSync(join(root, rel), 'utf8')
const sha256 = text => createHash('sha256').update(text).digest('hex')
const ncnn = read('assets/licenses/ncnn-LICENSE.txt')
assert.equal(sha256(ncnn), '7c974bac98848df46be1af5bdaa3c3c9c01f6082a90f55caeb7f60c6208aa255')
assert.match(ncnn, /BSD 3-Clause License/)
assert.match(ncnn, /zlib License/)
assert.match(ncnn, /BSD 2-Clause License/)
const apache = read('assets/licenses/apache-2.0.txt')
assert.equal(sha256(apache), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', 'Apache license bytes must match canonical Git blob')
assert.equal(sha256(read('LICENSE')), '8b2f2e8e2e4c41a2d6bdb378dab9ce65cafa602b89ee4b8a5d29d2b5da0b3f93', 'MIT license bytes must match canonical Git blob')
assert.match(apache, /Apache License/)
assert.match(apache, /Version 2\.0, January 2004/)
const paddleLicense = read('assets/licenses/paddleocr-LICENSE.txt')
assert.equal(sha256(paddleLicense), '3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e')
assert.ok(paddleLicense.includes('Copyright (c) 2016 PaddlePaddle Authors. All Rights Reserved.'))
const llvmLicense = read('assets/licenses/llvm-mingw-LICENSE.txt')
assert.equal(sha256(llvmLicense), '8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee')
assert.match(llvmLicense, /LLVM Exceptions to the Apache 2\.0 License/)
const mingwRuntimeLicense = read('assets/licenses/mingw-w64-runtime-COPYING.txt')
assert.equal(sha256(mingwRuntimeLicense), '1db8da07b436c68833c0673ffee3d9fcb2526047f3820b81661865dfedc79a1f')
assert.match(mingwRuntimeLicense, /MinGW-w64 runtime licensing/)
assert.match(mingwRuntimeLicense, /Headers and IDLs imported from Wine/)
const mingwSourceNotice = read('assets/licenses/mingw-w64-source-NOTICES.txt')
assert.equal(sha256(mingwSourceNotice), '3309643038dfc2f927ce46df6ee4db7054c532a8b691b13511ff3fe4a84474e4')
assert.match(mingwSourceNotice, /Upstream DISCLAIMER\.PD/)
const runtimeNotice = read('assets/licenses/windows-native-runtime-NOTICES.txt')
assert.equal(sha256(runtimeNotice), 'ece379f6c048676b389b03d79677289aef3e5fee572b0d45324321ce3a82e006')
for (const name of ['libcxx','libcxxabi','libunwind','compiler-rt']) assert.ok(runtimeNotice.includes('LLVM '+name+' LICENSE.TXT'))
assert.ok(runtimeNotice.includes('mingw-w64-crt/gdtoa/gdtoaimp.h'))
const pthreadNotice = read('assets/licenses/mingw-pthread-signal-NOTICE.txt')
assert.equal(sha256(pthreadNotice), 'fd8f4c0c69cd7a9e7a7d21a40b060f7492170bc231e9c03d220c7c7212798802')
assert.ok(pthreadNotice.includes('Copyright (c) 2013-2016  mingw-w64 project'))
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
// On Windows, npm is a .cmd shim. Node's spawnSync cannot execute it
// without a shell (EINVAL); invoking npm's bundled JS CLI directly avoids
// cmd.exe, shell injection and platform-dependent command discovery.
const onWindows = process.platform === 'win32'
const npmCommand = onWindows ? process.execPath : 'npm'
const npmArgs = onWindows
  ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]
  : args
const npm = spawnSync(npmCommand, npmArgs, { cwd: root, encoding: 'utf8', timeout: 30_000 })
assert.equal(npm.status, 0,
  String(npm.error?.message ?? npm.stderr ?? 'npm pack failed').slice(-400))
const files = JSON.parse(npm.stdout)[0].files.map(f=>f.path)
for (const required of [
  'assets/licenses/ncnn-LICENSE.txt','assets/licenses/apache-2.0.txt','assets/licenses/paddleocr-LICENSE.txt',
  'assets/licenses/llvm-mingw-LICENSE.txt','assets/licenses/mingw-w64-runtime-COPYING.txt',
  'assets/licenses/mingw-w64-source-NOTICES.txt', 'assets/licenses/windows-native-runtime-NOTICES.txt',
  'assets/licenses/mingw-pthread-signal-NOTICE.txt', 'scripts/install-native-ocr.mjs','THIRD_PARTY_NOTICES.md',
]) assert.ok(files.includes(required), 'missing license/installer from package: '+required)
assert.equal(files.some(p=>/\.ncnn\.(?:bin|param)$|inference\.onnx|chemistry_user|native-ocr-lab(?:$|\.)|\.exe$|\.dylib$|\.so(?:\.|$)/.test(p)), false,
  'unexpected binary, model or private fixture in npm package')
console.log('NATIVE_OCR_SOURCE_NOTICE_GATE_OK models=Apache-2.0 ncnn=BSD-3-Clause LLVM=Apache-2.0-LLVM-exceptions mingw=ZPL-BSD-Wine-header-LGPL-disclosed npm_native_assets=none mac_arm64=yes windows_x64=review-required')

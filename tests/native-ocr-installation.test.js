import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { localNativeOcrInstallPaths } from '../src/lib/native-ocr-installation.js'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

test('native OCR local install only allows the two SHA-pinned platform builds', () => {
  for (const [platform, arch] of [
    ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'arm64'],
    ['darwin', 'x64'], ['freebsd', 'arm64'],
  ]) assert.equal(localNativeOcrInstallPaths({ platform, arch, home: '/tmp/unused' }), null)
  const mac = localNativeOcrInstallPaths({ platform: 'darwin', arch: 'arm64', home: '/tmp/owner' })
  assert.equal(mac.root, join('/tmp/owner', '.dsh-vision-router', 'ocr', 'ppocrv6-small'))
  assert.equal(mac.binaryPath, join(mac.root, 'worker'))
  assert.equal(mac.modelDir, join(mac.root, 'models'))
  const windows = localNativeOcrInstallPaths({ platform: 'win32', arch: 'x64', home: '/tmp/owner' })
  assert.equal(windows.root, mac.root)
  assert.equal(windows.binaryPath, join(windows.root, 'worker.exe'))
  assert.equal(windows.modelDir, join(windows.root, 'models'))
})

test('npm package contains installers and notices, but never native binaries or model weights', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('scripts/install-native-ocr.mjs'))
  assert.ok(pkg.files.includes('assets'))
  const command = spawnSync(process.execPath, [new URL('../scripts/install-native-ocr.mjs', import.meta.url).pathname, '--help'], {
    encoding: 'utf8',
  })
  assert.equal(command.status, 0, command.stderr)
  assert.match(command.stdout, /--bundle/)
  assert.match(command.stdout, /--binary.*--models/)
  for (const lic of [
    'ncnn-LICENSE.txt', 'apache-2.0.txt', 'llvm-mingw-LICENSE.txt',
    'mingw-w64-runtime-COPYING.txt',
  ]) assert.equal(existsSync(new URL('../assets/licenses/' + lic, import.meta.url)), true)
})

test('installer denies missing or unsupported artifacts before modifying local state', () => {
  const output = spawnSync(process.execPath, [
    new URL('../scripts/install-native-ocr.mjs', import.meta.url).pathname,
    '--binary', '/tmp/no-worker', '--models', '/tmp/no-models',
  ], { encoding: 'utf8' })
  assert.notEqual(output.status, 0)
})

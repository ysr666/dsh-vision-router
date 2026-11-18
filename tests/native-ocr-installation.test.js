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

test('native ownership check refuses unrelated directories and symbolic links', async () => {
  const { isOwnedNativeOcrDirectory, moveOwnedNativeOcrDirectory, readNativeOcrRegularFile } = await import('../src/lib/native-ocr-installation.js')
  const { mkdtemp, mkdir, writeFile, rm, symlink, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dvr-native-owned-'))
  try {
    await writeFile(join(dir, 'unrelated'), 'must survive')
    assert.equal(await isOwnedNativeOcrDirectory(dir), false)
    await writeFile(join(dir, 'SOURCE-NOTICE.md'), '# Locally installed native OCR assets\nRuntime: Tencent/ncnn @ pinned\n')
    assert.equal(await isOwnedNativeOcrDirectory(dir), true)
    const notice = join(dir, 'SOURCE-NOTICE.md')
    const content = await readFile(notice)
    assert.deepEqual(await readNativeOcrRegularFile(notice, content.length), content)
    await assert.rejects(readNativeOcrRegularFile(notice, content.length - 1), /size or type/)
    await writeFile(notice, Buffer.alloc(32 * 1024 + 1))
    assert.equal(await isOwnedNativeOcrDirectory(dir), false)
    await assert.rejects(moveOwnedNativeOcrDirectory(dir, dir + '-moved'), /unowned/)
    assert.equal((await readFile(join(dir, 'unrelated'), 'utf8')), 'must survive')
    if (process.platform !== 'win32') {
      await rm(notice)
      await writeFile(join(dir, 'other-notice'), content)
      await symlink(join(dir, 'other-notice'), notice)
      assert.equal(await isOwnedNativeOcrDirectory(dir), false)
      await assert.rejects(readNativeOcrRegularFile(notice, 32 * 1024))
      await rm(notice)
    }
    const sub = join(dir, 'owned')
    await mkdir(sub)
    await writeFile(join(sub, 'SOURCE-NOTICE.md'), content)
    const moved = join(dir, 'moved')
    await moveOwnedNativeOcrDirectory(sub, moved)
    assert.equal(await isOwnedNativeOcrDirectory(sub), false)
    assert.equal(await isOwnedNativeOcrDirectory(moved), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(dir + '-moved', { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, truncate, rm, utimes, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { deterministicNativeOcrArchive } from '../src/lib/native-ocr-archive.js'

test('native OCR archive is byte-identical across paths, order, modes and times', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dvr-archive-'))
  const names = ['ppocrv6-small/worker.exe','ppocrv6-small/models/rec.bin','ppocrv6-small/SOURCE-NOTICE.md']
  try {
    const outputs = []
    for (const i of [0, 1]) {
      const base = join(root, String(i))
      await mkdir(join(base, 'ppocrv6-small/models'), { recursive: true })
      for (const n of names) {
        const f = join(base, n)
        await writeFile(f, Buffer.from(n))
        await chmod(f, i ? 0o700 : 0o600)
        await utimes(f, new Date(i * 1000000), new Date(i * 1000000))
      }
      outputs.push(await deterministicNativeOcrArchive(base, i ? names : [...names].reverse()))
    }
    assert.deepEqual(outputs[0], outputs[1])
    assert.equal(outputs[0][9], 255)
    assert.equal(outputs[0].readUInt32LE(4), 0)
    const tar = gunzipSync(outputs[0])
    assert.equal(tar.subarray(-1024).every(b => b === 0), true)
    const archive = join(root, 'sample.tar.gz')
    await writeFile(archive, outputs[0])
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0, listing.stderr)
    assert.deepEqual(listing.stdout.trim().split(/\r?\n/), [...names].sort())
    for (const name of names) {
      const part = spawnSync('tar', ['-xOzf', archive, name])
      assert.equal(part.status, 0)
      assert.deepEqual(part.stdout, Buffer.from(name))
    }
    await assert.rejects(deterministicNativeOcrArchive(join(root, '0'), [names[0], names[0]]), /member set/)
    for (const bad of ['ppocrv6-small/..','../other','ppocrv6-small/a/b','ppocrv6-small/models/..']) {
      await assert.rejects(deterministicNativeOcrArchive(join(root, '0'), [bad]), /member name/)
    }
    await assert.rejects(deterministicNativeOcrArchive(root, ['ppocrv6-small']), /member name/)
    const tooBig = join(root, '0', 'ppocrv6-small', 'too-big')
    await writeFile(tooBig, '')
    await truncate(tooBig, 32 * 1024 * 1024 + 1)
    await assert.rejects(deterministicNativeOcrArchive(join(root, '0'), ['ppocrv6-small/too-big']), /size or type/)
    if (process.platform !== 'win32') {
      await symlink(join(root, '0', names[0]), join(root, '0', 'ppocrv6-small/link'))
      await assert.rejects(deterministicNativeOcrArchive(join(root, '0'), ['ppocrv6-small/link']))
      await mkdir(join(root, 'linked'))
      await symlink(join(root, '0', 'ppocrv6-small'), join(root, 'linked', 'ppocrv6-small'), 'dir')
      await assert.rejects(deterministicNativeOcrArchive(join(root, 'linked'), names), /directory size or type/)
      const fifo = join(root, '0', 'ppocrv6-small', 'fifo')
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
      await assert.rejects(deterministicNativeOcrArchive(join(root, '0'), ['ppocrv6-small/fifo']), /size or type/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

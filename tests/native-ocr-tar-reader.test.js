import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { deterministicNativeOcrArchive } from '../src/lib/native-ocr-archive.js'
import { readNativeOcrTarArchive } from '../src/lib/native-ocr-tar-reader.js'
import { readBoundedNativeOcrArchive } from '../src/lib/native-ocr-bounded-file.js'

const BLOCK = 512
function rehashHeader(bytes, offset = 0) {
  bytes.fill(32, offset + 148, offset + 156)
  let sum = 0
  for (let i = offset; i < offset + BLOCK; i++) sum += bytes[i]
  bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', offset + 148, 8, 'ascii')
}
function mutateArchive(bytes, change) {
  const raw = gunzipSync(bytes)
  change(raw)
  return gzipSync(raw)
}

test('native OCR tar reader extracts canonical ustar members without an external tar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-ocr-read-'))
  const names = ['ppocrv6-small/worker.exe', 'ppocrv6-small/models/rec.bin', 'ppocrv6-small/MANIFEST.json']
  try {
    await mkdir(join(root, 'ppocrv6-small', 'models'), { recursive: true })
    for (const name of names) await writeFile(join(root, name), Buffer.from(name))
    const archive = await deterministicNativeOcrArchive(root, names)
    const members = readNativeOcrTarArchive(archive)
    assert.deepEqual([...members.keys()], [...names].sort())
    for (const name of names) assert.deepEqual(members.get(name), Buffer.from(name))
    assert.throws(() => readNativeOcrTarArchive(Buffer.from('not an archive')), /compressed archive size/)
    assert.throws(() => readNativeOcrTarArchive(Buffer.concat([archive, Buffer.from([1, 2])])), /compressed stream/)
    assert.throws(() => readNativeOcrTarArchive(mutateArchive(archive, b => { b[148] ^= 1 })), /checksum/)
    assert.throws(() => readNativeOcrTarArchive(mutateArchive(archive, b => {
      b.write('../evil', 0, 'ascii')
      rehashHeader(b)
    })), /member name/)
    assert.throws(() => readNativeOcrTarArchive(mutateArchive(archive, b => {
      b[156] = '2'.charCodeAt(0)
      rehashHeader(b)
    })), /nonregular/)
    assert.throws(() => readNativeOcrTarArchive(mutateArchive(archive, b => {
      b.fill(1, b.length - BLOCK * 2, b.length - BLOCK)
    })), /trailer|tar format/)
    assert.throws(() => readNativeOcrTarArchive(gzipSync(
      gunzipSync(archive).subarray(0, -BLOCK)
    )), /trailer|truncated tar member/)
    const first = Buffer.from(names.sort()[0])
    assert.throws(() => readNativeOcrTarArchive(mutateArchive(archive, b => {
      b[BLOCK + first.length] = 123
    })), /padding/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native OCR archive reader rejects unsafe paths and enforces descriptor-bound size limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-ocr-fd-'))
  try {
    const archive = join(root, 'candidate.tar.gz')
    const contents = Buffer.alloc(2048, 0x42)
    await writeFile(archive, contents)
    assert.deepEqual(await readBoundedNativeOcrArchive(archive), contents)
    await assert.rejects(readBoundedNativeOcrArchive(archive, { maxBytes: 2047 }), /unsafe native OCR archive/)
    await assert.rejects(readBoundedNativeOcrArchive(archive, { minBytes: 2049 }), /unsafe native OCR archive/)
    if (process.platform !== 'win32') {
      const alias = join(root, 'archive-link.tar.gz')
      await symlink(archive, alias)
      await assert.rejects(readBoundedNativeOcrArchive(alias), /ELOOP|unsafe native OCR archive/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

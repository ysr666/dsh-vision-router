#!/usr/bin/env node
// Installs owner-provided, already license-reviewed PP-OCRv6/ncnn artifacts.
// It does not download, build, or publish any native executable/model.
import { copyFile, chmod, mkdir, rename, rm, lstat, writeFile, mkdtemp, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localNativeOcrInstallPaths, isOwnedNativeOcrDirectory } from '../lib/native-ocr-installation.js'
import { verifyExperimentalNativeOcrBinary } from '../lib/native-ocr-canary.js'
import { EXPERIMENTAL_OCR_MODEL_FILES, verifyNativeOcrAssets } from '../lib/native-ocr-integrity.js'

const args = process.argv.slice(2)
const target = process.platform + '-' + process.arch
const onWindows = target === 'win32-x64'
const workerName = onWindows ? 'worker.exe' : 'worker'
const additionalNotices = onWindows
  ? ['LLVM-LICENSE.txt', 'MINGW-RUNTIME-COPYING.txt']
  : []
if (args.includes('--help')) {
  console.log('Usage: node scripts/install-native-ocr.mjs --bundle ABSOLUTE_ARCHIVE.tar.gz\n       node scripts/install-native-ocr.mjs --binary ABSOLUTE_WORKER --models ABSOLUTE_MODEL_DIR')
  process.exit(0)
}
const readOption = key => {
  const i = args.indexOf(key)
  if (i < 0 || i + 1 >= args.length) throw Error('missing ' + key)
  return resolve(args[i + 1])
}
async function installFromSources(binary, sourceModels) {
  const dest = localNativeOcrInstallPaths()
  if (!dest) throw Error('Only darwin-arm64 and win32-x64 are approved for this local installer')
  await verifyExperimentalNativeOcrBinary(binary)
  await verifyNativeOcrAssets(sourceModels)

  const base = dirname(dest.root)
  await mkdir(base, { recursive: true, mode: 0o700 })
  const staged = join(base, '.ppocrv6-stage-' + randomUUID())
  const previous = join(base, '.ppocrv6-old-' + randomUUID())
  let movedPrevious = false
  let promoted = false
  try {
    await mkdir(join(staged, 'models'), { recursive: true, mode: 0o700 })
    await copyFile(binary, join(staged, workerName))
    await chmod(join(staged, workerName), 0o700)
    for (const name of Object.keys(EXPERIMENTAL_OCR_MODEL_FILES)) {
      await copyFile(join(sourceModels, name), join(staged, 'models', name))
      await chmod(join(staged, 'models', name), 0o600)
    }
    const assetBase = fileURLToPath(new URL('../assets/licenses/', import.meta.url))
    await copyFile(join(assetBase, 'ncnn-LICENSE.txt'), join(staged, 'NCNN-LICENSE.txt'))
    await copyFile(join(assetBase, 'apache-2.0.txt'), join(staged, 'APACHE-2.0.txt'))
    for (const [name, destName] of [
      ['llvm-mingw-LICENSE.txt', 'LLVM-LICENSE.txt'],
      ['mingw-w64-runtime-COPYING.txt', 'MINGW-RUNTIME-COPYING.txt'],
    ].filter(() => onWindows)) {
      await copyFile(join(assetBase, name), join(staged, destName))
    }
    await writeFile(join(staged, 'SOURCE-NOTICE.md'), [
      '# Locally installed native OCR assets',
      '',
      'Detector: PaddlePaddle/PP-OCRv6_small_det_onnx, Apache-2.0.',
      'Recognizer: PaddlePaddle/PP-OCRv6_small_rec_onnx, Apache-2.0.',
      'Dictionary: PaddlePaddle/PaddleOCR ppocrv6_dict.txt, Apache-2.0.',
      'Runtime: Tencent/ncnn @ d1f6ac67e9fc91390cc70f7168573fd2626f1d66, BSD-3-Clause',
      'with its stated BSD-2-Clause and zlib components.',
      'Models are owner-provided and checksum-gated, never bundled in the npm package.',
      onWindows
        ? 'This Windows build statically links LLVM libc++/unwind, with Apache-2.0 WITH LLVM exceptions and MinGW-w64 runtime notices.'
        : 'This Mac build links only OS-supplied libc++ and libSystem; no platform CRT is redistributed.',
      '',
    ].join('\n'), { mode: 0o600 })
    await verifyExperimentalNativeOcrBinary(join(staged, workerName))
    await verifyNativeOcrAssets(join(staged, 'models'))
    try {
      const existing = await lstat(dest.root)
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error('unsafe existing OCR install directory')
      if (!await isOwnedNativeOcrDirectory(dest.root)) throw Error('refusing to overwrite unowned OCR directory')
      await rename(dest.root, previous)
      movedPrevious = true
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    await rename(staged, dest.root)
    promoted = true
    if (movedPrevious) await rm(previous, { recursive: true, force: true })
    console.log('PP_OCRV6_LOCAL_INSTALL_OK (verified '+target+' assets; auto mode now prefers ncnn)')
  } catch (err) {
    if (!promoted && movedPrevious) await rename(previous, dest.root)
    throw err
  } finally {
    if (!promoted) await rm(staged, { recursive: true, force: true })
  }
}
async function install() {
  if (args.length === 4 && args.includes('--binary') && args.includes('--models')) {
    return installFromSources(readOption('--binary'), readOption('--models'))
  }
  if (args.length !== 2 || args[0] !== '--bundle') {
    throw Error('required: --bundle ARCHIVE or --binary WORKER --models DIR')
  }
  if (!localNativeOcrInstallPaths()) throw Error('Only darwin-arm64 and win32-x64 are approved')
  const archive = resolve(args[1])
  const info = await lstat(archive)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) {
    throw Error('unsafe native OCR bundle')
  }
  const prefix = 'ppocrv6-small/'
  const members = [
    workerName, 'MANIFEST.json', 'NCNN-LICENSE.txt', 'APACHE-2.0.txt',
    ...additionalNotices,
    ...Object.keys(EXPERIMENTAL_OCR_MODEL_FILES).map(x => 'models/' + x),
  ].map(x => prefix + x).sort()
  const listed = spawnSync('tar', ['-tzf', archive], { encoding:'utf8', timeout:30_000, maxBuffer: 64 * 1024 })
  if (listed.status !== 0 || JSON.stringify(listed.stdout.trim().split(/\r?\n/).sort()) !== JSON.stringify(members)) {
    throw Error('native OCR bundle has unknown/missing entries')
  }
  // Read ONLY individually named entries into memory. Never call 'tar -x':
  // traversal, links and metadata from an external archive cannot write files.
  const tmp = await mkdtemp(join(tmpdir(), 'dvr-ocr-unpack-'))
  try {
    for (const entry of members) {
      const suffix = entry.slice(prefix.length)
      const destPath = join(tmp, suffix)
      await mkdir(dirname(destPath), { recursive: true, mode: 0o700 })
      const data = spawnSync('tar', ['-xOzf', archive, entry], {
        timeout: 45_000, maxBuffer: 32 * 1024 * 1024,
      })
      if (data.status !== 0 || !Buffer.isBuffer(data.stdout)) {
        throw Error('native OCR archive member unreadable: ' + suffix)
      }
      await writeFile(destPath, data.stdout, { mode: 0o600 })
    }
    const manifest = JSON.parse(await readFile(join(tmp,'MANIFEST.json'),'utf8'))
    if (manifest.schemaVersion !== 1 ||
      manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw Error('unsupported native OCR bundle manifest')
    }
    return await installFromSources(join(tmp,workerName), join(tmp,'models'))
  } finally { await rm(tmp, { recursive:true, force:true }) }
}
install().catch(err => {
  console.error('PP_OCRV6_LOCAL_INSTALL_FAILED:', String(err?.code ?? err?.message ?? err))
  process.exitCode = 1
})

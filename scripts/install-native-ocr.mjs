#!/usr/bin/env node
// Installs owner-provided, already license-reviewed PP-OCRv6/ncnn artifacts.
// It does not download, build, or publish any native executable/model.
import { copyFile, chmod, mkdir, rename, rm, lstat, writeFile, mkdtemp, readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localNativeOcrInstallPaths, moveOwnedNativeOcrDirectory } from '../lib/native-ocr-installation.js'
import { verifyExperimentalNativeOcrBinary } from '../lib/native-ocr-canary.js'
import { EXPERIMENTAL_OCR_MODEL_FILES, verifyNativeOcrAssets } from '../lib/native-ocr-integrity.js'
import { nativeBundleMetadata, nativeBundleLicenseFiles, NATIVE_BUNDLE_METADATA_FILES, readVerifiedNativeBundleLicense } from '../lib/native-ocr-bundle-metadata.js'
import { readNativeOcrTarArchive } from '../lib/native-ocr-tar-reader.js'
import { readBoundedNativeOcrArchive } from '../lib/native-ocr-bounded-file.js'

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
    const project = fileURLToPath(new URL('../', import.meta.url))
    for (const [name, destination] of nativeBundleLicenseFiles()) {
      await writeFile(join(staged, destination), await readVerifiedNativeBundleLicense(project, name), { mode: 0o600 })
    }
    const metadata = await nativeBundleMetadata({ root: staged })
    for (const [name, value] of Object.entries(metadata)) {
      await writeFile(join(staged, name), value, { mode: 0o600 })
    }
    await verifyExperimentalNativeOcrBinary(join(staged, workerName))
    await verifyNativeOcrAssets(join(staged, 'models'))
    try {
      const existing = await lstat(dest.root)
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error('unsafe existing OCR install directory')
      await moveOwnedNativeOcrDirectory(dest.root, previous)
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
  // Validate and read from one descriptor to prevent path-swap races.
  const bundleBytes = await readBoundedNativeOcrArchive(archive)
  const prefix = 'ppocrv6-small/'
  const legacyMembers = [
    workerName, 'MANIFEST.json', 'NCNN-LICENSE.txt', 'APACHE-2.0.txt',
    ...additionalNotices,
    ...Object.keys(EXPERIMENTAL_OCR_MODEL_FILES).map(x => 'models/' + x),
  ].map(x => prefix + x).sort()
  const previousV2Members = [...legacyMembers, ...NATIVE_BUNDLE_METADATA_FILES.map(x => prefix + x)].sort()
  const sourceV2Members = [...previousV2Members, ...(onWindows ? [prefix + 'MINGW-SOURCE-NOTICES.txt'] : [])].sort()
  const v2Members = [...sourceV2Members, ...(onWindows ? [prefix + 'WINDOWS-RUNTIME-NOTICES.txt'] : [])].sort()
  const v3Members = [...v2Members, prefix + 'PADDLEOCR-LICENSE.txt'].sort()
  const v4Members = [...v3Members, ...(onWindows ? [prefix + 'MINGW-PTHREAD-SIGNAL-NOTICE.txt'] : [])].sort()
  // Decode a constrained ustar archive in this dedicated installer process.
  // Windows Desktop Hosts may not expose an external tar executable on PATH.
  const memberBytes = readNativeOcrTarArchive(bundleBytes)
  const actualMembers = [...memberBytes.keys()].sort()
  const hasCrtNotice = onWindows && isDeepStrictEqual(actualMembers, v4Members)
  const hasPaddleLicense = hasCrtNotice || isDeepStrictEqual(actualMembers, v3Members)
  const hasRuntimeNotices = onWindows && (hasPaddleLicense || isDeepStrictEqual(actualMembers, v2Members))
  const hasSourceNotices = onWindows && (hasRuntimeNotices || isDeepStrictEqual(actualMembers, sourceV2Members))
  const isV2 = isDeepStrictEqual(actualMembers, v2Members) || isDeepStrictEqual(actualMembers, sourceV2Members) || isDeepStrictEqual(actualMembers, previousV2Members)
  const hasMetadata = hasPaddleLicense || isV2
  if (!hasMetadata && !isDeepStrictEqual(actualMembers, legacyMembers)) {
    throw Error('native OCR bundle has unknown/missing entries')
  }
  const members = hasCrtNotice ? v4Members : hasPaddleLicense ? v3Members : isV2 ? (hasRuntimeNotices ? v2Members : hasSourceNotices ? sourceV2Members : previousV2Members) : legacyMembers
  // Materialize ONLY exact allowlisted regular files. The strict reader has
  // rejected links, traversal, duplicates, extra entries and malformed tar.
  const tmp = await mkdtemp(join(tmpdir(), 'dvr-ocr-unpack-'))
  try {
    for (const entry of members) {
      const suffix = entry.slice(prefix.length)
      const destPath = join(tmp, suffix)
      await mkdir(dirname(destPath), { recursive: true, mode: 0o700 })
      const data = memberBytes.get(entry)
      if (!Buffer.isBuffer(data)) throw Error('native OCR archive member unreadable: ' + suffix)
      await writeFile(destPath, data, { mode: 0o600 })
    }
    const manifest = JSON.parse(await readFile(join(tmp,'MANIFEST.json'),'utf8'))
    if (manifest.schemaVersion !== (hasCrtNotice ? 4 : hasPaddleLicense ? 3 : isV2 ? 2 : 1) ||
      manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw Error('unsupported native OCR bundle manifest')
    }
    await verifyExperimentalNativeOcrBinary(join(tmp, workerName))
    await verifyNativeOcrAssets(join(tmp, 'models'))
    const actualWorkerSha = createHash('sha256').update(await readFile(join(tmp, workerName))).digest('hex')
    if (manifest.worker?.sha256 !== actualWorkerSha || !isDeepStrictEqual(manifest.models, EXPERIMENTAL_OCR_MODEL_FILES)) {
      throw Error('native OCR bundle manifest integrity mismatch')
    }
    // Compare canonical notices rather than trusting arbitrary archive text.
    const project = fileURLToPath(new URL('../', import.meta.url))
    for (const [source, name] of nativeBundleLicenseFiles(process.platform, { includeSourceNotices: hasSourceNotices, includeRuntimeNotices: hasRuntimeNotices, includePaddleLicense: hasPaddleLicense, includeCrtNotice: hasCrtNotice })) {
      if (!hasMetadata && name === 'PROJECT-LICENSE.txt') continue
      const expected = await readVerifiedNativeBundleLicense(project, source)
      const supplied = await readFile(join(tmp, name))
      // Older Windows v1 archives may contain the canonical Apache text with
      // checkout CRLF. Do not accept changed content or relax v2 byte identity.
      const legacyApache = !hasMetadata && name === 'APACHE-2.0.txt' &&
        supplied.toString('utf8').replace(/\r\n/g, '\n') === expected.toString('utf8').replace(/\r\n/g, '\n')
      if (!expected.equals(supplied) && !legacyApache) throw Error('native OCR bundle license integrity mismatch: ' + name)
    }
    if (hasMetadata) {
      const expected = await nativeBundleMetadata({ root: tmp, includeSourceNotices: hasSourceNotices, includeRuntimeNotices: hasRuntimeNotices, includePaddleLicense: hasPaddleLicense, includeCrtNotice: hasCrtNotice })
      for (const [name, value] of Object.entries(expected)) {
        if (!Buffer.from(value).equals(await readFile(join(tmp, name)))) {
          throw Error('native OCR bundle metadata integrity mismatch: ' + name)
        }
      }
    }
    return await installFromSources(join(tmp,workerName), join(tmp,'models'))
  } finally { await rm(tmp, { recursive:true, force:true }) }
}
install().catch(err => {
  console.error('PP_OCRV6_LOCAL_INSTALL_FAILED:', String(err?.code ?? err?.message ?? err))
  process.exitCode = 1
})

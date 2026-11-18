#!/usr/bin/env node
// Creates a single local-release artifact from pinned, already verified assets.
// This command never uploads to GitHub/npm and never includes private photos.
import { mkdtemp, mkdir, copyFile, chmod, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { deterministicNativeOcrArchive } from '../lib/native-ocr-archive.js'
import { verifyExperimentalNativeOcrBinary } from '../lib/native-ocr-canary.js'
import { EXPERIMENTAL_OCR_MODEL_FILES, verifyNativeOcrAssets } from '../lib/native-ocr-integrity.js'
import { nativeBundleMetadata, nativeBundleLicenseFiles, readVerifiedNativeBundleLicense } from '../lib/native-ocr-bundle-metadata.js'

const args = process.argv.slice(2)
const target = process.platform + '-' + process.arch
const win = target === 'win32-x64'
const workerName = win ? 'worker.exe' : 'worker'
function option(name) {
  const idx = args.indexOf(name)
  if (idx < 0 || idx + 1 >= args.length) throw Error('missing ' + name)
  return resolve(args[idx + 1])
}
async function main() {
  if (!['darwin-arm64', 'win32-x64'].includes(target)) throw Error('approved Mac ARM64 or Windows x64 required')
  if (args.length !== 6) throw Error('Usage: package-native-ocr.mjs --binary ABS --models ABS --out FILE.tar.gz')
  const binary = option('--binary')
  const models = option('--models')
  const output = option('--out')
  if (!output.endsWith('.tar.gz')) throw Error('expected .tar.gz output')
  await verifyExperimentalNativeOcrBinary(binary)
  await verifyNativeOcrAssets(models)
  const workspace = await mkdtemp(join(tmpdir(), 'dvr-ocr-dist-'))
  try {
    const prefix = 'ppocrv6-small'
    const root = join(workspace, prefix)
    await mkdir(join(root, 'models'), { recursive: true, mode: 0o700 })
    await copyFile(binary, join(root, workerName))
    await chmod(join(root, workerName), 0o700)
    const files = [prefix + '/' + workerName]
    for (const name of Object.keys(EXPERIMENTAL_OCR_MODEL_FILES)) {
      await copyFile(join(models, name), join(root, 'models', name))
      files.push(prefix + '/models/' + name)
    }
    const project = fileURLToPath(new URL('../', import.meta.url))
    for (const [name, outputName] of nativeBundleLicenseFiles()) {
      await writeFile(join(root, outputName), await readVerifiedNativeBundleLicense(project, name), { mode: 0o600 })
      files.push(prefix + '/' + outputName)
    }
    await verifyExperimentalNativeOcrBinary(join(root, workerName))
    await verifyNativeOcrAssets(join(root, 'models'))
    const metadata = await nativeBundleMetadata({ root })
    for (const [name, value] of Object.entries(metadata)) {
      await writeFile(join(root, name), value, { mode: 0o600 })
      files.push(prefix + '/' + name)
    }
    files.sort()
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, await deterministicNativeOcrArchive(workspace, files), { mode: 0o600 })
    const names = spawnSync('tar', ['-tzf', output], { encoding: 'utf8', timeout: 30_000 })
    if (names.status !== 0 ||
      JSON.stringify(names.stdout.trim().split(/\r?\n/).sort()) !== JSON.stringify(files)) {
      throw Error('archive contains unexpected members')
    }
    const archiveData = await readFile(output)
    const archiveSha = createHash('sha256').update(archiveData).digest('hex')
    console.log('NATIVE_OCR_BUNDLE_READY platform=' + target + ' files=' + files.length +
      ' bytes=' + (await stat(output)).size + ' sha256=' + archiveSha)
  } finally { await rm(workspace, { recursive: true, force: true }) }
}
main().catch(err=>{ console.error('NATIVE_OCR_BUNDLE_FAILED: '+String(err?.message??err)); process.exitCode=1 })

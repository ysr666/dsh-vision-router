// Maintainer-only, local staging. Never changes production pins or publishes.
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readNativeOcrRegularFile } from '../src/lib/native-ocr-installation.js'
import { EXPERIMENTAL_OCR_MODEL_FILES } from '../src/lib/native-ocr-integrity.js'
import { deterministicNativeOcrArchive } from '../src/lib/native-ocr-archive.js'
import { nativeBundleMetadata, nativeBundleLicenseFiles, readVerifiedNativeBundleLicense } from '../src/lib/native-ocr-bundle-metadata.js'
import { createNpmAssetPackage, stagingNpmVersion } from './native-ocr-npm-package.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// Exact independently rebuilt candidates, not the older experimental
// runtime allowlist and not an authorization to admit these hashes.
export const candidates = Object.freeze({
  'darwin-arm64': Object.freeze({
    workerSha256: '56499298089bc98709d3b6818fc870c8cf16c4c8607edd5ded842f304cbe84de',
    buildEvidence: '44244890944/job/134643926507',
    minimumOsRuntimeVerified: false,
  }),
  'win32-x64': Object.freeze({
    workerSha256: 'd1d958de7d48474aac1b945cfa4d8f0a70c05745334322d00f776c17c70b7166',
    buildEvidence: '44244890944/job/134643857924',
    minimumOsRuntimeVerified: false,
  }),
})
function targetInfo(target) {
  if (!Object.hasOwn(candidates, target)) throw Error('unsupported staging target')
  const [platform, arch] = target.split('-')
  return { platform, arch, workerName: platform === 'win32' ? 'worker.exe' : 'worker', ...candidates[target] }
}
export async function readCandidateWorker(target, path) {
  const info = targetInfo(target)
  const bytes = await readNativeOcrRegularFile(resolve(path), 32 * 1024 * 1024)
  if (sha(bytes) !== info.workerSha256) throw Error('release candidate worker SHA-256 mismatch')
  return bytes
}
export async function readCanonicalModels(path) {
  const dir = resolve(path)
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('invalid canonical model directory')
  const files = {}
  for (const [name, expected] of Object.entries(EXPERIMENTAL_OCR_MODEL_FILES)) {
    const bytes = await readNativeOcrRegularFile(join(dir, name), expected.bytes)
    if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256)
      throw Error('canonical model identity mismatch: ' + name)
    files[name] = bytes
  }
  return files
}
async function makeArchive(target, worker, models) {
  const { platform, arch, workerName } = targetInfo(target)
  const workspace = await mkdtemp(join(tmpdir(), 'dvr-ocr-release-stage-'))
  try {
    const root = join(workspace, 'ppocrv6-small')
    await mkdir(join(root, 'models'), { recursive: true, mode: 0o700 })
    const names = []
    async function put(name, bytes) {
      await writeFile(join(root, name), bytes, { flag: 'wx', mode: 0o600 })
      names.push('ppocrv6-small/' + name)
    }
    await put(workerName, worker)
    await chmod(join(root, workerName), 0o700)
    for (const [name, bytes] of Object.entries(models)) await put('models/' + name, bytes)
    for (const [source, name] of nativeBundleLicenseFiles(platform))
      await put(name, await readVerifiedNativeBundleLicense(project, source))
    const metadata = await nativeBundleMetadata({ root, platform, arch })
    for (const [name, value] of Object.entries(metadata)) await put(name, value)
    const manifest = JSON.parse(metadata['MANIFEST.json'])
    const sbom = JSON.parse(metadata['SBOM.cdx.json'])
    if (manifest.distributionReady !== false ||
        sbom.compositions?.[0]?.aggregate !== 'incomplete' ||
        manifest.worker.sha256 !== candidates[target].workerSha256 ||
        JSON.stringify(manifest.models) !== JSON.stringify(EXPERIMENTAL_OCR_MODEL_FILES))
      throw Error('unexpected staging metadata')
    return { archive: await deterministicNativeOcrArchive(workspace, names),
      members: names.length, manifest, sbomSha256: sha(metadata['SBOM.cdx.json']) }
  } finally { await rm(workspace, { recursive: true, force: true }) }
}
export async function stageCandidate({ target, binary, models, out }) {
  const info = targetInfo(target)
  const worker = await readCandidateWorker(target, binary)
  const canonical = await readCanonicalModels(models)
  const first = await makeArchive(target, worker, canonical)
  const second = await makeArchive(target, worker, canonical)
  if (!first.archive.equals(second.archive)) throw Error('candidate archive replay mismatch')
  const directory = resolve(out)
  const filename = 'ppocrv6-small-' + target + '.tar.gz'
  const projectLicense = await readFile(join(project,'LICENSE'),'utf8')
  const npm = createNpmAssetPackage({ target, version: stagingNpmVersion, archive:first.archive, projectLicense })
  const npmReplay = createNpmAssetPackage({ target, version: stagingNpmVersion, archive:second.archive, projectLicense })
  if (!npm.payload.equals(npmReplay.payload)) throw Error('npm resource package replay mismatch')
  const report = {
    npm: npm.report,
    schemaVersion: 1, target, archive: { name: filename, bytes: first.archive.length, sha256: sha(first.archive) },
    workerSha256: info.workerSha256, buildEvidence: info.buildEvidence,
    archiveReplayMatch: true, modelOrigin: 'windows-canonical', members: first.members,
    manifest: first.manifest, sbomSha256: first.sbomSha256,
    exactArchiveDesktopGuiVerified: false, minimumOsRuntimeVerified: info.minimumOsRuntimeVerified,
    distributionReady: false, ownerPublicationAuthorized: false,
  }
  // Require a new directory and never overwrite an existing candidate.
  // The input bytes were verified before any output directory was created.
  await mkdir(directory, { mode: 0o700 })
  try {
    await writeFile(join(directory, filename), first.archive, { flag: 'wx', mode: 0o600 })
    await writeFile(join(directory, npm.report.filename), npm.payload, { flag:'wx', mode:0o600 })
    await writeFile(join(directory, 'staging-evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return report
}
async function main(args) {
  const mode = args.shift()
  const fields = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!['--target', '--binary', '--models', '--out'].includes(key) ||
        !value || value.startsWith('--') || Object.hasOwn(fields, key)) throw Error('invalid staging options')
    fields[key] = value
  }
  const requireFields = keys => {
    if (Object.keys(fields).length !== keys.length || keys.some(k => !fields[k])) throw Error('missing or extra staging options')
  }
  if (mode === '--verify-worker') {
    requireFields(['--target', '--binary'])
    const bytes = await readCandidateWorker(fields['--target'], fields['--binary'])
    return { target: fields['--target'], workerSha256: sha(bytes), distributionReady: false }
  }
  if (mode === '--verify-models') {
    requireFields(['--models'])
    const assets = await readCanonicalModels(fields['--models'])
    return { modelCount: Object.keys(assets).length, modelOrigin: 'windows-canonical', distributionReady: false }
  }
  if (mode !== '--stage') throw Error('use --stage, --verify-worker or --verify-models')
  requireFields(['--target', '--binary', '--models', '--out'])
  return stageCandidate({ target: fields['--target'], binary: fields['--binary'], models: fields['--models'], out: fields['--out'] })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {
    console.error('NATIVE_OCR_STAGING_FAILED: ' + error.message); process.exitCode = 1
  })

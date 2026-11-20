// Deterministic npm resource package; an existing exact, reviewed native
// installation archive is carried byte-for-byte, without install scripts.
// Maintainer staging only. This module cannot publish or admit runtime pins.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { nativeOcrTarHeader } from '../src/lib/native-ocr-archive.js'
import { readNativeOcrNpmTarball } from '../src/lib/native-ocr-tar-reader.js'
import { nativeOcrNpmAssetIdentity } from '../src/lib/native-ocr-download.js'
import { readBoundedNativeOcrArchive } from '../src/lib/native-ocr-bounded-file.js'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const MAX_BYTES = 64 * 1024 * 1024
export const stagingNpmVersion = '0.0.0-staging'

export function createNpmAssetPackage({ target, version, archive, projectLicense }) {
  assert.ok(Buffer.isBuffer(archive) && archive.length >= 128 && archive.length <= MAX_BYTES)
  assert.ok(typeof projectLicense === 'string' && projectLicense.length > 0 && projectLicense.length < 64 * 1024)
  const name = 'dsh-vision-router-ocr-' + target
  const filename = name + '-' + version + '.tgz'
  const url = 'https://registry.npmjs.org/' + name + '/-/' + filename
  const identity = nativeOcrNpmAssetIdentity(url)
  assert.equal(identity.target, target)
  assert.equal(identity.version, version)
  const [os, cpu] = target.split('-')
  const bundleName = 'ppocrv6-small-' + target + '.tar.gz'
  const manifest = {
    name, version, description: 'Optional PP-OCRv6/ncnn resource archive for DSH Vision Router (' + target + ')',
    os: [os], cpu: [cpu], license: 'SEE LICENSE IN LICENSE',
    files: [bundleName], repository: { type: 'git', url: 'git+https://github.com/ysr666/dsh-vision-router.git' },
  }
  const members = {
    'package/package.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    'package/LICENSE': Buffer.from(projectLicense.trimEnd() + '\n\nThis MIT license applies to the project wrapper. Third-party worker/model components retain their own licenses; full bundled license and attribution texts are inside ' + bundleName + '.\n'),
    'package/README.md': Buffer.from('# ' + name + '\n\nOptional resource package for DSH Vision Router. Contains one native installation archive including model, worker, and third-party notices. No install scripts. The plugin verifies both compressed package and inner archive hashes before installation. Staging is not distribution approval.\n'),
    ['package/' + bundleName]: archive,
  }
  const chunks = []
  for (const key of Object.keys(members).sort()) {
    const value = members[key]
    chunks.push(nativeOcrTarHeader(key, value.length), value, Buffer.alloc((512 - value.length % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  const payload = gzipSync(Buffer.concat(chunks), { level: 9 })
  payload.fill(0,4,8); payload[9] = 255
  assert.ok(payload.length <= MAX_BYTES, 'npm resource exceeds download limit')
  assert.ok(readNativeOcrNpmTarball(payload, identity).equals(archive), 'npm resource round-trip mismatch')
  return { payload, report: { schemaVersion: 1, target, name, version, filename,
    entry: { url, bytes: archive.length, sha256: sha(archive), npmBytes: payload.length, npmSha256: sha(payload) },
    distributionReady: false, ownerPublicationAuthorized: false } }
}

// Re-wrap an already verified staging bundle with a separately selected
// resource-package version. No worker rebuild or changed inner bytes.
async function main(args) {
  assert.equal(args.length, 6, 'use --stage DIR --version VERSION --out DIR')
  const opts = {}
  for (let i=0;i<args.length;i+=2) {
    assert.ok(['--stage','--version','--out'].includes(args[i]) && !Object.hasOwn(opts,args[i]) && args[i+1])
    opts[args[i]]=args[i+1]
  }
  const stage = resolve(opts['--stage'])
  const info = JSON.parse(await readFile(join(stage,'staging-evidence.json'),'utf8'))
  assert.equal(info.distributionReady,false)
  assert.equal(info.ownerPublicationAuthorized,false)
  assert.equal(info.archive.name,'ppocrv6-small-'+info.target+'.tar.gz')
  // The established immutable stage gate validates both archive digest and size.
  const { assertExactStagedArchive } = await import('./native-ocr-staged-acceptance.mjs')
  assertExactStagedArchive(info.target,info.archive)
  const archive = await readBoundedNativeOcrArchive(join(stage,info.archive.name),{minBytes:128})
  assert.equal(archive.length,info.archive.bytes); assert.equal(sha(archive),info.archive.sha256)
  const projectLicense = await readFile(fileURLToPath(new URL('../LICENSE',import.meta.url)), 'utf8')
  const {payload,report} = createNpmAssetPackage({target:info.target,version:opts['--version'],archive,projectLicense})
  const out = resolve(opts['--out'])
  await mkdir(out,{mode:0o700})
  try {
    await writeFile(join(out,report.filename),payload,{mode:0o600,flag:'wx'})
    await writeFile(join(out,'npm-package-evidence.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'})
  } catch (error) {
    await rm(out,{recursive:true,force:true});throw error
  }
  console.log(JSON.stringify(report))
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error=>{console.error('NATIVE_OCR_NPM_PACKAGE_FAILED:',error.message);process.exitCode=1})

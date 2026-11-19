// Maintainer-only npm handoff/readback. Never publishes, creates tags,
// changes production pins, or treats a local fixture as public acceptance.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readBoundedNativeOcrArchive } from '../src/lib/native-ocr-bounded-file.js'
import { readNativeOcrNpmTarball } from '../src/lib/native-ocr-tar-reader.js'
import { nativeOcrNpmAssetIdentity, downloadVerifiedNativeArchive } from '../src/lib/native-ocr-download.js'
import { candidates } from './native-ocr-release-stage.mjs'
import { assertExactStagedArchive, assertNativePromotionState } from './native-ocr-staged-acceptance.mjs'

const sha = (value, algorithm='sha256', encoding='hex') => createHash(algorithm).update(value).digest(encoding)
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const readJson = async path => {
  const raw = await readFile(path)
  assert.ok(raw.length <= 1024*1024, 'oversized handoff evidence')
  return JSON.parse(raw.toString('utf8'))
}
function requireVersion(version) {
  assert.ok(typeof version === 'string' && stableVersion.test(version) && version !== '0.0.0', 'explicit stable resource version required')
}
export function validateResourceReport(report) {
  requireVersion(report.version)
  const identity = nativeOcrNpmAssetIdentity(report.entry.url)
  assert.equal(report.schemaVersion, 1)
  assert.equal(identity.version,report.version)
  assert.equal(identity.target,report.target)
  assert.equal(identity.name,report.name)
  assert.equal(report.filename,report.name+'-'+report.version+'.tgz')
  assert.ok(Object.hasOwn(candidates,report.target))
  assert.equal(report.distributionReady,false)
  assert.equal(report.ownerPublicationAuthorized,false)
  assert.deepEqual(Object.keys(report.entry).sort(), ['bytes','npmBytes','npmSha256','sha256','url'])
  assertExactStagedArchive(report.target,report.entry)
  assert.ok(Number.isSafeInteger(report.entry.npmBytes) && report.entry.npmBytes>=128 && report.entry.npmBytes<=64*1024*1024)
  assert.match(report.entry.npmSha256,/^[a-f0-9]{64}$/)
  return identity
}

export function verifyNpmPackDryRun(rows, report, payload) {
  assert.ok(Array.isArray(rows) && rows.length === 1, 'expected one npm dry-run result')
  const row = rows[0]
  assert.equal(row.name,report.name)
  assert.equal(row.version,report.version)
  assert.equal(row.filename,report.filename)
  assert.equal(row.size,payload.length)
  assert.equal(row.shasum,sha(payload,'sha1'))
  assert.equal(row.integrity,'sha512-'+sha(payload,'sha512','base64'))
  assert.equal(row.entryCount,4)
  assert.deepEqual(row.bundled,[])
  assert.deepEqual(row.files.map(f=>f.path).sort(), ['LICENSE','README.md','package.json','ppocrv6-small-'+report.target+'.tar.gz'].sort())
}

export async function verifyExport({ stage, packageDir, version }) {
  requireVersion(version)
  const [info,audit,acceptance,desktop,report,pack] = await Promise.all([
    readJson(join(stage,'staging-evidence.json')),
    readJson(join(stage,'archive-audit-evidence.json')),
    readJson(join(stage,'acceptance-evidence.json')),
    readJson(join(stage,'desktop-acceptance-evidence.json')),
    readJson(join(packageDir,'npm-package-evidence.json')),
    readJson(join(packageDir,'npm-pack-dry-run.json')),
  ])
  const identity = validateResourceReport(report)
  assert.equal(report.version,version)
  assert.equal(report.target,info.target)
  assert.equal(info.workerSha256,candidates[report.target].workerSha256)
  assertExactStagedArchive(info.target,info.archive)
  for (const evidence of [audit,acceptance,desktop]) {
    assert.equal(evidence.target,info.target)
    assert.equal(evidence.archiveSha256,info.archive.sha256)
    assert.equal(evidence.workerSha256,info.workerSha256)
    assert.equal(evidence.distributionReady,false)
  }
  for (const evidence of [acceptance,desktop]) {
    assert.equal(evidence.npmSha256,info.npm.entry.npmSha256)
    assert.equal(evidence.npmBytes,info.npm.entry.npmBytes)
  }
  assert.equal(audit.identityVerified,true)
  assert.equal(acceptance.realInstaller,true)
  assert.equal(acceptance.realWorker,true)
  for (const key of ['realDesktopHost','realElectronRenderer','actualGuiClicks','realInstaller','realWorker','installedWorkerSupervisorOcr','hostAgentOcrToolVerified'])
    assert.equal(desktop[key],true,'missing Desktop evidence '+key)
  assert.equal(desktop.actualPublicHttps,false)
  assert.equal(desktop.agentEvidence.engine,'ncnn')
  assert.equal(desktop.agentEvidence.toolCalls,1)
  assert.equal(desktop.agentEvidence.visionRequestsDuringOcr,0)
  const payload = await readBoundedNativeOcrArchive(join(packageDir,report.filename),{minBytes:128})
  assert.equal(payload.length,report.entry.npmBytes)
  assert.equal(sha(payload),report.entry.npmSha256)
  const inner=readNativeOcrNpmTarball(payload,identity)
  assert.equal(inner.length,report.entry.bytes)
  assert.equal(sha(inner),report.entry.sha256)
  verifyNpmPackDryRun(pack,report,payload)
  return {schemaVersion:1,target:report.target,version,entry:report.entry,workerSha256:info.workerSha256,
    exactStageVerified:true,realDesktopAcceptanceVerified:true,npmDryRunVerified:true,
    actualPublicHttps:false,distributionReady:false,ownerPublicationAuthorized:false}
}

export async function verifyRegistryPair(reports, { fetchImpl } = {}) {
  assert.equal(reports.length,2)
  const sorted=reports.slice().sort((a,b)=>a.target.localeCompare(b.target))
  assert.deepEqual(sorted.map(r=>r.target),['darwin-arm64','win32-x64'])
  for (const report of sorted) validateResourceReport(report)
  const catalog=Object.fromEntries(sorted.map(r=>[r.target,r.entry]))
  const pins=Object.fromEntries(Object.entries(candidates).map(([target,value])=>[target,value.workerSha256]))
  assert.equal(assertNativePromotionState(catalog,pins,candidates),'promoted')
  for (const report of sorted) {
    const inner=await downloadVerifiedNativeArchive(report.entry,{fetchImpl})
    assert.equal(inner.length,report.entry.bytes)
    assert.equal(sha(inner),report.entry.sha256)
  }
  return {schemaVersion:1,resourceVersion:sorted[0].version,catalogCandidate:catalog,workerPinsCandidate:pins,
    registryReadbackVerified:true,actualPublicHttps:fetchImpl===undefined,
    distributionReady:false,ownerPublicationAuthorized:false}
}

async function main(args) {
  const mode=args.shift()
  const required=mode==='--export'?['--stage','--package-dir','--version']:
    mode==='--verify-registry'?['--mac-report','--windows-report','--out']:null
  assert.ok(required && args.length===required.length*2,'use --export --stage DIR --package-dir DIR --version VERSION or --verify-registry --mac-report JSON --windows-report JSON --out JSON')
  const fields={}
  for(let i=0;i<args.length;i+=2){
    assert.ok(required.includes(args[i])&&!Object.hasOwn(fields,args[i])&&args[i+1]&&!args[i+1].startsWith('--'))
    fields[args[i]]=args[i+1]
  }
  let evidence,output
  if(mode==='--export'){
    const packageDir=resolve(fields['--package-dir'])
    evidence=await verifyExport({stage:resolve(fields['--stage']),packageDir,version:fields['--version']})
    output=join(packageDir,'npm-export-evidence.json')
  }else{
    evidence=await verifyRegistryPair(await Promise.all([readJson(resolve(fields['--mac-report'])),readJson(resolve(fields['--windows-report']))]))
    output=resolve(fields['--out'])
  }
  await writeFile(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600})
  console.log(JSON.stringify(evidence))
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error=>{console.error('NATIVE_OCR_NPM_HANDOFF_FAILED:',error.message);process.exitCode=1})

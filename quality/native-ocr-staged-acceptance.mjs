// Exact-candidate installation and OCR acceptance in a disposable home.
// No real published URL is contacted. No production pin/catalog is edited.
// Real loopback HTTP routing, real installer, real native worker supervisor;
// not the full Desktop Host or GUI and not public-distribution approval.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha = data => createHash('sha256').update(data).digest('hex')
const target = process.platform+'-'+process.arch
const workerName = process.platform==='win32'?'worker.exe':'worker'
const here = fileURLToPath(import.meta.url)
const digest = async path => sha(await readFile(path))
// This script is copied to a disposable root/run.mjs for the child process.
// Resolve the same reader from its isolated lib/ in the child, src/lib otherwise.
const boundedReaderPath = process.env.DVR_OCR_ACCEPTANCE_CHILD === '1'
  ? './lib/native-ocr-bounded-file.js'
  : '../src/lib/native-ocr-bounded-file.js'
const { readBoundedNativeOcrArchive } = await import(boundedReaderPath)
const exactArchives = Object.freeze({
  'darwin-arm64': { sha256: 'a5245c2420fa10ab9da124e2f8e308930a202c6239b4711b0dd73c14f29b78cd', bytes: 27917268 },
  'win32-x64': { sha256: 'fd5791ed9697dbd32ac59b1025600a8a299d8884c607acf6f977445310734ae0', bytes: 35313963 },
})
export function assertExactStagedArchive(target, archive) {
  assert.ok(exactArchives[target], 'unsupported staged target')
  assert.equal(archive.sha256, exactArchives[target].sha256, 'must replay exact reviewed staged archive')
  assert.equal(archive.bytes, exactArchives[target].bytes, 'must replay exact staged size')
}

export function replaceOnce(source, previous, next) {
  assert.equal(source.split(previous).length,2,'expected unique scratch pin')
  return source.replace(previous,next)
}
// An owner-approved release must promote the worker pin and exact archive
// together. Historical lab provenance remains immutable; an empty catalog
// continues to require the historical offline pins. This is only a test
// contract, not permission to populate the production catalog or publish.
export const historicalWorkerPins = Object.freeze({
  'darwin-arm64': '71d535b86b0543e7408b41ed66f45d3bea46e09e0e3f38aa491a32a60085d204',
  'win32-x64': '2e4b96a204c34eebe11f117049b1a3b966f43a8402a66065c28773528cd18a33',
})
export function assertNativePromotionState(catalog, pins, reviewed) {
  const targets = Object.keys(exactArchives).sort()
  assert.deepEqual(Object.keys(pins).sort(), targets, 'worker target set changed')
  assert.deepEqual(Object.keys(reviewed).sort(), targets, 'reviewed target set changed')
  const keys = Object.keys(catalog).sort()
  if (!keys.length) {
    assert.deepEqual(pins, historicalWorkerPins, 'unapproved worker-pin promotion')
    return 'staged'
  }
  assert.deepEqual(keys, targets, 'both reviewed targets must be promoted together')
  let version
  for (const target of targets) {
    const row = catalog[target]
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'npmBytes', 'npmSha256', 'sha256', 'url'])
    assertExactStagedArchive(target, row)
    assert.equal(pins[target], reviewed[target].workerSha256, 'catalog/worker pin mismatch')
    assert.ok(Number.isSafeInteger(row.npmBytes) && row.npmBytes >= 128 && row.npmBytes <= 64*1024*1024)
    assert.match(row.npmSha256, /^[a-f0-9]{64}$/)
    const match = /^https:\/\/registry\.npmjs\.org\/(dsh-vision-router-ocr-(darwin-arm64|win32-x64))\/-\/\1-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.tgz$/.exec(row.url)
    assert.ok(match && match[0] === row.url && match[2] === target, 'invalid immutable npm resource URL')
    if (version === undefined) version = match[3]
    else assert.equal(version, match[3], 'catalog resource version mismatch')
  }
  return 'promoted'
}

// Replace only the unique literal catalog declaration in a scratch package.
// A published catalog is also replaced with the isolated fixture, so CI
// never accidentally downloads release content during a staging test.
export function replaceScratchCatalog(source, catalog) {
  const prefix = 'export const APPROVED_NATIVE_OCR_ARCHIVES = Object.freeze('
  assert.equal(source.split(prefix).length, 2, 'expected unique catalog declaration')
  const matches = [...source.matchAll(/^export const APPROVED_NATIVE_OCR_ARCHIVES = Object\.freeze\(\{[\s\S]*?\}\)\r?$/gm)]
  assert.equal(matches.length, 1, 'expected static catalog object')
  return replaceOnce(source, matches[0][0],
    prefix + JSON.stringify(catalog) + ')' + (matches[0][0].endsWith('\r') ? '\r' : ''))
}
export function replaceScratchWorkerPin(source, target, reviewedSha) {
  assert.ok(Object.hasOwn(historicalWorkerPins, target))
  assert.match(reviewedSha, /^[a-f0-9]{64}$/)
  const prefix = "  '" + target + "': '"
  const matches = source.split(/\r?\n/).filter(line => line.startsWith(prefix))
  assert.equal(matches.length, 1, 'expected unique platform worker pin')
  const old = /^  '[a-z0-9-]+': '([a-f0-9]{64})',$/.exec(matches[0])?.[1]
  assert.ok(old === historicalWorkerPins[target] || old === reviewedSha, 'unknown scratch worker pin')
  return replaceOnce(source, matches[0], prefix + reviewedSha + "',")
}

export function decodeBmp(raw) {
  assert.ok(Buffer.isBuffer(raw)&&raw.length>=54&&raw.subarray(0,2).toString()==='BM')
  const offset=raw.readUInt32LE(10),dib=raw.readUInt32LE(14)
  const width=raw.readInt32LE(18),signedHeight=raw.readInt32LE(22),height=Math.abs(signedHeight)
  const planes=raw.readUInt16LE(26),bits=raw.readUInt16LE(28)
  assert.ok(dib>=40&&offset>=14+dib&&planes===1&&[24,32].includes(bits)&&raw.readUInt32LE(30)===0)
  assert.ok(width>0&&width<=2048&&height>0&&height<=2048&&width*height<=4000000)
  const stride=Math.ceil(width*bits/32)*4
  assert.ok(offset+stride*height<=raw.length,'truncated BMP')
  const rgb=Buffer.alloc(width*height*3)
  for(let y=0;y<height;y++){
    const start=offset+(signedHeight>0?height-y-1:y)*stride
    for(let x=0;x<width;x++){
      const at=start+x*(bits/8),dst=(y*width+x)*3
      rgb[dst]=raw[at+2];rgb[dst+1]=raw[at+1];rgb[dst+2]=raw[at]
    }
  }
  return {width,height,rgb}
}
function argsFrom(args) {
  assert.equal(args.length,8,'use --stage DIR --bmp FILE --expected TEXT --report FILE')
  const obj={}
  for(let i=0;i<args.length;i+=2){
    assert.ok(['--stage','--bmp','--expected','--report'].includes(args[i])&&!Object.hasOwn(obj,args[i])&&args[i+1])
    obj[args[i]]=args[i+1]
  }
  return obj
}
async function loadStage(dir) {
  const info=JSON.parse(await readFile(join(dir,'staging-evidence.json'),'utf8'))
  assert.equal(info.target,target)
  assert.equal(info.archive.name,'ppocrv6-small-'+target+'.tar.gz')
  assert.equal(info.archiveReplayMatch,true)
  assert.equal(info.modelOrigin,'windows-canonical')
  assert.equal(info.distributionReady,false)
  assert.equal(info.ownerPublicationAuthorized,false)
  const archivePath=join(dir,info.archive.name)
  const archive=await readBoundedNativeOcrArchive(archivePath,{minBytes:129})
  assert.equal(archive.length,info.archive.bytes)
  assert.equal(sha(archive),info.archive.sha256)
  assertExactStagedArchive(target, info.archive)
  const npm = info.npm
  assert.equal(npm.target,target)
  assert.equal(npm.version,'0.0.0-staging')
  assert.equal(npm.filename,'dsh-vision-router-ocr-'+target+'-0.0.0-staging.tgz')
  assert.equal(npm.entry.url,'https://registry.npmjs.org/dsh-vision-router-ocr-'+target+'/-/'+npm.filename)
  assert.equal(npm.entry.bytes,info.archive.bytes)
  assert.equal(npm.entry.sha256,info.archive.sha256)
  const npmPayload=await readBoundedNativeOcrArchive(join(dir,npm.filename),{minBytes:128})
  assert.equal(npmPayload.length,npm.entry.npmBytes)
  assert.equal(sha(npmPayload),npm.entry.npmSha256)
  return {info,archive,npmPayload}
}

async function parent(args) {
  const opts=argsFrom(args),stage=resolve(opts['--stage']),bmp=resolve(opts['--bmp']),report=resolve(opts['--report'])
  const {info}=await loadStage(stage)
  const {candidates}=await import('./native-ocr-release-stage.mjs')
  const {EXPERIMENTAL_OCR_BINARY_SHA256}=await import('../src/lib/native-ocr-canary.js')
  const {APPROVED_NATIVE_OCR_ARCHIVES}=await import('../src/lib/native-ocr-download.js')
  assert.equal(info.workerSha256,candidates[target]?.workerSha256)
  assert.equal(info.manifest.worker.sha256,info.workerSha256)
  assert.equal(info.manifest.distributionReady,false)
  assertNativePromotionState(APPROVED_NATIVE_OCR_ARCHIVES, EXPERIMENTAL_OCR_BINARY_SHA256, candidates)
  const project=fileURLToPath(new URL('../',import.meta.url))
  const root=await mkdtemp(join(tmpdir(),'dvr-staged-acceptance-'))
  const home=join(root,'home')
  const sourceCanary=join(project,'src/lib/native-ocr-canary.js')
  const sourceCatalog=join(project,'src/lib/native-ocr-download.js')
  const before=[await digest(sourceCanary),await digest(sourceCatalog)]
  try {
    await mkdir(home);await mkdir(join(root,'scripts'));await mkdir(join(root,'assets'))
    await cp(join(project,'src/lib'),join(root,'lib'),{recursive:true})
    await cp(join(project,'assets/licenses'),join(root,'assets/licenses'),{recursive:true})
    await copyFile(join(project,'LICENSE'),join(root,'LICENSE'))
    await copyFile(join(project,'scripts/install-native-ocr.mjs'),join(root,'scripts/install-native-ocr.mjs'))
    await writeFile(join(root,'package.json'),JSON.stringify({private:true,type:'module'}),{flag:'wx'})
    await copyFile(here,join(root,'run.mjs'))
    const canary=join(root,'lib/native-ocr-canary.js'),catalog=join(root,'lib/native-ocr-download.js')
    await writeFile(canary,replaceScratchWorkerPin(await readFile(canary,'utf8'),target,info.workerSha256))
    const entry=info.npm.entry
    await writeFile(catalog,replaceScratchCatalog(await readFile(catalog,'utf8'),{[target]:entry}))
    const env={}
    for(const [name,value] of Object.entries(process.env)){
      if(['path','systemroot','windir','temp','tmp','tmpdir','lang','lc_all','comspec','pathext'].includes(name.toLowerCase()))env[name]=value
    }
    Object.assign(env,{HOME:home,USERPROFILE:home,NODE_OPTIONS:'',DVR_OCR_ACCEPTANCE_CHILD:'1'})
    if(process.platform==='win32'){
      env.HOMEDRIVE=parse(home).root.replace(/[\\/]$/,'')
      env.HOMEPATH=home.slice(env.HOMEDRIVE.length)
    }
    const run=spawnSync(process.execPath,[await realpath(join(root,'run.mjs')),'--child',stage,bmp,opts['--expected']],{
      cwd:root,env,encoding:'utf8',timeout:420000,maxBuffer:2*1024*1024
    })
    assert.equal(run.status,0,run.error?.message??run.stderr??'child failed')
    const marker=run.stdout.split(/\r?\n/).filter(line=>line.startsWith('DVR_STAGED_ACCEPTANCE='))
    assert.equal(marker.length,1,'child did not return one acceptance marker; stdout='+run.stdout.slice(-2000)+'; stderr='+run.stderr.slice(-2000))
    const result=JSON.parse(marker[0].slice('DVR_STAGED_ACCEPTANCE='.length))
    assert.equal(result.archiveSha256,info.archive.sha256)
    assert.equal(result.workerSha256,info.workerSha256)
    assert.equal(result.distributionReady,false)
    assert.deepEqual([await digest(sourceCanary),await digest(sourceCatalog)],before)
    await writeFile(report,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
    console.log(marker[0])
  } finally {await rm(root,{recursive:true,force:true})}
}

async function child(stage,bmp,expected) {
  assert.equal(process.env.DVR_OCR_ACCEPTANCE_CHILD,'1')
  const root=fileURLToPath(new URL('.',import.meta.url))
  assert.equal(await realpath(process.cwd()),await realpath(root))
  assert.equal(await realpath(homedir()),await realpath(join(root,'home')),'non-isolated home; refusing installation')
  const {info,npmPayload}=await loadStage(stage)
  const realFetch=globalThis.fetch.bind(globalThis)
  let payload=npmPayload,downloadCalls=0
  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),info.npm.entry.url,'external network disabled')
    assert.equal(options.credentials,'omit')
    assert.equal(options.redirect,'manual')
    downloadCalls++
    return new Response(payload,{headers:{'content-length':String(payload.length)}})
  }
  // Import only after intercepting fetch, since the real download module
  // captures its default fetch at import time.
  const {installOptionalOcrRoutes,OPTIONAL_OCR_ROUTE}=await import('./lib/optional-ocr-routes.js')
  const {optionalOcrStatus,mutateOptionalOcr}=await import('./lib/optional-ocr-engines.js')
  const {localNativeOcrInstallPaths}=await import('./lib/native-ocr-installation.js')
  const {verifyNativeOcrAssets}=await import('./lib/native-ocr-integrity.js')
  const {verifyExperimentalNativeOcrBinary}=await import('./lib/native-ocr-canary.js')
  const {encodeNativeOcrRgbFrame,runIsolatedLocalOcr}=await import('./lib/native-ocr-supervisor.js')
  const phases=[]
  let route
  installOptionalOcrRoutes({inject(_deps,fn){fn({
    effect(f){return f()},
    webServer:{register(def){assert.equal(route,undefined);route=def;return ()=>{}}},
  })}}, {
    statusReader:()=>optionalOcrStatus({probeSystem:async()=>false}),
    // Test-only diagnostic around the *real* mutator, not a fake adapter.
    // Never print filesystem paths, payloads or process environment to CI.
    mutate:async args=>{
      try{return await mutateOptionalOcr(args)}
      catch(error){
        if(args.action==='uninstall'){
          const code=/^[A-Z_]{2,24}$/.test(String(error?.code??''))?error.code:'UNCLASSIFIED'
          const message=String(error?.message??'')
          const kind=message.includes('refusing to remove changed OCR directory')?'OWNERSHIP_CHANGED'
            :message.includes('refusing to move unowned OCR directory')?'UNOWNED'
            :message.includes('not installed')?'NOT_INSTALLED':'FILESYSTEM_OR_INTERNAL'
          console.error('DVR_STAGED_UNINSTALL_DIAGNOSTIC='+JSON.stringify({code,kind,target}))
        }
        throw error
      }
    },
  })
  assert.equal(route.path,OPTIONAL_OCR_ROUTE)
  const server=createServer((req,res)=>{
    if(req.url.split('?')[0]!==route.path){res.writeHead(404);res.end();return}
    Promise.resolve(route.handler(req,res)).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end()})
  })
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done)})
  try {
    const origin='http://127.0.0.1:'+server.address().port+route.path
    async function request(method='GET',action,token,status=200){
      const response=await realFetch(origin+(action?'?engine=ppocrv6&action='+action:''),{
        method,headers:token?{'x-dsh-vision-router-ocr-token':token,'sec-fetch-site':'same-origin'}:{},
        signal:AbortSignal.timeout(210000)
      })
      const body=await response.json()
      assert.equal(response.status,status,body.error)
      return body
    }
    const paths=localNativeOcrInstallPaths()
    assert.ok(paths.root.startsWith(join(root,'home'))||paths.root.startsWith(join(homedir(),'.dsh-vision-router')))
    const initial=await request()
    assert.equal(initial.ppocrv6.installed,false);assert.equal(initial.ppocrv6.canDownload,true)
    phases.push('fresh-isolated-home')
    const installed=await request('POST','download',initial.token)
    assert.equal(installed.ok,true);assert.equal(installed.installed,true)
    const state=await request()
    assert.equal(state.ppocrv6.installed,true);assert.equal(state.ppocrv6.canDownload,false)
    const check=await verifyExperimentalNativeOcrBinary(paths.binaryPath)
    assert.equal(check.digest,info.workerSha256)
    assert.equal((await verifyNativeOcrAssets(paths.modelDir)).checked,5)
    assert.deepEqual(JSON.parse(await readFile(join(paths.root,'MANIFEST.json'),'utf8')),info.manifest)
    for(const [name,fact] of Object.entries(info.manifest.files)){
      assert.match(name,/^(?:models\/)?[A-Za-z0-9._-]+$/)
      assert.ok(!name.split('/').some(x=>x==='.'||x==='..'))
      const bytes=await readFile(join(paths.root,name))
      assert.equal(bytes.length,fact.bytes);assert.equal(sha(bytes),fact.sha256)
    }
    assert.equal(await digest(join(paths.root,'SBOM.cdx.json')),info.sbomSha256)
    phases.push('download-verification-real-install','manifest-model-license-sbom-readback')
    await request('POST','download',initial.token,403)
    assert.equal(downloadCalls,1);phases.push('old-token-rejected')
    const {rgb,width,height}=decodeBmp(await readFile(bmp))
    const result=await runIsolatedLocalOcr(encodeNativeOcrRgbFrame(rgb,width,height),{
      executable:paths.binaryPath,args:[paths.modelDir],timeoutMs:22000,
    })
    assert.equal(result.engine,'ncnn')
    assert.equal(result.text.replace(/\s+/g,''),expected.replace(/\s+/g,''))
    phases.push('installed-worker-real-ocr')
    payload=Buffer.from(npmPayload);payload[Math.floor(payload.length/2)]^=0xff
    const denied=await request('POST','download',state.token,409)
    assert.match(denied.error,/integrity mismatch/)
    assert.equal(await digest(paths.binaryPath),info.workerSha256)
    const after=await request()
    assert.equal(after.ppocrv6.installed,true);assert.equal(downloadCalls,2)
    phases.push('tampered-download-rejected-installed-worker-unchanged')
    payload=npmPayload.subarray(0,npmPayload.length-1)
    const wrongSize=await request('POST','download',after.token,409)
    assert.match(wrongSize.error,/size mismatch/)
    assert.equal(await digest(paths.binaryPath),info.workerSha256)
    const afterSize=await request()
    assert.equal(afterSize.ppocrv6.installed,true);assert.equal(downloadCalls,3)
    phases.push('wrong-size-download-rejected-installed-worker-unchanged')
    const removed=await request('POST','uninstall',afterSize.token)
    assert.equal(removed.ok,true);assert.equal(removed.installed,false)
    await assert.rejects(lstat(paths.root),{code:'ENOENT'})
    const final=await request()
    assert.equal(final.ppocrv6.installed,false);assert.equal(final.ppocrv6.canDownload,true)
    phases.push('uninstall-and-empty-status')
    console.log('DVR_STAGED_ACCEPTANCE='+JSON.stringify({
      schemaVersion:1,target,archiveSha256:info.archive.sha256,workerSha256:info.workerSha256,
      actualRecognition:result.text,confidence:result.confidence,phases,downloadCalls,
      localHttpRoute:true,realInstaller:true,realWorker:true,injectedHttps:true,
      actualPublicHttps:false,realDesktopHost:false,exactArchiveDesktopGuiVerified:false,
      distributionReady:false,ownerPublicationAuthorized:false,
    }))
  }finally{
    globalThis.fetch=realFetch
    await new Promise(done=>{server.close(done);server.closeAllConnections?.()})
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(resolve(process.argv[1]))).href){
  const args=process.argv.slice(2)
  const flow=args[0]==='--child'?child(...args.slice(1)):parent(args)
  flow.catch(error=>{console.error('DVR_STAGED_ACCEPTANCE_FAILED:',error.stack??error.message);process.exitCode=1})
}

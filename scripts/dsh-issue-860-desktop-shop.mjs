import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// #860: actual Shop RPC within an isolated Windows Desktop Host, no Electron renderer.
// Build the same Desktop development project used by the existing accepted smoke.
const root = resolve(process.env.DSH_SOURCE_ROOT || '')
assert.ok(process.env.DSH_SOURCE_ROOT, 'DSH_SOURCE_ROOT required')
const versions = Object.freeze({
  '0.2.2-rc.1': '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db',
  '0.2.2-rc.4': '3f321d32bfe382212a8ed8785c1d47a5a300aa23',
})
const version = process.env.DSH_EXPECTED_VERSION || '0.2.2-rc.4'
const expected = versions[version]
assert.ok(expected,'unreviewed Host version')
const withShop = true
const throughShop = process.env.DVR_860_DIRECT_CONTROL !== '1'
assert.equal(process.platform,'win32')
assert.equal(execFileSync('git', ['-C',root,'rev-parse','HEAD'], {encoding:'utf8'}).trim(), expected)
const spec = 'dsh-vision-router@3.4.0'
const name = 'dsh-vision-router'
const temp = mkdtempSync(join(tmpdir(), 'dvr-860-live-'))
mkdirSync(join(temp,'workspace'))
const env = {
  ...process.env,
  DSH_HOME: join(temp,'.dsh'),
  DSH_AGENTS_HOME: join(temp,'.agents'),
  DSH_TELEMETRY_MODE: 'DISABLED',
  DSH_CLIENT_VERSION: version,
  DEEPSEEK_API_KEY: 'keyless-dvr-860-no-call',
  TSX_TSCONFIG_PATH: join(root,'tsconfig.json'),
}
const project=join(temp,'project')
const home=env.DSH_HOME
const readJson=path=>JSON.parse(readFileSync(path,'utf8'))
const importDsh=path=>import(pathToFileURL(join(root,path)).href)
const {prepareDevelopmentProject}=await importDsh('apps/desktop/scripts/development-project.ts')
const {DesktopProjectManager}=await importDsh('apps/desktop/src/project-manager.ts')
const {resolveDesktopPaths}=await importDsh('apps/desktop/src/paths.ts')
const {DesktopHostProcess}=await importDsh('apps/desktop/src/host-process.ts')
const {DESKTOP_HOST_PROTOCOL_VERSION}=await importDsh('apps/desktop/src/host-protocol.ts')
let host, hostFailure, profilePath
const operations=[]
const shopDisruptions=[]
// Fixed test catalog, not a claim about today's public Shop catalog. The
// actual Shop validates this pointer and downloads the real npm release.
let catalog
if (throughShop) {
  const routes = new Map()
  function data(prefix, value) {
    const body=JSON.stringify(value)
    const sha256=createHash('sha256').update(body).digest('hex')
    const url=prefix+'.'+sha256+'.json'
    routes.set('/v1/'+url,body)
    return {url,sha256}
  }
  const plugins=data('plugins',{schemaVersion:6,plugins:[{
    name,version:'3.4.0',source:'npm',integrity:null,
    publishedAt:'2026-11-17T00:00:00.000Z',
    repository:'https://github.com/ysr666/dsh-vision-router',
    license:null,tier:'community',metadata:'derived',added:'2026-11-17'
  }],denied:[]})
  const stars=data('stars',{stars:{}})
  const icons=data('icons',{icons:{}})
  routes.set('/v1/index.json',JSON.stringify({schemaVersion:6,builtAt:new Date().toISOString(),count:1,plugins,stars,icons}))
  catalog=createServer((request,response)=>{
    const body=routes.get(request.url)
    if (body===undefined) return response.writeHead(404).end()
    response.writeHead(200,{'content-type':'application/json'}).end(body)
  })
  await new Promise((resolveListen,reject)=>{catalog.once('error',reject);catalog.listen(0,'127.0.0.1',resolveListen)})
  env.DSH_SHOP_CATALOG_URL='http://127.0.0.1:'+catalog.address().port+'/v1/'
}
let phase='desktop-setup'
function redact(s) {
  return String(s).replace(/https?:\/\/[^\s"'<>]+/g,'[url]').replace(/(?:token|api[_-]?key|authorization|cookie)\s*[:=]\s*\S+/gi,'[redacted]').replaceAll(temp,'[profile]')
}
let origin, cookie
const packageState = result => ({
  application: result?.application, stage: result?.stage,
  version: result?.version, bundle: result?.bundle, enabled: result?.enabled,
  changed: result?.changed, error: result?.error && redact(JSON.stringify(result.error)),
  pnpmExitCode: result?.packageResult?.exitCode, pnpmTimedOut: result?.packageResult?.timedOut,
  warnings: (result?.warnings ?? []).map(redact),
})
async function rpc(method, args, timeout = 20_000) {
  const rpcId = randomUUID()
  const response = await fetch(new URL('/api/'+method,origin), {
    method:'POST', headers:{cookie,'content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId,method,payload:{args}}),
    redirect:'manual',signal:AbortSignal.timeout(timeout),
  })
  assert.equal(response.status,200,method+' HTTP status')
  const message = await response.json()
  assert.equal(message.type,'server-response')
  assert.equal(message.rpcId,rpcId)
  if (message.result?.ok!==true) {
    const error=new Error(method+' RPC failure '+redact(JSON.stringify(message.result?.error)))
    error.code=message.result?.error?.code
    throw error
  }
  return message.result.value
}
async function route(path) {
  const res=await fetch(new URL(path,origin),{headers:{cookie},cache:'no-store',signal:AbortSignal.timeout(10_000)})
  const status=res.status
  const body=await res.json().catch(()=>undefined)
  return {status,ok:body?.ok===true}
}
async function bundles() {
  const list=await rpc('pluginManager/listBundles',{})
  assert.ok(Array.isArray(list),'listBundles must return an array')
  return list.find(row=>row.name===name)
}
async function snapshot(label) {
  const result={label,elapsedMs:Date.now()-startedAt,operations:operations.map(r=>r.operation)}
  if (profilePath) {
    try {
      const manifest=readJson(join(profilePath,'package.json'))
      result.packagePaths=Object.fromEntries(['dsh-plugin-shop',name].map(n=>[n,{
        installedManifest:existsSync(join(profilePath,'node_modules',n,'package.json')),
        ignoredManifest:existsSync(join(profilePath,'node_modules','.ignored',n,'package.json')),
      }]))
      result.disk=Object.fromEntries(['dsh-plugin-shop',name].map(n=>[n,{dependency:manifest.dependencies?.[n]??null,selected:manifest.dsh?.profile?.bundles?.includes(n)??false}]))
    } catch (error) {result.diskError=redact(error.message)}
  }
  if (origin && cookie) {
    try {
      const rows=await rpc('pluginManager/listBundles',{},5000)
      result.bundles=rows.filter(row=>[name,'dsh-plugin-shop'].includes(row.name)).map(row=>({
        name:row.name,version:row.version,enabled:row.enabled,installed:row.installed,
        error:row.error&&redact(JSON.stringify(row.error)),rows:row.rows?.map(r=>({id:r.rowId,entry:!!r.entryId}))
      }))
    } catch(error){result.bundleError=redact(error.message)}
    try {
      const rows=await rpc('pluginManager/listPlugins',{},5000)
      if(Array.isArray(rows)) result.plugins=rows.filter(row=>/vision-router|shop/i.test(row.moduleName??'')).map(row=>({entryId:row.entryId,moduleName:row.moduleName,enabled:row.enabled,fiberPhase:row.fiberPhase,error:row.error&&redact(JSON.stringify(row.error))}))
    } catch(error){result.pluginError=redact(error.message)}
    for(const [key,path] of [['logs','/_dsh/vision-router/logs'],['settings','/_dsh/vision-router/local-settings']]){
      try{result[key]=await route(path)}catch(error){result[key]=redact(error.message)}
    }
  }
  console.log('DVR_860_SNAPSHOT='+JSON.stringify(result))
  return result
}
const startedAt=Date.now()
async function assertShopHealthy() {
  const list=await rpc('pluginManager/listBundles',{})
  const shop=list.find(row=>row.name==='dsh-plugin-shop')
  assert.equal(shop?.version,'0.9.4','Shop version')
  assert.equal(shop?.installed,true,'Shop installed')
  assert.equal(shop?.enabled,true,'Shop enabled')
  assert.ok(!shop.error,'Shop bundle must remain resolvable')
  assert.ok(shop.rows?.some(row=>row.rowId==='shop' && row.entryId),'Shop loader entry')
  // A real remote call, not just the disk manifest.
  await rpc('shop/installedSpecs',{})
}
async function assertHealthy() {
  assert.ok(!hostFailure,'Host must remain alive: '+redact(hostFailure?.message??''))
  for (const path of ['/_dsh/vision-router/logs','/_dsh/vision-router/local-settings']) {
    const state=await route(path)
    assert.equal(state.status,200,path)
    assert.equal(state.ok,true,path)
  }
}
try {
  mkdirSync(home,{recursive:true})
  Object.assign(process.env,env)
  const pnpmVersion=readJson(join(root,'apps/desktop/node_modules/pnpm/package.json')).version
  prepareDevelopmentProject({
    projectDir:project,cliDir:join(root,'apps/cli'),hostDir:join(root,'apps/desktop-host'),
    dependencyDir:join(root,'node_modules/.pnpm/node_modules'),
    release:{schemaVersion:1,version,pnpmVersion,nodeVersion:process.versions.node,hostProtocolVersion:DESKTOP_HOST_PROTOCOL_VERSION},
    target:'win-x64',
  })
  cpSync(join(root,'packages/skill/skill-office/assets'),join(temp,'runtime/office-skills'),{recursive:true})
  const bundledNodeDir=join(temp,'runtime/primary-runtime/dependencies/node/bin')
  mkdirSync(bundledNodeDir,{recursive:true})
  cpSync(process.execPath,join(bundledNodeDir,'node.exe'))
  const paths=resolveDesktopPaths(home)
  profilePath=paths.profile
  const manager=new DesktopProjectManager(paths,{dsh:project})
  await manager.applyRelease()
  // Do not manually populate node_modules or invoke an unscoped pnpm: it
  // produced an inconsistent install layout in the previous experiment.
  // Seed Shop using the same official Desktop PluginManager/pnpm as DVR.
  const pnpmEntry=join(root,'apps/desktop/node_modules/pnpm/bin/pnpm.mjs')
  writeFileSync(join(paths.profile,'cordis.patch.yml'),'- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 19681\n')
  const launch=async()=>{
    hostFailure=undefined
    host=new DesktopHostProcess(process.execPath,project,paths.profile,undefined,env,
      error=>{hostFailure=error;console.error('DVR_860_DESKTOP_HOST_ERROR='+redact(error.diagnostic??error.message))},
      undefined,{pnpm:pnpmEntry,nodeBin:bundledNodeDir},undefined,record=>{
        operations.push(record)
        console.log('DVR_860_HOST_OPERATION='+JSON.stringify(record))
      })
    const ready=await host.start()
    const url=new URL(ready.url)
    assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'only isolated loopback Host allowed')
    const auth=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15_000)})
    assert.equal(auth.status,303,'Host authentication')
    cookie=auth.headers.get('set-cookie')?.split(';',1)[0]
    assert.ok(cookie,'missing authentication cookie')
    await auth.body?.cancel()
    origin=url.origin
  }
  phase='desktop-seed-start'
  await launch()
  const seedBefore=await rpc('pluginManager/listBundles',{})
  assert.notEqual(seedBefore.find(row=>row.name==='dsh-plugin-shop')?.installed,true,'Shop must start absent')
  phase='desktop-seed-shop'
  const seed=await rpc('pluginManager/installBundle',{spec:'dsh-plugin-shop@0.9.4',options:{requestId:randomUUID()}},480_000)
  console.log('DVR_860_SHOP_SEED='+JSON.stringify(packageState(seed)))
  assert.equal(seed?.application,'applied','official Desktop Shop seeding failed')
  assert.equal(seed?.version,'0.9.4')
  await assertShopHealthy()
  await snapshot('official-shop-seed')
  phase='desktop-restart-after-seed'
  await host.stop()
  await launch()
  phase='initial-state'
  if (withShop) {
    const installed = await rpc('pluginManager/listBundles',{})
    const shop=installed.find(row=>row.name==='dsh-plugin-shop')
    assert.equal(shop?.version,'0.9.4','Shop version')
    assert.equal(shop?.installed,true,'Shop must be installed')
    assert.equal(shop?.enabled,true,'Shop must be enabled')
    assert.ok(!shop.error,'Shop must load without a bundle error')
    assert.ok(shop.rows?.some(row=>row.rowId==='shop' && row.entryId),'Shop must have a real loader entry')
    console.log('DVR_860_SHOP='+JSON.stringify({version:shop.version,installed:shop.installed,enabled:shop.enabled}))
  }
  assert.notEqual((await bundles())?.installed,true,'DVR must start absent')
  assert.notEqual((await route('/_dsh/vision-router/logs')).status,200,'DVR route must start absent')
  phase='hot-install'
  if (throughShop) {
    // Same real Remote entrypoints as Shop's browser client. The exact
    // user profile and original catalog snapshot are still unknown.
    const started=await rpc('shop/installStart',{args:{name,version:'3.4.0',source:'npm',acknowledged:true}},60_000)
    console.log('DVR_860_SHOP_START='+JSON.stringify({ok:started?.ok,state:started?.state,code:started?.code,detail:redact(started?.detail??'')}))
    assert.equal(started?.ok,true,'Shop did not accept the install')
    assert.ok(started.installId,'missing Shop install ID')
    let status
    const deadline=Date.now()+480_000
    let firstDisruption
    do {
      try {
        status=await rpc('shop/installStatus',{args:{installId:started.installId}},10000)
        if(status?.found===true && ['done','failed'].includes(status.state)) break
        if(status?.found!==true) {
          shopDisruptions.push({time:Date.now()-startedAt,kind:'lost-record'})
          firstDisruption??=Date.now()
        }
      } catch(error) {
        if(error.code!=='gateway/service-unavailable') throw error
        shopDisruptions.push({time:Date.now()-startedAt,kind:error.code})
        firstDisruption??=Date.now()
      }
      if(firstDisruption && shopDisruptions.length===1) await snapshot('first-shop-disruption')
      // A temporary HMR outage and permanent loss of operation identity are
      // different failures. Observe independently of the Shop receipt.
      if(firstDisruption && Date.now()-firstDisruption>=30_000) break
      await delay(1000)
    } while(Date.now()<deadline)
    console.log('DVR_860_SHOP_TERMINAL='+redact(JSON.stringify(status??null)).slice(-16000))
    if(shopDisruptions.length) console.log('DVR_860_SHOP_DISRUPTIONS='+JSON.stringify(shopDisruptions))
    await snapshot('after-shop-operation')
    assert.equal(status?.found,true,'Shop lost installation record')
    assert.equal(status?.state,'done','Shop install did not settle successfully')
    assert.equal(shopDisruptions.length,0,'Shop became unavailable or lost record during installation')
  } else {
    const operation=await rpc('pluginManager/installBundle',{spec,options:{requestId:randomUUID()}},480_000)
    console.log('DVR_860_INSTALL='+JSON.stringify(packageState(operation)))
    assert.equal(operation?.application,'applied','live install did not apply')
    assert.equal(operation?.stage,'enable','expected enable stage')
    assert.equal(operation?.version,'3.4.0','wrong installed version')
  }
  const installed=await bundles()
  assert.equal(installed?.installed,true)
  assert.equal(installed?.enabled,true)
  assert.equal(installed?.version,'3.4.0')
  await assertHealthy()
  await snapshot('dvr-active-and-shop-check')
  await assertShopHealthy()
  phase='disable'
  const off=await rpc('pluginManager/setBundleEnabled',{name,enabled:false},90_000)
  console.log('DVR_860_DISABLE='+JSON.stringify(packageState(off)))
  assert.equal(off?.application,'applied')
  assert.equal((await bundles())?.enabled,false)
  assert.notEqual((await route('/_dsh/vision-router/logs')).status,200,'disabled route still callable')
  phase='enable'
  const on=await rpc('pluginManager/setBundleEnabled',{name,enabled:true},90_000)
  console.log('DVR_860_ENABLE='+JSON.stringify(packageState(on)))
  assert.equal(on?.application,'applied')
  assert.equal((await bundles())?.enabled,true)
  await assertHealthy()
  await assertShopHealthy()
  console.log('DVR_860_RESULT='+JSON.stringify({ok:true,host:version,hostSha:expected,profile:'desktop',platform:process.platform,shopSeed:'official-desktop-manager-and-restart',shop:'0.9.4',throughShop,package:spec,liveInstall:true,liveDisableEnable:true,processStable:true}))
} catch (error) {
  console.error('DVR_860_FAILURE='+JSON.stringify({phase,message:redact(error?.stack ?? error)}))
  await snapshot('failure').catch(error=>console.error('snapshot failed: '+redact(error.message)))
  process.exitCode=1
} finally {
  try { await host?.stop() } catch(error) {console.error('Desktop stop failed: '+redact(error.message));process.exitCode=1}
  if (catalog) { catalog.closeAllConnections(); await new Promise(resolveClose=>catalog.close(resolveClose)) }
  rmSync(temp,{recursive:true,force:true})
}

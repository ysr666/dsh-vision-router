import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// #860: invoke the actual remote PluginManager of an already-running Host.
// No Shop UI, mocked pnpm, source install, existing user profile or restart.
const root = resolve(process.env.DSH_SOURCE_ROOT || '')
assert.ok(process.env.DSH_SOURCE_ROOT, 'DSH_SOURCE_ROOT required')
const versions = Object.freeze({
  '0.2.2-rc.1': '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db',
  '0.2.2-rc.4': '3f321d32bfe382212a8ed8785c1d47a5a300aa23',
})
const version = process.env.DSH_EXPECTED_VERSION || '0.2.2-rc.4'
const expected = versions[version]
assert.ok(expected,'unreviewed Host version')
const withShop = process.env.DVR_860_WITH_SHOP === '1'
assert.equal(execFileSync('git', ['-C',root,'rev-parse','HEAD'], {encoding:'utf8'}).trim(), expected)
const spec = 'dsh-vision-router@3.4.0'
const name = 'dsh-vision-router'
const temp = mkdtempSync(join(tmpdir(), 'dvr-860-live-'))
mkdirSync(join(temp,'workspace'))
const req = createRequire(join(root,'package.json'))
const loader = pathToFileURL(req.resolve('tsx')).href
const env = {
  ...process.env,
  DSH_HOME: join(temp,'.dsh'),
  DSH_AGENTS_HOME: join(temp,'.agents'),
  DSH_TELEMETRY_MODE: 'DISABLED',
  DEEPSEEK_API_KEY: 'keyless-dvr-860-no-call',
  TSX_TSCONFIG_PATH: join(root,'tsconfig.json'),
}
let child
if (withShop) {
  // The Shop is a pre-existing bundle in the reporter's configuration.
  // The live RPC still targets the Host manager, not a mocked Shop UI.
  const setup = spawnSync(process.execPath, ['--import',loader,join(root,'apps/cli/src/bin.ts'),'plugin','--profile','web','add','dsh-plugin-shop@0.9.4'],
    {cwd:root,env,encoding:'utf8',timeout:480_000})
  if (setup.status !== 0) {
    console.error('DVR_860_SHOP_SETUP_FAILURE='+JSON.stringify({status:setup.status,signal:setup.signal,message:redact(setup.error?.message ?? '')}))
    console.error(redact((setup.stdout ?? '')+'\n'+(setup.stderr ?? '')).slice(-16000))
    rmSync(temp,{recursive:true,force:true})
    process.exit(1)
  }
}
child = spawn(process.execPath, ['--import',loader,join(root,'apps/cli/src/bin.ts'),'web','--no-open','--port','0'],
  { cwd: temp, env, stdio: ['ignore','pipe','pipe'] })
const logs = []
let launchUrl
let phase = 'startup'
function redact(s) {
  return String(s).replace(/https?:\/\/[^\s"'<>]+/g, '[url]').replace(/(?:token|api[_-]?key|authorization|cookie)\s*[:=]\s*\S+/gi,'[redacted]').replaceAll(temp,'[profile]')
}
for (const stream of [child.stdout,child.stderr]) {
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    rest += chunk
    const lines = rest.split(/\r?\n/)
    rest = lines.pop() || ''
    for (const line of lines) {
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(line)
      if (match) launchUrl = match[1]
      if (/error|inactive context|warning|vision-router|at\s+\S+\s*\(/i.test(line) && !match) {
        logs.push(redact(line).slice(0,1800))
        if (logs.length > 180) logs.shift()
      }
    }
  })
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
  assert.equal(message.result?.ok,true,method+' RPC failure '+redact(JSON.stringify(message.result?.error)))
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
async function assertHealthy() {
  assert.equal(child.exitCode,null,'Host must remain alive')
  for (const path of ['/_dsh/vision-router/logs','/_dsh/vision-router/local-settings']) {
    const state=await route(path)
    assert.equal(state.status,200,path)
    assert.equal(state.ok,true,path)
  }
}
try {
  for (let i=0;i<180&&!launchUrl;i++) {
    assert.equal(child.exitCode,null,'Host exited before ready')
    await delay(500)
  }
  assert.ok(launchUrl,'Host did not become ready')
  const url=new URL(launchUrl)
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'only isolated loopback Host allowed')
  const auth=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15_000)})
  assert.equal(auth.status,303,'Host authentication')
  cookie=auth.headers.get('set-cookie')?.split(';',1)[0]
  assert.ok(cookie,'missing authentication cookie')
  await auth.body?.cancel()
  origin=url.origin
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
  const operation=await rpc('pluginManager/installBundle',{spec,options:{requestId:randomUUID()}},480_000)
  console.log('DVR_860_INSTALL='+JSON.stringify(packageState(operation)))
  assert.equal(operation?.application,'applied','live install did not apply')
  assert.equal(operation?.stage,'enable','expected enable stage')
  assert.equal(operation?.version,'3.4.0','wrong installed version')
  const installed=await bundles()
  assert.equal(installed?.installed,true)
  assert.equal(installed?.enabled,true)
  await assertHealthy()
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
  console.log('DVR_860_RESULT='+JSON.stringify({ok:true,host:version,hostSha:expected,shop:withShop?'0.9.4':null,package:spec,liveInstall:true,liveDisableEnable:true,processStable:true}))
} catch (error) {
  console.error('DVR_860_FAILURE='+JSON.stringify({phase,message:redact(error?.stack ?? error)}))
  console.error(logs.join('\n'))
  process.exitCode=1
} finally {
  if (child.exitCode===null && child.signalCode===null) {
    const closed=new Promise(resolveClose=>child.once('close',resolveClose))
    child.kill('SIGTERM')
    const force=setTimeout(()=>child.kill('SIGKILL'),10_000)
    try { await closed } finally { clearTimeout(force) }
  }
  rmSync(temp,{recursive:true,force:true})
}

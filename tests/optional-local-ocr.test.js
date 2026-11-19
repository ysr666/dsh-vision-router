import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { approvedNativeArchive, downloadVerifiedNativeArchive } from '../src/lib/native-ocr-download.js'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, writeFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  managedTesseractPaths, optionalOcrStatus, mutateOptionalOcr, installTesseract, uninstallTesseract, uninstallNative, retryNativeOcrWindowsFs, nodeChildEnvironment, downloadAndInstallNative,
  OPTIONAL_TESSERACT_PACKAGES,
} from '../src/lib/optional-ocr-engines.js'
import { installOptionalOcrRoutes, OPTIONAL_OCR_ROUTE } from '../src/lib/optional-ocr-routes.js'

function response() {
  return {
    headers: {},
    status: 0,
    setHeader(key, value) { this.headers[key] = value },
    writeHead(status, headers) { this.status = status; this.headers = { ...this.headers, ...headers } },
    end(body) { this.body = String(body ?? ''); },
    get value() { return JSON.parse(this.body) },
  }
}
function setupRoute(mutate) {
  const routes = new Map()
  const ctx = {
    inject(_deps, cb) {
      cb({ effect: register => register(), webServer: {
        register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
      } })
    },
  }
  let tokens = 0
  installOptionalOcrRoutes(ctx, {
    statusReader: async () => ({
      ok: true, tesseract: { installed: false, managedInstalled: false },
      ppocrv6: { installed: false, supported: true },
    }),
    mutate,
    tokenFactory: () => 'ocr-token-' + ++tokens,
  })
  return routes.get(OPTIONAL_OCR_ROUTE)
}
function request(method, url, token, opts = {}) {
  return Object.assign(Readable.from(opts.body ? [opts.body] : []), {
    method, url: url ?? OPTIONAL_OCR_ROUTE,
    headers: { host: 'localhost:3000', 'sec-fetch-site': 'same-origin',
      'x-dsh-vision-router-ocr-token': token, ...opts.headers },
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
  })
}
test('new OCR management route is strictly local only, including GET', async () => {
  let called = false
  const route = setupRoute(async () => { called = true; return { ok: true } })
  for (const method of ['GET','POST']) {
    const res = response()
    await route.handler(request(method, OPTIONAL_OCR_ROUTE + '?engine=tesseract&action=uninstall',
      'ocr-token-1', { remoteAddress: '203.0.113.40' }), res)
    assert.equal(res.status, 403)
    assert.equal(called, false)
  }
})
test('install requires local token, exact engine, and rotates token to defeat replay', async () => {
  const calls = []
  const route = setupRoute(async input => { calls.push(input); return { ok: true } })
  const get = response()
  await route.handler(request('GET'), get)
  assert.equal(get.status, 200)
  assert.equal(get.value.token, 'ocr-token-1')
  let r = response()
  await route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=tesseract&action=install','bad'), r)
  assert.equal(r.status, 403)
  r = response()
  await route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=tesseract&action=install','ocr-token-1',
    { headers: { 'sec-fetch-site': 'cross-site' } }), r)
  assert.equal(r.status, 403)
  r = response()
  await route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=evil&action=install','ocr-token-1'), r)
  assert.equal(r.status, 400)
  r = response()
  await route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=tesseract&action=install','ocr-token-1'), r)
  assert.equal(r.status, 200)
  assert.deepEqual(calls, [{ engine:'tesseract', action:'install', archive:undefined }])
  r = response()
  await route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=tesseract&action=uninstall','ocr-token-1'), r)
  assert.equal(r.status, 403)
  const newer = response()
  await route.handler(request('GET'), newer)
  assert.equal(newer.value.token,'ocr-token-2')
})
test('PP-OCRv6 archive upload is a bounded raw local POST, never an arbitrary filesystem path', async () => {
  const inputs = []
  const route = setupRoute(async input => { inputs.push(input); return { ok:true } })
  const archive = Buffer.alloc(1024, 0x11)
  let r = response()
  await route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=ppocrv6&action=install',
    'ocr-token-1',{body:archive,headers:{'content-type':'application/octet-stream'}}),r)
  assert.equal(r.status,200)
  assert.equal(inputs.length,1)
  assert.deepEqual(inputs[0].archive,archive)
  r = response()
  await route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=ppocrv6&action=install',
    'ocr-token-2',{body:archive,headers:{'content-type':'application/json'}}),r)
  assert.notEqual(r.status,200)
})
test('installation operations serialize, and never execute during a mere status read', async () => {
  let complete
  const first = new Promise(resolve => { complete=resolve })
  const route = setupRoute(async () => { await first; return {ok:true} })
  const a = response()
  const active = route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=tesseract&action=install','ocr-token-1'), a)
  const second = response()
  await route.handler(request('POST', OPTIONAL_OCR_ROUTE+'?engine=tesseract&action=install','ocr-token-1'), second)
  assert.equal(second.status,409)
  complete()
  await active
  assert.equal(a.status,200)
})
test('optional engines are never installed by default and system packages are not owned', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dvr-ocr-home-'))
  try {
    const state = await optionalOcrStatus({ home, probeSystem: async () => false })
    assert.equal(state.tesseract.installed,false)
    assert.equal(state.tesseract.canUninstall,false)
    assert.equal(state.ppocrv6.installed,false)
    assert.equal(state.ppocrv6.canUninstall,false)
    const system = await optionalOcrStatus({ home, probeSystem: async () => true })
    assert.equal(system.tesseract.systemInstalled,true)
    assert.equal(system.tesseract.managedInstalled,false)
    assert.equal(system.tesseract.canUninstall,false)
    assert.equal(system.tesseract.canInstall,false, 'a complete system Tesseract never requires a duplicate private installation')
    const paths = managedTesseractPaths({ home })
    assert.ok(paths.root.startsWith(home))
  } finally { await rm(home,{recursive:true,force:true}) }
})
test('invalid operations never invoke installers, including PP installs with no verified bundle', async () => {
  let invocations=0
  for (const [engine,action,archive] of [['evil','install',undefined],['ppocrv6','install',undefined],['tesseract','purge',undefined]]) {
    await assert.rejects(mutateOptionalOcr({engine,action,archive,adapters:{
      installTesseract:async()=>{invocations++},installNativeBundle:async()=>{invocations++},
    }}))
  }
  assert.equal(invocations,0)
})
test('Tesseract installation pins exact versions and SHA-512, no global package manager changes', () => {
  for(const [name,[version,integrity]] of Object.entries(OPTIONAL_TESSERACT_PACKAGES)){
    assert.ok(name && version && integrity.startsWith('sha512-'))
  }
})

test('Tesseract install reuses complete system binary without npm or filesystem mutation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dvr-ocr-system-'))
  try {
    const result = await installTesseract({
      home, probeSystem: async () => true,
      npm: async () => { throw Error('must not call npm when system OCR works') },
      exec: async () => { throw Error('must not install private OCR when system OCR works') },
    })
    assert.deepEqual(result, { ok: true, installed: false, reusedSystem: true, engine: 'tesseract' })
    const managed = await optionalOcrStatus({ home, probeSystem: async () => true })
    assert.equal(managed.tesseract.systemInstalled, true)
    assert.equal(managed.tesseract.managedInstalled, false)
  } finally { await rm(home, { recursive:true, force:true }) }
})

test('corrupted installed PP-OCRv6 worker/model can still be removed by owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dvr-native-delete-'))
  const root = join(home, '.dsh-vision-router', 'ocr', 'ppocrv6-small')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'SOURCE-NOTICE.md'),
      '# Locally installed native OCR assets\nRuntime: Tencent/ncnn @ pinned\n')
    // The worker and models are deliberately absent/corrupted.
    const resolveNativePaths = () => ({ root, binaryPath: join(root,'worker'), modelDir: join(root,'models') })
    const before = await optionalOcrStatus({ home, probeSystem: async () => false, resolveNativePaths })
    assert.equal(before.ppocrv6.installed, false)
    assert.equal(before.ppocrv6.damaged, true)
    assert.equal(before.ppocrv6.canUninstall, true)
    const result = await uninstallNative({ home, resolvePaths: resolveNativePaths })
    assert.equal(result.installed, false)
    await assert.rejects(lstat(root), { code: 'ENOENT' })
  } finally { await rm(home, { recursive: true, force: true }) }
})
test('PP-OCRv6 uninstall refuses unowned directories and symlinks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dvr-native-unowned-'))
  const root = join(home, '.dsh-vision-router', 'ocr', 'ppocrv6-small')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'unrelated-owner-file'), 'keep')
    await assert.rejects(uninstallNative({ home, resolvePaths: () => ({ root }) }), /unowned/)
    assert.equal((await lstat(join(root, 'unrelated-owner-file'))).isFile(), true)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('Electron child Node mode is opt-in and inherited preload flags are cleared', () => {
  const env = { PATH: '/usr/local/bin', NODE_OPTIONS: '--require unsafe-preload.js' }
  const electron = nodeChildEnvironment({ env, electron: '33.0.0' })
  assert.equal(electron.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(electron.NODE_OPTIONS, '')
  assert.equal(electron.PATH, env.PATH)
  const normal = nodeChildEnvironment({ env, electron: undefined })
  assert.equal(normal.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(normal.NODE_OPTIONS, '')
})

test('damaged plugin Tesseract is removable but cannot be silently overwritten', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dvr-tess-damaged-'))
  try {
    const paths = managedTesseractPaths({ home })
    await mkdir(paths.root, { recursive: true })
    await writeFile(paths.manifest, JSON.stringify({ kind: 'dvr-tesseract-js-v1', version: '7.0.0' }))
    const before = await optionalOcrStatus({ home, probeSystem: async () => false })
    assert.equal(before.tesseract.installed, false)
    assert.equal(before.tesseract.damaged, true)
    assert.equal(before.tesseract.canInstall, false)
    assert.equal(before.tesseract.canUninstall, true)
    await uninstallTesseract({ home })
    const after = await optionalOcrStatus({ home, probeSystem: async () => false })
    assert.equal(after.tesseract.canInstall, true)
    assert.equal(after.tesseract.canUninstall, false)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('online native installation stays unavailable without an approved public artifact', async () => {
  assert.equal(approvedNativeArchive('linux', 'x64'), null)
  assert.equal(approvedNativeArchive('darwin', 'x64'), null)
  await assert.rejects(downloadAndInstallNative({ entry: null, fetchImpl: () => { throw Error('must not fetch') } }), /no approved public archive/)
  await assert.rejects(mutateOptionalOcr({ engine:'tesseract', action:'download' }), /invalid OCR operation/)
})
test('reviewed download verifies bounded archive bytes before invoking the existing installer', async () => {
  const bytes = Buffer.alloc(256, 7)
  const entry = {
    url:'https://github.com/ysr666/dsh-vision-router/releases/download/native-test-v1/ppocrv6-small-darwin-arm64.tar.gz',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  let called = false
  const result = await downloadAndInstallNative({ entry,
    fetchImpl: async () => new Response(bytes),
    install: async archive => { called = true; assert.deepEqual(archive, bytes); return {ok:true} }
  })
  assert.equal(result.ok,true)
  assert.equal(called,true)
  called=false
  await assert.rejects(downloadAndInstallNative({ entry, fetchImpl: async () => new Response(Buffer.alloc(256,8)),
    install:async()=>{called=true} }), /integrity mismatch/)
  assert.equal(called,false)
  await assert.rejects(downloadVerifiedNativeArchive(entry,{fetchImpl:async()=>new Response(Buffer.alloc(257))}),/exceeds reviewed size/)
  await assert.rejects(downloadVerifiedNativeArchive(entry,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://example.org/fake'}})}),/untrusted.*redirect/)
})

// Windows transient native-file locks: owner identity and safe bounded retries.
// Unsupported CI platforms inject only the isolated fixture path; production
// resolveNativePaths() remains unchanged and is checked on real Windows CI.
const transient = code => Object.assign(new Error('temporary OS file lock'), { code })
test('Windows owner-bound native OCR uninstall removes a realistic fresh directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dvr-win-ocr-uninstall-'))
  const root = join(home, '.dsh-vision-router', 'ocr', 'ppocrv6-small')
  try {
    await mkdir(join(root, 'models'), { recursive: true })
    await writeFile(join(root, 'SOURCE-NOTICE.md'),
      '# Locally installed native OCR assets\nRuntime: Tencent/ncnn @ pinned\n')
    await writeFile(join(root, 'worker.exe'), 'fake unit-test executable, never run')
    await writeFile(join(root, 'models', 'dummy.param'), 'fake model')
    assert.equal((await uninstallNative({ home, resolvePaths: () => ({ root }) })).installed, false)
    await assert.rejects(lstat(root), { code: 'ENOENT' })
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5 }) }
})
test('Windows retries bounded transient rename failures before the owned move', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dvr-win-ocr-retry-move-'))
  const root = join(home, '.dsh-vision-router', 'ocr', 'ppocrv6-small')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'SOURCE-NOTICE.md'),
      '# Locally installed native OCR assets\nRuntime: Tencent/ncnn @ pinned\n')
    const { moveOwnedNativeOcrDirectory } = await import('../src/lib/native-ocr-installation.js')
    let calls=0
    const result=await uninstallNative({home,platform:'win32',resolvePaths:() => ({root}),moveOwned:async(from,to)=>{
      if(calls++<2)throw transient('EPERM')
      return moveOwnedNativeOcrDirectory(from,to)
    }})
    assert.equal(result.installed,false);assert.equal(calls,3)
    await assert.rejects(lstat(root),{code:'ENOENT'})
  } finally { await rm(home,{recursive:true,force:true,maxRetries:5}) }
})
test('Windows retries only transient bounded tomb cleanup and never touches unrelated tree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dvr-win-ocr-retry-rm-'))
  const root = join(home, '.dsh-vision-router', 'ocr', 'ppocrv6-small')
  const unrelated = join(home, 'unrelated.txt')
  try {
    await mkdir(root,{recursive:true})
    await writeFile(join(root, 'SOURCE-NOTICE.md'),
      '# Locally installed native OCR assets\nRuntime: Tencent/ncnn @ pinned\n')
    await writeFile(unrelated,'must stay')
    let calls=0
    const result=await uninstallNative({home,platform:'win32',resolvePaths:() => ({root}),remove:async(tomb,opts)=>{
      assert.ok(tomb.startsWith(root+'.removing-'))
      assert.equal(opts.recursive,true)
      if(calls++<2)throw transient('EBUSY')
      return rm(tomb,opts)
    }})
    assert.equal(result.installed,false);assert.equal(calls,3)
    assert.equal((await lstat(unrelated)).isFile(),true)
    await assert.rejects(lstat(root),{code:'ENOENT'})
  } finally { await rm(home,{recursive:true,force:true,maxRetries:5}) }
})
test('Non-Windows and nontransient errors are never retried', async ()=>{
  for(const [platform,code,expected] of [
    ['darwin','EPERM',1],['win32','ENOENT',1],['win32','EPERM',3]
  ]){
    let attempts=0
    await assert.rejects(retryNativeOcrWindowsFs(async()=>{
      attempts++;throw transient(code)
    },{platform,attempts:expected,sleep:async()=>{}}),{code})
    assert.equal(attempts,expected)
  }
})

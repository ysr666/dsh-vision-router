import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  managedTesseractPaths, optionalOcrStatus, mutateOptionalOcr,
  OPTIONAL_TESSERACT_PACKAGES,
} from '../src/lib/optional-ocr-engines.js'
import { installOptionalOcrRoutes, OPTIONAL_OCR_ROUTE } from '../src/lib/optional-ocr-routes.js'
import { classifyWebRouteCapability } from '../src/lib/web-capability-boundary.js'

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

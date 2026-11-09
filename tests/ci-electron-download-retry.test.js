import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { resolveCiElectronBinary } from '../scripts/ci-electron-download-retry.mjs'

const LOCKED_INSTALL = join(dirname('/safe/locked-package/electron/index.js'), 'install.js')

const missingBinary = () => new Error('Electron failed to install correctly. Please delete node_modules/electron')
const makeRequire = () => {
  let ready = false
  let reads = 0
  const load = (name) => {
    assert.equal(name, 'electron')
    reads++
    if (!ready) throw missingBinary()
    return '/verified/pnpm-locked/electron'
  }
  load.resolve = () => '/safe/locked-package/electron/index.js'
  return { load, enable: () => {ready = true}, reads: () => reads }
}

test('healthy Electron never invokes installation or retries', async () => {
  const f = makeRequire()
  f.enable()
  const result = await resolveCiElectronBinary(f.load, {
    ci: true, exists: () => true,
    runInstall: () => { throw new Error('should not install') },
  })
  assert.equal(result, '/verified/pnpm-locked/electron')
  assert.equal(f.reads(), 1)
})

test('non-CI or unrelated failures never invoke an Electron download', async () => {
  const f = makeRequire()
  const opt = {ci:false,exists:()=>true,runInstall:()=>{throw new Error('unexpected download')}}
  await assert.rejects(resolveCiElectronBinary(f.load,opt),/Electron failed to install correctly/)
  const unrelated = () => {throw new Error('renderer has crashed, not a binary install failure')}
  await assert.rejects(resolveCiElectronBinary(unrelated,{...opt,ci:true}),/renderer has crashed/)
})

test('CI retries only official Electron 504 and then loads the exact locked binary', async () => {
  const f = makeRequire()
  let attempts = 0
  const waits=[]
  const reports=[]
  const result = await resolveCiElectronBinary(f.load, {
    ci:true, attempts:3, exists:()=>true,
    runInstall:(entry)=>{
      assert.equal(entry, LOCKED_INSTALL)
      attempts++
      if (attempts === 1) return {status:1,stderr:'HTTPError: Response code 504 (Gateway Time-out) for https://github.com/electron/electron'}
      f.enable()
      return {status:0,stderr:''}
    },
    delay:async(ms)=>{waits.push(ms)},
    notice:s=>{reports.push(s)},
  })
  assert.equal(result,'/verified/pnpm-locked/electron')
  assert.equal(attempts,2)
  assert.deepEqual(waits,[3000])
  assert.equal(reports.length,1)
  assert.match(reports[0],/same locked package, same source/)
})

test('persistent official 504 fails closed after a bounded count', async () => {
  const f=makeRequire()
  let count=0
  await assert.rejects(resolveCiElectronBinary(f.load,{
    ci:true, attempts:3, exists:()=>true,
    runInstall:()=>{count++;return {status:1,stderr:'HTTPError: Response code 504 (Gateway Time-out)'}},
    delay:async()=>{},notice:()=>{},
  }),/HTTP 5xx\/timeout after 3 bounded/)
  assert.equal(count,3)
})

test('nontransient HTTP errors and missing installers never get retries', async () => {
  const f=makeRequire()
  let attempts=0
  await assert.rejects(resolveCiElectronBinary(f.load,{
    ci:true, exists:()=>true,
    runInstall:()=>{attempts++;return {status:1,stderr:'AssertionError: wrong renderer screenshot'}},
    delay:async()=>{},notice:()=>{},
  }),/nontransient/)
  assert.equal(attempts,1)
  await assert.rejects(resolveCiElectronBinary(f.load,{ci:true,exists:()=>false}),/installer unavailable/)
})

test('a zero installer exit without working Electron never claims an E2E pass', async () => {
  const f=makeRequire()
  await assert.rejects(resolveCiElectronBinary(f.load,{
    ci:true,exists:()=>true,
    runInstall:()=>({status:0,stderr:''}),
    delay:async()=>{},notice:()=>{},
  }),/Electron failed to install correctly/)
})

test('CI may recover from five consecutive official 504s without changing the locked Electron package', async () => {
  const f = makeRequire()
  let count = 0
  const waits = []
  const reports = []
  const result = await resolveCiElectronBinary(f.load, {
    ci: true, exists: () => true,
    runInstall: (entry) => {
      assert.equal(entry, '/safe/locked-package/electron/install.js')
      count += 1
      if (count < 6) return { status: 1, stderr: 'HTTPError: Response code 504 (Gateway Time-out)' }
      f.enable()
      return { status: 0, stderr: '' }
    },
    delay: async (ms) => waits.push(ms),
    notice: (msg) => reports.push(msg),
  })
  assert.equal(result, '/verified/pnpm-locked/electron')
  assert.equal(count, 6)
  assert.deepEqual(waits, [3000, 6000, 9000, 12000, 15000])
  assert.equal(reports.length, 5)
  assert.ok(reports.every((msg) => /same locked package, same source/.test(msg)))
})

test('official installer timeout is retryable only with bounded attempts', async () => {
  const f = makeRequire()
  let count = 0
  await assert.rejects(resolveCiElectronBinary(f.load, {
    ci: true, exists: () => true, attempts: 2,
    runInstall: () => {
      count += 1
      return { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
    },
    delay: async () => {},
    notice: () => {},
  }), /after 2 bounded CI attempts/)
  assert.equal(count, 2)
})

test('CI never accepts an unbounded Electron installer retry count', async () => {
  const f = makeRequire()
  await assert.rejects(resolveCiElectronBinary(f.load, {
    ci: true, exists: () => true, attempts: 7,
    runInstall: () => { throw new Error('should never run') },
  }), /between 1 and 6/)
})

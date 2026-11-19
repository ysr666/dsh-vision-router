import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uninstallNative, retryNativeOcrWindowsFs } from '../src/lib/optional-ocr-engines.js'

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
    assert.equal((await uninstallNative({ home })).installed, false)
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
    const result=await uninstallNative({home,platform:'win32',moveOwned:async(from,to)=>{
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
    const result=await uninstallNative({home,platform:'win32',remove:async(tomb,opts)=>{
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

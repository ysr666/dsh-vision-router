import assert from 'node:assert/strict'
import {test} from 'node:test'
import { decodeBmp,replaceOnce,replaceScratchCatalog,replaceScratchWorkerPin,assertNativePromotionState,historicalWorkerPins } from './native-ocr-staged-acceptance.mjs'
import { candidates } from './native-ocr-release-stage.mjs'

test('scratch changes require unique exact source occurrence',()=>{
  assert.equal(replaceOnce('pin=old','old','new'),'pin=new')
  assert.throws(()=>replaceOnce('old old','old','new'))
  assert.throws(()=>replaceOnce('other','old','new'))
})
test('BMP RGB bytes retain row order and padding',()=>{
  const raw=Buffer.alloc(54+8)
  raw.write('BM');raw.writeUInt32LE(54,10);raw.writeUInt32LE(40,14)
  raw.writeInt32LE(1,18);raw.writeInt32LE(2,22);raw.writeUInt16LE(1,26);raw.writeUInt16LE(24,28)
  raw.set([255,0,0,0,0,0,255,0],54)
  assert.deepEqual(decodeBmp(raw),{width:1,height:2,rgb:Buffer.from([255,0,0,0,0,255])})
  assert.throws(()=>decodeBmp(raw.subarray(0,61)))
})


// macOS TMPDIR (and /tmp) may have a symlinked ancestor. The Node
// ESM module URL is canonical but argv[1] retains the alias.
test('entrypoint executes through symlinked path rather than exiting silently', {skip:process.platform==='win32'},async()=>{
  const {mkdtemp,symlink,rm}=await import('node:fs/promises')
  const {tmpdir}=await import('node:os')
  const {join}=await import('node:path')
  const {fileURLToPath}=await import('node:url')
  const {spawnSync}=await import('node:child_process')
  const root=await mkdtemp(join(tmpdir(),'dvr-entry-alias-'))
  try{
    const entry=fileURLToPath(new URL('./native-ocr-staged-acceptance.mjs',import.meta.url))
    const alias=join(root,'entry.mjs')
    await symlink(entry,alias)
    const result=spawnSync(process.execPath,[alias,'--invalid'],{encoding:'utf8',timeout:15000})
    assert.equal(result.status,1,result.stderr)
    assert.match(result.stderr,/DVR_STAGED_ACCEPTANCE_FAILED:.*AssertionError/s)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('promotion contract accepts only closed staging or exact paired release identities', () => {
  const targets = Object.keys(candidates)
  const pins = Object.fromEntries(targets.map(t => [t, candidates[t].workerSha256]))
  const catalog = {
    'darwin-arm64': { url: 'https://registry.npmjs.org/dsh-vision-router-ocr-darwin-arm64/-/dsh-vision-router-ocr-darwin-arm64-1.0.0.tgz', npmBytes: 27922000, npmSha256: 'a'.repeat(64),
      bytes: 27917268, sha256: 'a5245c2420fa10ab9da124e2f8e308930a202c6239b4711b0dd73c14f29b78cd' },
    'win32-x64': { url: 'https://registry.npmjs.org/dsh-vision-router-ocr-win32-x64/-/dsh-vision-router-ocr-win32-x64-1.0.0.tgz', npmBytes: 35320000, npmSha256: 'b'.repeat(64),
      bytes: 35313963, sha256: 'fd5791ed9697dbd32ac59b1025600a8a299d8884c607acf6f977445310734ae0' },
  }
  assert.equal(assertNativePromotionState({}, historicalWorkerPins, candidates), 'staged')
  assert.equal(assertNativePromotionState(catalog, pins, candidates), 'promoted')
  assert.throws(() => assertNativePromotionState({}, pins, candidates), /unapproved worker-pin/)
  assert.throws(() => assertNativePromotionState(catalog, historicalWorkerPins, candidates), /catalog\/worker pin mismatch/)
  assert.throws(() => assertNativePromotionState({'darwin-arm64': catalog['darwin-arm64']}, pins, candidates), /both reviewed targets/)
  for (const change of [
    { bytes: catalog['win32-x64'].bytes + 1 },
    { sha256: 'a'.repeat(64) },
    { url: catalog['win32-x64'].url.replace('1.0.0', 'latest') },
    { url: catalog['win32-x64'].url.replace('1.0.0', '0.0.0-staging') },
    { url: catalog['win32-x64'].url.replace('1.0.0', '1.0.1') },
    { npmBytes: 100000000 }, { npmSha256: 'bad' },
    { url: catalog['win32-x64'].url.replace('win32-x64', 'darwin-arm64') },
    { url: 'https://example.org/ppocrv6-small-win32-x64.tar.gz' },
  ]) {
    assert.throws(() => assertNativePromotionState({...catalog, 'win32-x64': {...catalog['win32-x64'], ...change}}, pins, candidates))
  }
  const declaration = 'export const APPROVED_NATIVE_OCR_ARCHIVES = Object.freeze('
  const fixture = {'darwin-arm64': {url:'fixture', bytes:128, sha256:'a'.repeat(64)}}
  const expected = declaration + JSON.stringify(fixture) + ')'
  for (const shape of ['{}', JSON.stringify(catalog), JSON.stringify(catalog,null,2)]) {
    assert.equal(replaceScratchCatalog(declaration+shape+')', fixture), expected)
  }
  assert.throws(() => replaceScratchCatalog('other', fixture))
  assert.throws(() => replaceScratchCatalog(declaration+'{})\n'+declaration+'{})', fixture))
  const target = 'win32-x64'
  const line = sha => "  '" + target + "': '" + sha + "',"
  assert.equal(replaceScratchWorkerPin(line(historicalWorkerPins[target]),target,pins[target]), line(pins[target]))
  assert.equal(replaceScratchWorkerPin(line(pins[target]),target,pins[target]), line(pins[target]))
  assert.throws(() => replaceScratchWorkerPin(line('a'.repeat(64)),target,pins[target]), /unknown scratch worker pin/)
})

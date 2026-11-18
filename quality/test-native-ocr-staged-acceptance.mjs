import assert from 'node:assert/strict'
import {test} from 'node:test'
import {decodeBmp,replaceOnce} from './native-ocr-staged-acceptance.mjs'

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

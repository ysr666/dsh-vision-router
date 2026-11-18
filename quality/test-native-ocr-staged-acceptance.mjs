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

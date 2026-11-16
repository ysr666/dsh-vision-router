import test from 'node:test'
import assert from 'node:assert/strict'
import { detectRedAnnotationNearText } from '../src/lib/native-ocr-annotation-risk.js'

function sample(width,height){
  const buf=Buffer.alloc(width*height*3,245)
  return {width,height,buf}
}
function fill(image,x1,y1,x2,y2,rgb){
  for(let y=y1;y<y2;y++)for(let x=x1;x<x2;x++){
    const offset=(y*image.width+x)*3
    image.buf.set(rgb,offset)
  }
}

test('recognizes colored red marker only inside the target row',()=>{
  const s=sample(300,100)
  fill(s,20,25,35,40,[198,64,71])
  const a=detectRedAnnotationNearText(s.buf,300,100,[10,20,170,50])
  assert.equal(a.detected,true)
  assert.ok(a.redPixelCount>15)
  const other=detectRedAnnotationNearText(s.buf,300,100,[10,60,170,90])
  assert.equal(other.detected,false)
})

test('black printed text and beige photo background do not imply red annotation',()=>{
  const s=sample(300,100)
  fill(s,20,25,35,40,[20,20,20])
  fill(s,70,30,100,42,[232,198,165])
  assert.equal(detectRedAnnotationNearText(s.buf,300,100,[10,20,170,50]).detected,false)
})

test('invalid geometry and missing channels are rejected safely',()=>{
  const s=sample(100,50)
  assert.equal(detectRedAnnotationNearText(s.buf,100,50,[0,0,100,50]).detected,false)
  assert.equal(detectRedAnnotationNearText(Buffer.alloc(20),100,50,[0,0,100,50]).detected,false)
  assert.equal(detectRedAnnotationNearText(s.buf,100,50,[Number.NaN,0,1,1]).detected,false)
})

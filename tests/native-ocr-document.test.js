import test from 'node:test'
import assert from 'node:assert/strict'
import { planExperimentalDocumentTiles, runExperimentalNativeDocumentOcr } from '../src/lib/native-ocr-document.js'

test('small image bypasses tiled refinement and preserves native result',async()=>{
  const rgb=Buffer.alloc(320*240*3,255)
  let calls=0
  const result=await runExperimentalNativeDocumentOcr(rgb,320,240,{
    nativeRun:async(frame)=>{calls++;assert.equal(frame.readUInt32LE(8),320);return{text:'正常中文',confidence:.91,regions:[],uncertain:false}},
    timeoutMs:2000,
  })
  assert.equal(calls,1)
  assert.equal(result.tilesUsed,0)
  assert.equal(result.text,'正常中文')
})

test('portrait layout refuses tiling without reliable detected text lines',()=>{
  const rgb=Buffer.alloc(864*1536*3,255)
  assert.deepEqual(planExperimentalDocumentTiles(rgb,864,1536,{regions:[]}),[])
  const noRegions=Array.from({length:5},(_,i)=>({
    box:[100,300+i*25,650,322+i*25],text:'测试',
  }))
  assert.deepEqual(planExperimentalDocumentTiles(rgb,864,1536,{regions:noRegions}),[])
})

test('invalid RGB dimensions fail before launching native process',async()=>{
  let calls=0
  await assert.rejects(runExperimentalNativeDocumentOcr(Buffer.alloc(20),9000,3,{
    nativeRun:async()=>{calls++;return{text:'bad'}}
  }),{code:'OCR_INVALID_DIMENSIONS'})
  assert.equal(calls,0)
})

test('pre-aborted image processing does not launch an OCR worker',async()=>{
  const ctl=new AbortController();ctl.abort()
  let calls=0
  await assert.rejects(runExperimentalNativeDocumentOcr(Buffer.alloc(64*64*3),64,64,{
    signal:ctl.signal,nativeRun:async()=>{calls++;throw Object.assign(new Error('cancelled'),{code:'OCR_CANCELLED'})}
  }),{code:'OCR_CANCELLED'})
  assert.equal(calls,0)
})

test('invalid deadline or malformed native response does not silently succeed',async()=>{
  const rgb=Buffer.alloc(96*96*3,255)
  let called=0
  for(const bad of [0,-1,NaN,Infinity]) {
    await assert.rejects(runExperimentalNativeDocumentOcr(rgb,96,96,{
      timeoutMs:bad,nativeRun:async()=>{called++;return {text:'wrong'}}
    }),{code:'OCR_INVALID_TIMEOUT'})
  }
  assert.equal(called,0)
  await assert.rejects(runExperimentalNativeDocumentOcr(rgb,96,96,{
    nativeRun:async()=>null,
  }),{code:'OCR_INVALID_RESULT'})
})

test('cancellation during the first native call aborts even if it returns a success object',async()=>{
  const rgb=Buffer.alloc(96*96*3,255)
  const ctrl=new AbortController()
  await assert.rejects(runExperimentalNativeDocumentOcr(rgb,96,96,{
    signal:ctrl.signal,
    nativeRun:async()=>{ctrl.abort();return{text:'late result',confidence:.99,regions:[]}},
  }),{code:'OCR_CANCELLED'})
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import {
  rewriteHistoryImages,
  hasUnstableStableV2ImageIdentity,
} from '../lib/core-primitives.js'
import { createSessionImageEvidencePlanner } from '../lib/stable-image-evidence.js'

test('#865 default readiness: 1MB+ old image Session keeps canonical v2 wire prefix after OCR update', () => {
  const history = Array.from({ length: 1700 }, (_, index) => {
    const content = [{ type: 'text', text: 'Previously committed user context ' + 'x'.repeat(650) }]
    if (index % 13 === 0) content.push({
      type: 'image', attachment: {
        attachmentId: 'sha256:synthetic-' + String(index).padStart(6,'0'),
        name: 'history-' + index + '.png',
      },
    })
    return { id: 'committed-message-' + index, role: 'user', content }
  })
  const size = Buffer.byteLength(JSON.stringify(history))
  assert.ok(size > 1000000, 'benchmark must model a genuinely long serialized Session')
  assert.equal(hasUnstableStableV2ImageIdentity(history), false)
  const memory = new Map()
  const firstStart = performance.now()
  const before = rewriteHistoryImages(history, memory, { stable: 'stable-v2' }).messages
  const firstMs = performance.now() - firstStart
  const firstWire = createHash('sha256').update(JSON.stringify(before)).digest('hex')
  for (let index = 0; index < history.length; index += 13) {
    memory.set('sha256:synthetic-' + String(index).padStart(6,'0'),
      'Late OCR pass: ' + String(index).repeat(20))
  }
  const secondStart = performance.now()
  const after = rewriteHistoryImages(history, memory, { stable: 'stable-v2' }).messages
  const secondMs = performance.now() - secondStart
  assert.equal(createHash('sha256').update(JSON.stringify(after)).digest('hex'),
    firstWire, 'OCR cache updates must not rewrite ANY original model-visible image history')
  assert.equal(history[0].content[1].type, 'image', 'source pixels and message history are immutable')
  const legacyBefore = rewriteHistoryImages(history, new Map()).messages
  const legacyAfter = rewriteHistoryImages(history, memory).messages
  assert.notEqual(legacyBefore[0].content[1].text, legacyAfter[0].content[1].text,
    'negative control: original legacy path really could rewrite its historical projection')
  console.log(JSON.stringify({kind:'dvr-865-default-perf-synthetic',wireBytes:size,
    messages:history.length, images:Math.ceil(history.length/13),
    firstMs:Math.round(firstMs*100)/100, continuationMs:Math.round(secondMs*100)/100,
    stableOldWire:true}))
})

test('#865 default readiness: resumed large Session performs exactly one full history scan', () => {
  const originals = Array.from({length: 120}, (_,i)=>({
    id:'image-message-'+i, role:'user', content:[{
      type:'image', attachment:{attachmentId:'sha256:synthetic-'+i},
    }],
  }))
  const unrelated = Array.from({length: 5000}, (_,i)=>({
    type:'user/message',
    data:{id:'text-'+i,role:'user',content:[{type:'text',text:'historic '+i}]},
  }))
  const events = [...unrelated,...originals.map(data=>({type:'user/message',data}))]
  let reads=0
  const session={snapshotEvents(){reads++;return events}}
  const descriptions=new Map(originals.map((msg,i)=>['sha256:synthetic-'+i,'synthetic recognition '+i]))
  const planner=createSessionImageEvidencePlanner()
  const source={kind:'plugin:dsh-vision-router'}
  const first=planner.plan(session,[],[],descriptions,source)
  assert.equal(reads,1)
  assert.equal(first.length,4, 'bounded four evidence messages per continuation step')
  planner.onSessionEvent(session,{type:'user/message',data:first[0]})
  for(let i=0;i<40;i++) {
    const later=planner.plan(session,[],[],descriptions,source)
    assert.ok(later.length<=4)
  }
  assert.equal(reads,1,'no per-step full history rescan, even after evidence changes')
  const cold=createSessionImageEvidencePlanner()
  cold.plan({snapshotEvents(){reads++;return events}},[],[],descriptions,source)
  assert.equal(reads,2,'cold Session object needs only one fresh authoritative scan')
})

test('#865 default readiness: unknown image identity is refused for witnessed v2, not aliased', () => {
  assert.equal(hasUnstableStableV2ImageIdentity([{
    role:'user', content:[{type:'image',attachment:{}}],
  }]),true)
  assert.equal(hasUnstableStableV2ImageIdentity([{
    id:'durable-message-id',role:'user',content:[{type:'image',attachment:{}}],
  }]),false,'message ID gives a safe fallback identity')
  assert.throws(()=>rewriteHistoryImages([{role:'user',content:[{type:'image',attachment:{}}]}],
    new Map(),{stable:'stable-v2'}),/refused an image/)
})

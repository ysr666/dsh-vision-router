import test from 'node:test'
import assert from 'node:assert/strict'
import { createVisionSubcallAccounting } from '../lib/vision-subcall-accounting.js'

test('#865 vision subcall audit counts real streams once and keeps last cumulative Usage only', async () => {
  const audit=createVisionSubcallAccounting()
  const session={}
  async function* provider() {
    yield {type:'usage',usage:{inputTokens:10,cacheReadTokens:30,outputTokens:1,totalTokens:41}}
    yield {type:'usage',usage:{inputTokens:10,cacheReadTokens:50,outputTokens:2,totalTokens:62}}
    yield {type:'finish',reason:{kind:'stop'}}
  }
  const received=[]
  for await(const item of audit.observe(session,provider())) received.push(item.type)
  assert.deepEqual(received,['usage','usage','finish'])
  const record=audit.snapshot(session)
  assert.equal(record.calls,1)
  assert.equal(record.finished,1)
  assert.equal(record.withUsage,1)
  assert.equal(record.tokenTotals.cacheReadTokens,50,'cumulative usage MUST NOT be summed')
  assert.equal(record.tokenTotals.totalTokens,62)
})
test('#865 incomplete and failed provider calls remain charge-unknown, not missing/free', async () => {
  const audit=createVisionSubcallAccounting(),session={}
  async function* fail() {
    yield {type:'usage',usage:{inputTokens:9,totalTokens:14}}
    throw new Error('private upstream error with account identifier')
  }
  await assert.rejects(async()=>{for await(const item of audit.observe(session,fail())){void item}},/private upstream/)
  async function* noUsage(){yield {type:'finish',reason:{kind:'stop'}}}
  for await(const item of audit.observe(session,noUsage())){void item}
  const snapshot=audit.snapshot(session)
  assert.equal(snapshot.calls,2)
  assert.equal(snapshot.failed,1)
  assert.equal(snapshot.finished,1)
  assert.equal(snapshot.withUsage,1)
  assert.equal(snapshot.tokenTotals.totalTokens,null,'cannot sum known+unknown into a deceptive total')
  assert.doesNotMatch(JSON.stringify(snapshot),/private upstream|account identifier/)
})
test('#865 session isolation, no leakage of model/prompt data or stale durable state', async()=>{
  const audit=createVisionSubcallAccounting(),a={},b={}
  const stream=async function*(){yield{type:'finish',reason:{kind:'stop'}}}
  for await(const item of audit.observe(a,stream())){void item}
  assert.equal(audit.snapshot(a).calls,1)
  assert.equal(audit.snapshot(b).calls,0)
  assert.equal(audit.snapshot(undefined).calls,0)
  assert.equal(audit.snapshot(a).tokenTotals.totalTokens,null)
})
test('#865 bounded memory holds only 64 latest stream records and reports truncation',async()=>{
  const audit=createVisionSubcallAccounting(),s={}
  const stream=async function*(){yield {type:'finish',reason:{kind:'stop'}}}
  for(let i=0;i<100;i++)for await(const item of audit.observe(s,stream())){void item}
  const snapshot=audit.snapshot(s)
  assert.equal(snapshot.calls,64)
  assert.equal(snapshot.finished,64)
  assert.equal(snapshot.truncated,true)
})

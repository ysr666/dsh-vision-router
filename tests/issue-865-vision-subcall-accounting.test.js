import test from 'node:test'
import assert from 'node:assert/strict'
import { createVisionSubcallAccounting } from '../lib/vision-subcall-accounting.js'
import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

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

test('#865 real tool-runtime seam observes tool LLM streams, not unrelated main LLM streams', async () => {
  const audit = createVisionSubcallAccounting()
  const session = { id: 'session-1' }
  const agent = { id: 'session-1', session }
  let actualRequests = 0
  let registered
  const host = {
    tools: { register(def) { registered = def; return () => {} } },
    llm: { async *stream() {
      actualRequests++
      yield { type: 'usage', usage: { inputTokens: 12, cacheReadTokens: 88,
        outputTokens: 5, totalTokens: 105 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  const wrapped = installVisionToolRuntimeBoundary(host, {
    tool: true, cache: false, visionTaskTimeoutMs: 5000,
  }, audit)
  wrapped.tools.register({
    name: 'vision_ocr',
    async execute() {
      const received = []
      for await (const part of wrapped.llm.stream({ provider: 'SENSITIVE', model: 'SECRET' })) {
        received.push(part.type)
      }
      return received
    },
  })
  assert.deepEqual(await registered.execute({}, { agent, signal: new AbortController().signal }),
    ['usage', 'finish'])
  const recorded = audit.snapshot(session)
  assert.equal(actualRequests, 1)
  assert.equal(recorded.calls, 1)
  assert.equal(recorded.finished, 1)
  assert.equal(recorded.tokenTotals.totalTokens, 105)
  // A native main or Host title stream on the same ctx is not a tool-owned
  // call. Instrumentation must not misattribute it as paid visual activity.
  for await (const _ of wrapped.llm.stream({ provider: 'SENSITIVE', model: 'SECRET' })) {}
  assert.equal(actualRequests, 2)
  assert.equal(audit.snapshot(session).calls, 1)
  assert.doesNotMatch(JSON.stringify(audit.snapshot(session)), /SENSITIVE|SECRET|session-1/)
})

test('#865 Vision tools OFF cannot dispatch or report a paid visual subcall', async () => {
  const audit = createVisionSubcallAccounting()
  const session = { id: 'off-session' }
  let calls = 0, definition
  const host = {
    tools: { register(def) { definition = def; return () => {} } },
    llm: { async *stream() { calls++; yield { type: 'finish', reason: {kind:'stop'} } } },
  }
  const wrapped = installVisionToolRuntimeBoundary(host, { tool: false }, audit)
  wrapped.tools.register({
    name: 'vision_ocr',
    async execute() {
      for await (const _ of wrapped.llm.stream({ provider: 'p', model: 'm' })) {}
      return 'unexpected'
    },
  })
  await assert.rejects(
    definition.execute({}, { agent: { id: session.id, session }, signal: new AbortController().signal }),
    /disabled/i,
  )
  assert.equal(calls, 0)
  assert.equal(audit.snapshot(session).calls, 0)
})

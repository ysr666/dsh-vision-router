import assert from 'node:assert/strict'
import test from 'node:test'
import { installPreStepModelRouting } from '../lib/agent-prestep-model-routing.js'
import { blocksHaveRetainedImage } from '../lib/image-offload-compat.js'

const source = (kind = 'user') => ({ kind })
let sequence = 0
const text = (id = String(++sequence)) => ({
  id, role: 'user', source: source(), content: [{ type: 'text', text: 'Question' }],
})
const image = (id = String(++sequence), offloaded = false) => ({
  id, role: 'user', source: source(), content: [{ type: 'image', attachment: { attachmentId: 'mock' }, ...(offloaded ? {offloaded:true}: {}) }],
})
const special = (id = String(++sequence)) => ({
  id, role: 'user', source: source('plugin:dsh-vision-router'), content: [{ type: 'text', text: 'Tool result' }],
})

function harness(config = {}) {
  const handlers = new Map()
  const inboxes = new WeakMap()
  const registered = new Set(config.adapters ?? ['deepseek-official', 'vision-chain', 'deepseek-vision', 'vision-http'])
  const log = { select: [], warnings: [], deepToolActivations: 0 }
  let routing = config.routing ?? true
  let reverse = config.reverse ?? true
  let tool = config.tool ?? true
  const ctx = {
    get(name) {
      if (config.noProjection || name !== 'sessionProjections') return undefined
      return { stateOf(session, key) { return key === 'inbox' ? inboxes.get(session) : undefined } }
    },
    on(name, callback) {
      const array = handlers.get(name) ?? []
      array.push(callback)
      handlers.set(name, array)
    },
    logger: { warn(...args) { log.warnings.push(args) }, debug() {} },
  }
  const options = {
    routingEnabled: () => routing,
    reverseRoutingEnabled: () => reverse,
    routingPairs: () => { if (config.throwPairs) throw new Error('synthetic route config fault'); return [{ provider: 'vision-http', model: 'visual-model' }] },
    chainRoute: () => 'vision-chain',
    wrapperRoute: () => 'deepseek-vision',
    wrapperRegistered: () => true,
    textProvider: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    hasAdapter: (provider) => registered.has(provider),
    hasImage: blocksHaveRetainedImage,
    toolEnabled: () => tool,
    autoActivateOnImageEnabled: () => true,
    structuredBootstrapEnabled: () => false,
    activateDeepTools: () => { log.deepToolActivations++; if (config.throwActivation) throw new Error('synthetic tool mount fault') },
  }
  const coordinator = installPreStepModelRouting(ctx, options)
  const emit = (event, ...args) => {
    for (const cb of handlers.get(event) ?? []) cb(...args)
  }
  let activeAppend = false
  function agent(initial = {provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'high'}) {
    const session = {}
    const selected = {...initial}
    const record = {value: selected, committed: undefined}
    const result = {
      session, status: 'idle',
      model: {
        current() { return {...record.value} },
        select(next) {
          assert.equal(activeAppend, false, 'model.select must never reenter a Session append')
          // Match real RC1 AgentModel.select: an already recorded identical
          // provider/model is a no-op, not a new accepted user intent.
          if (record.committed?.provider === next.provider && record.committed?.model === next.model) return
          log.select.push(next)
          record.value = {...next}
          record.committed = {...next}
          emit('session/event', session, {type:'model/selection',data:next})
        },
      },
    }
    inboxes.set(session, { 'next-turn': [], 'next-step': [] })
    return result
  }
  function insert(agent, message, lane='next-turn') {
    activeAppend=true
    const pending = inboxes.get(agent.session)
    pending[lane].push(message)
    activeAppend=false
    emit('agent/inbox/inserted', {agent, message})
  }
  function run(agent) {
    agent.status='running'
    emit('agent/status',{agent,status:'running'})
  }
  function done(agent) {
    emit('agent/turn-stopping', {agent})
  }
  function claim(agent,lane='next-turn') {
    const messages = inboxes.get(agent.session)[lane]
    const copy=[...messages]
    messages.length=0
    return {model:agent.model.current(),messages:copy}
  }
  return {agent,insert,run,done,claim,emit,log,coordinator,
    configure(next){if('routing' in next)routing=next.routing;if('reverse' in next)reverse=next.reverse;if('tool' in next)tool=next.tool},
    removeAdapter:provider=>registered.delete(provider)}
}

test('modern RC1 image selection commits BEFORE pre-step and tool prompt admission', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  const step=t.claim(agent)
  assert.deepEqual(step.model,{provider:'vision-chain',model:'vision-http/visual-model'})
  assert.equal(t.log.deepToolActivations>=1,true)
  assert.deepEqual(t.log.select,[{provider:'vision-chain',model:'vision-http/visual-model'}])
  assert.deepEqual(t.coordinator.nativeModel(agent),agent.model)
})

test('RC1 restores original text selection, including its reasoning effort, on next turn', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  t.insert(agent,text())
  t.done(agent)
  const next=t.claim(agent)
  assert.deepEqual(next.model,{provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'high'})
  assert.equal(t.log.select.length,2)
})

test('mixed queued image plus text is routed as an image regardless of append order', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.insert(agent,text())
  t.run(agent)
  assert.equal(t.claim(agent).model.provider,'vision-chain')
})

test('queued next-turn text never overrides a live step with pending next-step image', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  t.insert(agent,image(),'next-step')
  t.insert(agent,text(),'next-turn')
  assert.equal(agent.model.current().provider,'vision-chain')
  assert.equal(t.claim(agent,'next-step').model.provider,'vision-chain')
  t.done(agent)
  assert.equal(t.claim(agent).model.provider,'deepseek-official')
})

test('user steer and internal tool context do not undo an active vision turn', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  t.insert(agent,special(),'next-step')
  t.insert(agent,text(),'next-step')
  assert.equal(t.claim(agent,'next-step').model.provider,'vision-chain')
})

test('text-only user turns retain external manually selected model', () => {
  const t=harness()
  const agent=t.agent({provider:'custom-text',model:'custom-model'})
  t.insert(agent,text())
  t.run(agent)
  assert.equal(t.claim(agent).model.provider,'custom-text')
  assert.equal(t.log.select.length,0)
})

test('manual model changes are never overridden by stale DVR restoration state', () => {
  const t=harness({adapters:['vision-chain','deepseek-official','third-party','deepseek-vision','vision-http']})
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  agent.model.select({provider:'third-party',model:'chosen'})
  t.insert(agent,text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model,{provider:'third-party',model:'chosen'})
})

test('disabled routing restores an owned image route, then preserves user model', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  t.configure({routing:false})
  t.insert(agent,text())
  t.done(agent)
  assert.equal(t.claim(agent).model.provider,'deepseek-official')
})

test('offloaded image is not used to auto-select a vision provider', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image(undefined,true))
  t.run(agent)
  assert.equal(t.claim(agent).model.provider,'deepseek-official')
  assert.equal(t.log.select.length,0)
})

test('unavailable adapter and projection fail closed without inventing a route', () => {
  const t=harness({adapters:['deepseek-official']})
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  assert.equal(t.claim(agent).model.provider,'deepseek-official')
  const noInbox=harness({noProjection:true})
  const another=noInbox.agent()
  noInbox.insert(another,image())
  noInbox.run(another)
  assert.equal(another.model.current().provider,'deepseek-official')
  assert.equal(noInbox.log.warnings.length,1)
})

test('legacy Agent without model selector remains outside modern routing', () => {
  const t=harness()
  const agent={session:{},status:'idle'}
  t.emit('agent/status',{agent,status:'running'})
  t.emit('agent/inbox/inserted',{agent,message:image()})
  assert.equal(t.coordinator.nativeModel(agent),undefined)
  assert.equal(t.log.select.length,0)
})

test('unloading removes Agent-owned routing record without altering user selection', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  t.emit('agent/disposed',{agent})
  agent.model.select({provider:'deepseek-official',model:'chosen'})
  t.insert(agent,text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model,{provider:'deepseek-official',model:'chosen'})
})

test('default tool-only mode activates deep tools before RC1 tool admission without switching model', () => {
  const t=harness({routing:false})
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  const request=t.claim(agent)
  assert.equal(request.model.provider,'deepseek-official')
  assert.equal(t.log.deepToolActivations>=1,true)
  assert.equal(t.log.select.length,0)
})

test('explicit manual selection of a different vision adapter is never treated as auto reverse routing', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  agent.model.select({provider:'vision-http',model:'visual-model'})
  t.insert(agent,text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model,{provider:'vision-http',model:'visual-model'})
})

test('RC1 same-route no-op emits no manual intent and preserves DVR-owned restoration', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  const chosen=agent.model.current()
  const before=t.log.select.length
  agent.model.select(chosen)
  assert.equal(t.log.select.length,before,'identical Host model selection does not append')
  t.insert(agent,text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model,{provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'high'})
})

test('next-turn arriving just after turn-stopping is selected before the next preStep', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  t.done(agent)
  t.insert(agent,text())
  assert.equal(t.claim(agent).model.provider,'deepseek-official')
})
test('late next-step steer after selecting next-turn restores active turn authority', () => {
  const t=harness()
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  t.insert(agent,text(),'next-turn')
  t.done(agent)
  assert.equal(agent.model.current().provider,'deepseek-official')
  t.insert(agent,text(),'next-step')
  assert.equal(t.claim(agent,'next-step').model.provider,'vision-chain')
  t.done(agent)
  assert.equal(t.claim(agent).model.provider,'deepseek-official')
})

test('reverseRouting=false retains visual model for subsequent text (legacy setting parity)', () => {
  const t=harness({routing:true,reverse:false})
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  const first=t.claim(agent)
  assert.equal(first.model.provider,'vision-chain')
  t.insert(agent,text())
  t.done(agent)
  const second=t.claim(agent)
  assert.deepEqual(second.model,first.model)
  assert.equal(t.log.select.length,1)
})
test('turning off whole-turn routing restores user model even when reverseRouting=false', () => {
  const t=harness({routing:true,reverse:false})
  const agent=t.agent()
  t.insert(agent,image())
  t.run(agent)
  t.claim(agent)
  t.configure({routing:false})
  t.insert(agent,text())
  t.done(agent)
  assert.equal(t.claim(agent).model.provider,'deepseek-official')
})

test('early tool mount failure does not strand an accepted inbox message before Host wake', () => {
  const t=harness({throwActivation:true})
  const agent=t.agent()
  assert.doesNotThrow(() => t.insert(agent,image()))
  assert.doesNotThrow(() => t.run(agent))
  const step=t.claim(agent)
  assert.equal(step.messages.length,1)
  assert.equal(step.model.provider,'deepseek-official','failed mounting must not pretend visual routing succeeded')
  assert.equal(t.log.warnings.length,1)
  assert.match(String(t.log.warnings[0][1]),/tool mount fault/)
})
test('malformed dynamic route config never vetoes Host wake or drops a queued image', () => {
  const t=harness({throwPairs:true})
  const agent=t.agent()
  assert.doesNotThrow(() => t.insert(agent,image()))
  assert.doesNotThrow(() => t.run(agent))
  assert.equal(t.claim(agent).messages.length,1)
  assert.equal(agent.model.current().provider,'deepseek-official')
  assert.equal(t.log.warnings.length,1)
})

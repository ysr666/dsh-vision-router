import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNativeVisionPolicyMutator, installNativeVisionPolicyCommand } from '../lib/native-vision-policy-command.js'
import { readNativeVisionControlState, observeNativeVisionControlState } from '../lib/native-vision-control-state.js'
import { userSessionVisionPolicy } from '../lib/session-vision-policy.js'
import { createNativeVisionControlContribution, createNativeVisionClientSchemas, startNativeVisionClientObservation } from '../lib/native-vision-control-client.js'
import { nativeVisionControlViewSchema, nativeVisionMutationRequestSchema, nativeVisionMutationReceiptSchema, nativeVisionControlSessionIdSchema } from '../lib/native-vision-control-wire.js'

function fixture({ inputModalities = ['text', 'image'], enabled = true } = {}) {
  const policies = new Map()
  const registered = []
  const model = { provider: 'native-account', model: 'multimodal' }
  let selected = { ...model }
  let selectCount = 0
  const registeredAdapter = {}
  const agent = {
    id: 'test-session-A',
    session: { id: 'test-session-A' },
    model: {
      current: () => ({ ...selected }),
      select: () => { selectCount++ },
    },
  }
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['commands'])
      callback({ commands: { register(definition) { registered.push(definition) } } })
    },
    llm: {
      registration() { return { adapter: registeredAdapter } },
      async resolveModelInfo(provider, modelId) {
        assert.equal(provider, selected.provider)
        assert.equal(modelId, selected.model)
        return { provider, id: modelId, inputModalities }
      },
    },
  }
  const store = {
    get: id => policies.get(id),
    async set(id, policy) {
      policies.set(id, policy)
      return policy
    },
  }
  installNativeVisionPolicyCommand(ctx, store, { toolEnabled: () => enabled })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'vision-router')
  const call = (rawInput, who = agent, attachments = [], signal = undefined) =>
    registered[0].handler({ agent: who, rawInput, attachments, signal })
  return { agent, policies, ctx, registered, call,
    changeSelected: (next) => { selected = next },
    selectCount: () => selectCount }
}

test('issue #865: native model vision permission changes never select a new adapter', async () => {
  const f = fixture()
  assert.match((await f.call('status')).text, /not explicitly selected/)
  assert.match((await f.call('on')).text, /model is unchanged/)
  assert.equal(f.policies.get('test-session-A').enabled, true)
  assert.equal((await f.call('status')).kind, 'success')
  assert.match((await f.call('off')).text, /Native image input remains available/)
  assert.equal(f.policies.get('test-session-A').enabled, false)
  assert.equal(f.selectCount(), 0, 'policy-only control must not call Agent.model.select')
})

test('issue #865: reject text-only model, disabled tools, malformed invocations and attachments', async () => {
  const textOnly = fixture({ inputModalities: ['text'] })
  assert.equal((await textOnly.call('on')).kind, 'error')
  assert.equal((await textOnly.call('off')).kind, 'error')
  assert.equal(textOnly.policies.size, 0)
  const disabled = fixture({ enabled: false })
  assert.equal((await disabled.call('on')).kind, 'error')
  assert.equal(disabled.policies.size, 0)
  assert.equal((await disabled.call('anything')).kind, 'error')
  assert.equal((await disabled.call('on', disabled.agent, [{ type: 'image' }])).kind, 'error')
  assert.equal((await disabled.call('on', { ...disabled.agent, id: 'foreign-session' })).kind, 'error')
  assert.equal(disabled.selectCount(), 0)
})

test('issue #865: a DVR-owned wrapper cannot impersonate native multimodal via model metadata', async () => {
  const f = fixture({ inputModalities: ['text', 'image'] })
  f.ctx.llm.registration = () => ({
    adapter: { [Symbol.for('dsh-vision-router.adapter-owner')]: Object.freeze({ route: 'text-vision' }) },
  })
  assert.equal((await f.call('on')).kind, 'error')
  assert.equal((await f.call('off')).kind, 'error')
  assert.equal(f.policies.size, 0, 'wrapped text-only sources must never enter the native command mode')
  assert.equal(f.selectCount(), 0)
  // Unknown adapter ownership is not proof of native capability.
  f.ctx.llm.registration = undefined
  assert.equal((await f.call('on')).kind, 'error')
  assert.equal(f.policies.size, 0)
})

test('issue #865: async provider discovery cannot apply stale model policy', async () => {
  const f = fixture()
  let resolveLookup
  f.ctx.llm.resolveModelInfo = () => new Promise(resolve => { resolveLookup = resolve })
  const pending = f.call('on')
  f.changeSelected({ provider: 'another', model: 'other-model' })
  resolveLookup({ inputModalities: ['text', 'image'] })
  assert.equal((await pending).kind, 'error')
  assert.equal(f.policies.size, 0)
  assert.equal(f.selectCount(), 0)
})

test('issue #865: cancelled command cannot mutate vision policy after late metadata response', async () => {
  const f = fixture()
  let resolveMetadata
  f.ctx.llm.resolveModelInfo = () => new Promise(resolve => { resolveMetadata = resolve })
  const controller = new AbortController()
  const pending = f.call('on', f.agent, [], controller.signal)
  controller.abort(new Error('user cancelled permission request'))
  resolveMetadata({ inputModalities: ['text', 'image'] })
  assert.equal((await pending).kind, 'error')
  assert.equal(f.policies.size, 0)
  assert.equal(f.selectCount(), 0)
})

test('issue #865: command discloses when Session policy is not durable', async () => {
  const f = fixture()
  let handler
  installNativeVisionPolicyCommand({
    inject(_deps, install) {
      install({ commands: { register(def) { handler = def.handler } } })
    },
    llm: f.ctx.llm,
  }, {
    durable: false,
    get() { return undefined },
    async set() { return { enabled: true } },
  })
  const response = await handler({ agent: f.agent, rawInput: 'on', attachments: [] })
  assert.equal(response.kind, 'success')
  assert.match(response.text, /no durable policy store/)
})

test('issue #865: late ON capability response cannot overwrite the newer OFF request', async () => {
  const f = fixture()
  const lookups = []
  f.ctx.llm.resolveModelInfo = () => new Promise(resolve => { lookups.push(resolve) })
  const older = f.call('on')
  const newer = f.call('off')
  assert.equal(lookups.length, 2)
  lookups[1]({ inputModalities: ['text', 'image'] })
  assert.equal((await newer).kind, 'success')
  assert.equal(f.policies.get('test-session-A').enabled, false)
  lookups[0]({ inputModalities: ['text', 'image'] })
  assert.equal((await older).kind, 'error')
  assert.equal(f.policies.get('test-session-A').enabled, false,
    'last user intent wins even when the old capability response arrives last')
  assert.equal(f.selectCount(), 0)
})

test('issue #865: slow durable writes are serialized; last Session intent wins', async () => {
  const agent = {
    id: 'test-session-write-race',
    session: { id: 'test-session-write-race' },
    model: { current: () => ({ provider: 'native-account', model: 'mm' }) },
  }
  const persisted = new Map()
  const started = []
  let releaseFirst
  let handler
  const registeredAdapter = {}
  installNativeVisionPolicyCommand({
    inject(_names, mount) { mount({ commands: { register(def) { handler = def.handler } } }) },
    llm: {
      registration() { return { adapter: registeredAdapter } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
  }, {
    get: id => persisted.get(id),
    async set(id, policy) {
      started.push(policy.enabled)
      if (started.length === 1) {
        await new Promise(resolve => { releaseFirst = resolve })
      }
      persisted.set(id, policy)
    },
  })
  const older = handler({ agent, rawInput: 'on', attachments: [] })
  for (let i = 0; i < 100 && releaseFirst === undefined; i++) await Promise.resolve()
  assert.equal(typeof releaseFirst, 'function', 'the earlier permission write has started')
  const newer = handler({ agent, rawInput: 'off', attachments: [] })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.deepEqual(started, [true], 'the later OFF write must wait for the prior durable mutation')
  releaseFirst()
  assert.equal((await older).kind, 'success')
  assert.equal((await newer).kind, 'success')
  assert.deepEqual(started, [true, false])
  assert.equal(persisted.get(agent.id)?.enabled, false,
    'late completion of the older ON write cannot overwrite newer OFF')
})

test('issue #865: status hydrates a persisted Vision setting before reporting', async () => {
  const f = fixture()
  let handler
  let hydrateCalls = 0
  const backing = new Map()
  installNativeVisionPolicyCommand({
    inject(_deps, install) { install({ commands: { register(def) { handler = def.handler } } }) },
    llm: f.ctx.llm,
  }, {
    get(id) { return backing.get(id) },
    async hydrate(id) {
      hydrateCalls++
      backing.set(id, { source: 'user', enabled: false })
    },
    async set() { throw new Error('unexpected status write') },
  })
  const response = await handler({ agent: f.agent, rawInput: 'status', attachments: [] })
  assert.equal(response.kind, 'success')
  assert.match(response.text, /tools: off/)
  assert.equal(hydrateCalls, 1)
  assert.equal(f.selectCount(), 0)
})

test('issue #865: separate authorized Sessions cannot write another Session policy', async () => {
  const f = fixture()
  const b = {
    ...f.agent,
    id: 'test-session-B',
    session: { id: 'test-session-B' },
  }
  assert.equal((await f.call('on', b)).kind, 'success')
  assert.equal(f.policies.get('test-session-A'), undefined)
  assert.equal(f.policies.get('test-session-B').enabled, true)
  assert.equal((await f.call('off', f.agent)).kind, 'success')
  assert.equal(f.policies.get('test-session-A').enabled, false)
  assert.equal(f.policies.get('test-session-B').enabled, true)
})

test('issue #865: store errors do not advertise successful mode switch', async () => {
  const f = fixture()
  f.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] })
  // The installed command uses the original store. Exercise a failing scope.
  let handler
  installNativeVisionPolicyCommand({
    inject(_deps, install) {
      install({ commands: { register(def) { handler = def.handler } } })
    },
    llm: f.ctx.llm,
  }, {
    get() { return undefined },
    async set() { throw new Error('synthetic storage failure') },
  })
  const outcome = await handler({ agent: f.agent, rawInput: 'on', attachments: [] })
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.text, /could not be stored/)
})

test('issue #865: metadata from a replaced adapter cannot authorize the same named native route', async () => {
  const f = fixture()
  let finishLookup
  f.ctx.llm.resolveModelInfo = () => new Promise(resolve => { finishLookup = resolve })
  const pending = f.call('on')
  const replacement = {}
  f.ctx.llm.registration = () => ({ adapter: replacement })
  finishLookup({ inputModalities: ['text', 'image'] })
  assert.equal((await pending).kind, 'error')
  assert.equal(f.policies.size, 0)
  assert.equal(f.selectCount(), 0)
})

test('issue #865 B2: authorized read uses the actual policy after hydration without durable writes', async () => {
  const f = fixture()
  let writes = 0
  let reads = 0
  let cached
  const store = {
    durable: true,
    get() { return cached },
    async hydrate(id) {
      assert.equal(id, f.agent.id)
      reads++
      cached = userSessionVisionPolicy(true)
    },
    async set() { writes++; throw new Error('read contract must not mutate policy') },
  }
  const view = await readNativeVisionControlState(f.ctx, store, f.agent)
  assert.deepEqual(view, {
    kind: 'native',
    selection: { provider: 'native-account', model: 'multimodal' },
    enabled: true, requestedEnabled: true, canEnable: true, durable: true,
  })
  const disabled = await readNativeVisionControlState(f.ctx, store, f.agent, {
    toolEnabled: () => false,
  })
  assert.equal(disabled.kind, 'native')
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.requestedEnabled, true, 'global disable does not erase user preference')
  assert.equal(disabled.canEnable, false)
  assert.equal(reads, 1)
  assert.equal(writes, 0)
  assert.equal(f.selectCount(), 0)
})

test('issue #865 B2: unsupported and stale control views are not interpreted as native OFF', async () => {
  const f = fixture()
  const store = { get() { return undefined }, async set() { throw Error('no writes') } }
  const text = fixture({ inputModalities: ['text'] })
  assert.equal((await readNativeVisionControlState(text.ctx, store, text.agent)).kind, 'legacy')
  const malformed = { ...f.agent, id: 'not-the-authorized-session' }
  assert.equal((await readNativeVisionControlState(f.ctx, store, malformed)).kind, 'unavailable')
  let done
  f.ctx.llm.resolveModelInfo = () => new Promise(resolve => { done = resolve })
  const pending = readNativeVisionControlState(f.ctx, store, f.agent)
  f.changeSelected({ provider: 'new-provider', model: 'new-model' })
  done({ inputModalities: ['text', 'image'] })
  assert.equal((await pending).kind, 'unavailable')
})


function observerFixture() {
  const f = fixture()
  const listeners = new Map()
  const effects = new Set()
  const subscriptions = new Map()
  f.ctx.on = (name, fn) => {
    const set = listeners.get(name) ?? new Set()
    listeners.set(name, set)
    set.add(fn)
    return () => { set.delete(fn) }
  }
  f.ctx.effect = (install) => {
    const cleanup = install()
    const dispose = () => {
      if (effects.delete(dispose)) cleanup()
    }
    effects.add(dispose)
    return dispose
  }
  const emit = (name, ...args) => {
    for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
  }
  const store = {
    durable: true,
    get: id => f.policies.get(id),
    subscribe(id, fn) {
      const set = subscriptions.get(id) ?? new Set()
      subscriptions.set(id, set)
      set.add(fn)
      return () => { set.delete(fn) }
    },
    change(id, enabled) {
      f.policies.set(id, userSessionVisionPolicy(enabled))
      for (const fn of [...(subscriptions.get(id) ?? [])]) fn()
    },
  }
  const activeCount = () => [
    ...listeners.values(), ...subscriptions.values(), effects,
  ].reduce((count, set) => count + set.size, 0)
  return { ...f, store, emit, effects, activeCount }
}

test('issue #865 B2: observe live policy, ignore another Session and duplicate views', { timeout: 3000 }, async () => {
  const f = observerFixture()
  let enabled = true
  let reads = 0
  const resolve = f.ctx.llm.resolveModelInfo
  f.ctx.llm.resolveModelInfo = (...args) => { reads++; return resolve(...args) }
  const stream = observeNativeVisionControlState(f.ctx, f.store, f.agent, {
    toolEnabled: () => enabled,
  })
  try {
    assert.equal((await stream.next()).value.enabled, false)
    const baseline = reads
    let delivered = false
    const next = stream.next().then(result => { delivered = true; return result })
    f.store.change('foreign-session', true)
    f.emit('session/event', { id: f.agent.id }, { type: 'model/selection' })
    f.emit('session/event', f.agent.session, { type: 'request/header' })
    await new Promise(setImmediate)
    assert.equal(reads, baseline, 'unrelated Session and unchanged request header cannot trigger discovery')
    assert.equal(delivered, false)
    f.store.change(f.agent.id, true)
    assert.equal((await next).value.enabled, true)
    const disabled = stream.next()
    enabled = false
    f.emit('settings/updated', 'vision-router')
    const view = (await disabled).value
    assert.equal(view.enabled, false)
    assert.equal(view.requestedEnabled, true)
    assert.equal(view.canEnable, false)
    const reopened = stream.next()
    // Neither a no-op write nor a duplicate settings notification emits another value.
    f.store.change(f.agent.id, true)
    f.emit('settings/document-updated', 'vision-router')
    await new Promise(setImmediate)
    enabled = true
    f.emit('settings/updated', 'vision-router')
    assert.equal((await reopened).value.enabled, true)
    assert.equal(f.selectCount(), 0)
  } finally {
    await stream.return()
  }
  assert.equal(f.activeCount(), 0)
})

test('issue #865 B2: a slow obsolete model read cannot publish over a later selection', { timeout: 3000 }, async () => {
  const f = observerFixture()
  let started
  const waiting = new Promise(resolve => { started = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  f.ctx.llm.resolveModelInfo = async (provider, model) => {
    if (++calls === 1) { started(); await gate }
    return { provider, id: model, inputModalities: ['text', 'image'] }
  }
  const stream = observeNativeVisionControlState(f.ctx, f.store, f.agent)
  try {
    const pending = stream.next()
    await waiting
    f.changeSelected({ provider: 'replacement', model: 'next-model' })
    f.emit('session/event', f.agent.session, { type: 'model/selection' })
    f.store.change(f.agent.id, true)
    release()
    const view = (await pending).value
    assert.equal(view.kind, 'native')
    assert.deepEqual(view.selection, { provider: 'replacement', model: 'next-model' })
    assert.equal(view.enabled, true)
    assert.equal(calls, 2, 'coalesced invalidation must cause only one replacement read')
  } finally {
    release()
    await stream.return()
  }
  assert.equal(f.activeCount(), 0)
})

test('issue #865 B2: return interrupts a provider read even if discovery ignores cancellation', { timeout: 3000 }, async () => {
  const f = observerFixture()
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let release
  let receivedSignal
  f.ctx.llm.resolveModelInfo = (_provider, _model, signal) => new Promise(resolve => {
    receivedSignal = signal
    release = resolve
    entered()
  })
  const stream = observeNativeVisionControlState(f.ctx, f.store, f.agent)
  const pending = stream.next()
  await started
  assert.equal((await stream.return()).done, true)
  assert.equal((await pending).done, true)
  assert.equal(receivedSignal.aborted, true)
  assert.equal(f.activeCount(), 0)
  release({ inputModalities: ['text', 'image'] })
})

test('issue #865 B2: closing one Agent or carrier releases only its observer', { timeout: 3000 }, async () => {
  const f = observerFixture()
  const controller = new AbortController()
  const a = observeNativeVisionControlState(f.ctx, f.store, f.agent)
  const b = observeNativeVisionControlState(f.ctx, f.store, f.agent, { signal: controller.signal })
  await a.next()
  await b.next()
  const nextA = a.next()
  const nextB = b.next()
  controller.abort()
  assert.equal((await nextB).done, true)
  assert.ok(f.activeCount() > 0)
  f.emit('agent/disposed', { agent: { ...f.agent } })
  f.store.change(f.agent.id, true)
  assert.equal((await nextA).value.enabled, true)
  const retired = a.next()
  f.emit('agent/disposed', { agent: f.agent })
  assert.equal((await retired).done, true)
  assert.equal(f.activeCount(), 0)

  const c = observeNativeVisionControlState(f.ctx, f.store, f.agent)
  await c.next()
  const waiting = c.next()
  for (const dispose of [...f.effects]) dispose()
  assert.equal((await waiting).done, true, 'owning Host fiber retirement closes idle observers')
  assert.equal(f.activeCount(), 0)
})

test('issue #865 B2: observe adapter topology changes without selecting a model', { timeout: 3000 }, async () => {
  const f = observerFixture()
  const stream = observeNativeVisionControlState(f.ctx, f.store, f.agent)
  try {
    assert.equal((await stream.next()).value.kind, 'native')
    const unavailable = stream.next()
    f.ctx.llm.registration = () => undefined
    f.emit('llm/adapters-updated')
    assert.equal((await unavailable).value.kind, 'unavailable')
    const legacy = stream.next()
    const wrapper = { [Symbol.for('dsh-vision-router.adapter-owner')]: Object.freeze({ route: 'native-account' }) }
    f.ctx.llm.registration = () => ({ adapter: wrapper })
    f.emit('llm/adapters-updated')
    assert.equal((await legacy).value.kind, 'legacy')
    assert.equal(f.selectCount(), 0)
  } finally {
    await stream.return()
  }
})


test('issue #865 B2: shared command/Remote writes are ordered and stale UI route cannot mutate', async () => {
  const f = fixture()
  const store = {
    get: id => f.policies.get(id),
    async set(id, policy) { f.policies.set(id, policy) },
  }
  const mutator = createNativeVisionPolicyMutator(f.ctx, store)
  installNativeVisionPolicyCommand(f.ctx, store, { mutate: mutator })
  const command = f.registered.at(-1).handler
  const selection = f.agent.model.current()
  const lookups = []
  f.ctx.llm.resolveModelInfo = () => new Promise(resolve => { lookups.push(resolve) })
  const oldClick = mutator(f.agent, { enabled: true, selection })
  const newerCommand = command({ agent: f.agent, rawInput: 'off' })
  assert.equal(lookups.length, 2)
  lookups[1]({ inputModalities: ['text', 'image'] })
  assert.equal((await newerCommand).kind, 'success')
  lookups[0]({ inputModalities: ['text', 'image'] })
  assert.equal((await oldClick).kind, 'error')
  assert.equal(f.policies.get(f.agent.id).enabled, false)
  f.changeSelected({ provider: 'new', model: 'new' })
  assert.equal((await mutator(f.agent, { enabled: true, selection })).kind, 'error')
  assert.equal(lookups.length, 2, 'obsolete UI intent cannot start a capability lookup')
  assert.equal(f.policies.get(f.agent.id).enabled, false)
  assert.equal(f.selectCount(), 0)
})


test('issue #865 B2.4: Client and Host share the strict descriptor and compatible wire codecs', () => {
  const host = { id: nativeVisionControlSessionIdSchema, view: nativeVisionControlViewSchema,
    request: nativeVisionMutationRequestSchema, receipt: nativeVisionMutationReceiptSchema }
  const client = createNativeVisionClientSchemas()
  const selection = { provider: 'native', model: 'mm' }
  const view = { kind: 'native', selection, enabled: false, requestedEnabled: false, canEnable: true, durable: null }
  const cases = {
    id: ['abc', '', null, {}],
    view: [view, { ...view, credentials: 'unexpected' }, { ...view, enabled: 0 },
      { kind: 'legacy', reason: 'text-only', selection }, { kind: 'unavailable', reason: 'stale-selection' },
      { kind: 'unavailable', reason: 'foreign' }],
    request: [{ enabled: true, selection }, { enabled: 'true', selection }, { enabled: false, selection, sessionId: 'other' }],
    receipt: [{ kind: 'success', text: 'ok' }, { kind: 'error', text: '' }, { kind: 'unknown', text: 'bad' }],
  }
  for (const [key, values] of Object.entries(cases)) {
    for (const value of values) {
      let accepted = true
      try { client[key].parse(value) } catch { accepted = false }
      assert.equal(accepted, host[key].safeParse(value).success, key + ': ' + JSON.stringify(value))
    }
  }
  const description = contribution => JSON.parse(JSON.stringify(contribution))
  assert.deepEqual(description(createNativeVisionControlContribution(host)),
    description(createNativeVisionControlContribution(client)))
})

test('issue #865 B2.4: native client waits for observation, never guesses and rejects obsolete clicks', async () => {
  const selection = { provider: 'native', model: 'mm' }
  const initial = { kind: 'native', selection, enabled: false, requestedEnabled: false, canEnable: true, durable: true }
  let next, controller, retired = false, requests = []
  const snapshots = []
  const api = {
    observe(id, signal) {
      assert.equal(id, 'session-one')
      controller = signal
      return {
        [Symbol.asyncIterator]() { return this },
        next() { return new Promise(resolve => { next = resolve }) },
        dispose() { retired = true; next?.({ done: true }) },
      }
    },
    async set(id, request) {
      requests.push({ id, request })
      return { ok: true, value: { kind: 'success', text: 'stored' } }
    },
  }
  const observation = startNativeVisionClientObservation(api, 'session-one', value => snapshots.push(value))
  assert.equal(snapshots[0].kind, 'waiting')
  assert.equal(await observation.set(initial, selection), false)
  next({ value: initial, done: false })
  await new Promise(setImmediate)
  assert.equal(snapshots.at(-1).view.enabled, false)
  assert.equal(await observation.set(initial, { provider: 'other', model: 'mm' }), false)
  assert.equal(await observation.set(initial, selection), true)
  assert.equal(snapshots.at(-1).view.enabled, false, 'receipt cannot optimistically change observed state')
  next({ value: { ...initial, enabled: true, requestedEnabled: true }, done: false })
  await new Promise(setImmediate)
  assert.equal(snapshots.at(-1).view.enabled, true)
  assert.equal(await observation.set(initial, selection), false, 'previous frame is not current')
  observation.stop()
  assert.equal(retired, true)
  assert.equal(controller.aborted, true)
  assert.equal(await observation.set(snapshots.at(-1).view, selection), false)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0], { id: 'session-one', request: { enabled: true, selection } })
})

test('issue #865 B2.4: missing old endpoint is distinct from permission denial or malformed stream data', async () => {
  for (const [code, expected] of [['gateway/invocation-unavailable','legacy'],
    ['remote-access/denied','failed'], ['gateway/definition-unavailable','failed']]) {
    const states = []
    const observation = startNativeVisionClientObservation({
      async *observe() { throw Object.assign(new Error('fixture'), { code }) },
    }, 'session-one', state => states.push(state))
    await new Promise(setImmediate)
    assert.equal(states.at(-1).kind, expected)
    observation.stop()
  }
})

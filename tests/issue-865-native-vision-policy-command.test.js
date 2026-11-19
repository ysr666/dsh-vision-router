import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installNativeVisionPolicyCommand } from '../lib/native-vision-policy-command.js'

function fixture({ inputModalities = ['text', 'image'], enabled = true } = {}) {
  const policies = new Map()
  const registered = []
  const model = { provider: 'native-account', model: 'multimodal' }
  let selected = { ...model }
  let selectCount = 0
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

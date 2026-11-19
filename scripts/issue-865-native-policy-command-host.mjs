// #865 B1 exact DSH 0.2.2-rc.5 CommandRuntime: policy-only native
// enhancement must never write model/selection, intercept the LLM, or touch
// unrelated Sessions. No model requests, external API, files or credentials.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNativeVisionPolicyMutator, installNativeVisionPolicyCommand } from '../lib/native-vision-policy-command.js'
import { installNativeVisionControlRemote, NATIVE_VISION_REMOTE } from '../lib/native-vision-control-remote.js'
import { createSessionVisionPolicyRuntimeStore } from '../lib/session-vision-policy-domain.js'
import { nativeVisionControlViewSchema } from '../lib/native-vision-control-wire.js'

const root = process.env.DSH_SOURCE_ROOT
assert.ok(root, 'DSH_SOURCE_ROOT required')
const absolute = resolve(root)
const host = path => import(pathToFileURL(join(absolute, path)).href)
const hostRequire = createRequire(join(absolute, 'packages/llm/llm/package.json'))
const [
  { Context }, llm, { default: SessionStore }, { default: SessionProjection },
  { default: SystemPrompt }, { default: ToolRuntime },
  { default: AgentRegistry }, { default: AgentLoop }, Commands,
  { default: TypertRegistry }, { default: RemoteAccess }, { default: Gateway },
] = await Promise.all([
  import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href),
  host('packages/llm/llm/src/index.ts'),
  host('packages/core/session/src/index.ts'),
  host('packages/session/session-projection/src/index.ts'),
  host('packages/core/system-prompt/src/index.ts'),
  host('packages/core/tools/src/index.ts'),
  host('packages/core/agent/src/index.ts'),
  host('packages/core/agent-loop/src/index.ts'),
  host('packages/interaction/commands/src/index.ts'),
  host('packages/typert/registry/src/index.ts'),
  host('packages/api/remote-access/src/index.ts'),
  host('packages/api/gateway/src/index.ts'),
])
class SyntheticSource extends llm.LlmAdapter {
  providerInfo(provider) { return { id: provider, name: provider } }
  async listModels(provider) { return [await this.resolveModel(provider, 'test-mm')] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }
  async *stream() { throw new Error('No network/LLM stream is authorized in this test') }
}
const ctx = new Context()
await ctx.plugin(TypertRegistry)
await ctx.plugin(RemoteAccess)
await ctx.plugin(llm.default)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjection)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Commands.default)
await ctx.plugin(Gateway)
const registered = ctx.llm.registerAdapter(['native-test'], new SyntheticSource())
// The actual DVR store is volatile on this fixture without storageDomain.
// Its durable behavior has separate domain tests; observe the same authority.
const store = createSessionVisionPolicyRuntimeStore(ctx)
const mutate = createNativeVisionPolicyMutator(ctx, store)
installNativeVisionPolicyCommand(ctx, store, { mutate })

// Exercise the production registration, not a fixture-only Service.
const namespace = NATIVE_VISION_REMOTE
const mounted = installNativeVisionControlRemote(ctx, store, { mutate })
await mounted?.await?.()
assert.ok(ctx.typert.local.get(namespace + '/observe'), 'production descriptor registered')
let modelReads = 0
const source = ctx.llm.registration('native-test').adapter
const resolveModel = source.resolveModel.bind(source)
source.resolveModel = (...args) => { modelReads++; return resolveModel(...args) }
const makePeer = (principal, ctl = new AbortController()) => ({
  id: 'dvr-865-' + principal.kind, ctx, principal, interactions: 'answer',
  signal: ctl.signal, dispose: async () => ctl.abort(),
})
const owner = makePeer({ kind: 'owner' })
const guest = makePeer({ kind: 'dvr-865-test-guest' })
const bindings = []
ctx.remoteAccess.registerPolicy(guest.principal.kind, { bindings: () => bindings })
const openRemote = (peer, args, signal) => ctx.typertGateway.stream({
  peer, namespace, method: 'observe', args, signal,
})
let handle
let observer
try {
  handle = await ctx.agents.create({
    sessionId: 'dvr-865-native-policy',
    agentOptions: { provider: 'native-test', model: 'test-mm' },
  })
  const agent = handle.agent
  assert.ok(ctx.commands.list(agent).some(command => command.name === 'vision-router'),
    'native DVR policy command must register into real Host command registry')
  const beforeEvents = agent.session.snapshotEvents()
  const modelSelectionsBefore = beforeEvents.filter(event => event.type === 'model/selection').length
  const invoke = async line => {
    const outcome = await ctx.commands.execute(agent, line, [], AbortSignal.timeout(8000))
    assert.ok(outcome, 'the command must be admitted by Host')
    return outcome.result
  }
  const readsBeforeDenied = modelReads
  // Bad wire data and ungranted callers must not reach the observer.
  const args = { agentId: agent.id }
  await assert.rejects(openRemote(owner, { ...args, policy: true }), error =>
    error?.code === 'gateway/arguments-invalid')
  await assert.rejects(openRemote(guest, args), error => error?.code === 'remote-access/denied')
  bindings.push({ role: { name: 'other-session', resource: 'session',
    actions: [namespace + '/observe'] }, resource: { kind: 'session', id: 'not-this-session' } })
  await assert.rejects(openRemote(guest, args), error => error?.code === 'remote-access/denied')
  const setRemote = (peer, request) => ctx.typertGateway.invoke({ peer, namespace, method: 'set',
    args: { agentId: agent.id, request }, signal: AbortSignal.timeout(8000) })
  const selection = { provider: 'native-test', model: 'test-mm' }
  await assert.rejects(setRemote(guest, { enabled: true, selection }), error =>
    error?.code === 'remote-access/denied')
  assert.equal(modelReads, readsBeforeDenied, 'denial must not trigger model discovery')
  assert.equal((await setRemote(owner, { enabled: true, selection: { ...selection, model: 'stale' } })).kind, 'error')
  assert.equal(store.get(agent.id), undefined, 'stale UI never writes')
  const control = new AbortController()
  const remoteStream = await openRemote(owner, args, AbortSignal.any([control.signal, AbortSignal.timeout(15000)]))
  observer = remoteStream[Symbol.asyncIterator]()
  const initial = await observer.next()
  assert.equal(initial.done, false)
  assert.equal(nativeVisionControlViewSchema.parse(initial.value).kind, 'native')
  assert.equal(nativeVisionControlViewSchema.safeParse({ ...initial.value, credentials: 'must-not-leak' }).success, false)
  assert.equal(initial.value.enabled, false)
  assert.equal(agent.session.snapshotEvents().length, beforeEvents.length,
    'opening the live read stream must not log commands or history')
  const liveOn = observer.next()
  assert.equal((await setRemote(owner, { enabled: true, selection })).kind, 'success')
  const onView = await liveOn
  assert.equal(onView.done, false)
  assert.equal(onView.value.enabled, true)
  assert.equal(store.get(agent.id)?.enabled, true)
  assert.equal(agent.model.current()?.provider, 'native-test')
  const liveOff = observer.next()
  assert.equal((await invoke('/vision-router off')).kind, 'success')
  const offView = await liveOff
  assert.equal(offView.done, false)
  assert.equal(offView.value.enabled, false)
  nativeVisionControlViewSchema.parse(onView.value)
  nativeVisionControlViewSchema.parse(offView.value)
  const pending = observer.next()
  control.abort()
  // The Gateway may report cancellation as a terminal error or completion.
  try { assert.equal((await pending).done, true) } catch (error) {
    assert.equal(error?.code, 'gateway/cancelled')
  }
  await observer.return?.()
  observer = undefined
  assert.equal(store.get(agent.id)?.enabled, false)
  assert.equal(agent.model.current()?.provider, 'native-test')
  assert.equal((await invoke('/vision-router status')).kind, 'success')
  const logged = agent.session.snapshotEvents()
  assert.equal(logged.filter(event => event.type === 'model/selection').length,
    modelSelectionsBefore, 'Vision policy commands must not change selected provider or model')
  assert.equal(logged.filter(event => event.type === 'command/run').length, 2)
  assert.equal(logged.filter(event => event.type === 'command/done').length, 2)
  const rendered = agent.session.deriveMessages()
  assert.equal(rendered.some(message => message.content?.some(
    block => block.type === 'text' && block.text.includes('vision-router'))), false,
  'command text itself must never enter model-visible history')
  console.log(JSON.stringify({
    ok: true, kind: 'real Host authorized command without model selection',
    commands: 2, modelSelectionEventsAdded: 0, nativePolicyFinal: false,
    observedPolicyTransitions: [false, true, false], readStreamAddsNoEvents: true,
    realGatewayLookup: true, ungrantedGuestDenied: true, wrongSessionGrantDenied: true,
    malformedArgsDenied: true, carrierAbort: true, sharedWriteAuthority: true, staleUiRejected: true,
  }))
} finally {
  await observer?.return?.()
  if (handle) await handle.dispose()
  registered?.dispose?.()
  await ctx.fiber.dispose()
}

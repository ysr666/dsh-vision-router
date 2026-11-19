// #865 B1 exact DSH 0.2.2-rc.5 CommandRuntime: policy-only native
// enhancement must never write model/selection, intercept the LLM, or touch
// unrelated Sessions. No model requests, external API, files or credentials.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installNativeVisionPolicyCommand } from '../lib/native-vision-policy-command.js'
import { observeNativeVisionControlState } from '../lib/native-vision-control-state.js'
import { createSessionVisionPolicyRuntimeStore } from '../lib/session-vision-policy-domain.js'

const root = process.env.DSH_SOURCE_ROOT
assert.ok(root, 'DSH_SOURCE_ROOT required')
const absolute = resolve(root)
const host = path => import(pathToFileURL(join(absolute, path)).href)
const hostRequire = createRequire(join(absolute, 'packages/llm/llm/package.json'))
const [
  { Context }, llm, { default: SessionStore }, { default: SessionProjection },
  { default: SystemPrompt }, { default: ToolRuntime },
  { default: AgentRegistry }, { default: AgentLoop }, Commands,
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
await ctx.plugin(llm.default)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjection)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Commands.default)
const registered = ctx.llm.registerAdapter(['native-test'], new SyntheticSource())
// The actual DVR store is volatile on this fixture without storageDomain.
// Its durable behavior has separate domain tests; observe the same authority.
const store = createSessionVisionPolicyRuntimeStore(ctx)
installNativeVisionPolicyCommand(ctx, store)
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
  observer = observeNativeVisionControlState(ctx, store, agent, { signal: AbortSignal.timeout(15000) })
  const initial = await observer.next()
  assert.equal(initial.done, false)
  assert.equal(initial.value.kind, 'native')
  assert.equal(initial.value.enabled, false)
  assert.equal(agent.session.snapshotEvents().length, beforeEvents.length,
    'opening the live read stream must not log commands or history')
  const liveOn = observer.next()
  assert.equal((await invoke('/vision-router on')).kind, 'success')
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
  await observer.return()
  assert.equal(store.get(agent.id)?.enabled, false)
  assert.equal(agent.model.current()?.provider, 'native-test')
  assert.equal((await invoke('/vision-router status')).kind, 'success')
  const logged = agent.session.snapshotEvents()
  assert.equal(logged.filter(event => event.type === 'model/selection').length,
    modelSelectionsBefore, 'Vision policy commands must not change selected provider or model')
  assert.equal(logged.filter(event => event.type === 'command/run').length, 3)
  assert.equal(logged.filter(event => event.type === 'command/done').length, 3)
  const rendered = agent.session.deriveMessages()
  assert.equal(rendered.some(message => message.content?.some(
    block => block.type === 'text' && block.text.includes('vision-router'))), false,
  'command text itself must never enter model-visible history')
  console.log(JSON.stringify({
    ok: true, kind: 'real Host authorized command without model selection',
    commands: 3, modelSelectionEventsAdded: 0, nativePolicyFinal: false,
    observedPolicyTransitions: [false, true, false], readStreamAddsNoEvents: true,
  }))
} finally {
  await observer?.return()
  if (handle) await handle.dispose()
  registered?.dispose?.()
  await ctx.fiber.dispose()
}

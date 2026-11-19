// #865 B1: real DVR plugin.apply() + exact pinned DSH Commands/Agent.
// No credentials, network calls, native addon or model stream required.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_SOURCE_ROOT
assert.ok(root, 'DSH_SOURCE_ROOT required')
const host = p => import(pathToFileURL(join(resolve(root), p)).href)
const requireHost = createRequire(join(resolve(root), 'packages/llm/llm/package.json'))
const [
  { Context }, llm, { default: Sessions }, { default: Projection },
  { default: SystemPrompt }, { default: Tools },
  { default: AgentRegistry }, { default: AgentLoop }, { default: Commands },
  { default: AttachmentLocal }, dvr,
] = await Promise.all([
  import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href),
  host('packages/llm/llm/src/index.ts'),
  host('packages/core/session/src/index.ts'),
  host('packages/session/session-projection/src/index.ts'),
  host('packages/core/system-prompt/src/index.ts'),
  host('packages/core/tools/src/index.ts'),
  host('packages/core/agent/src/index.ts'),
  host('packages/core/agent-loop/src/index.ts'),
  host('packages/interaction/commands/src/index.ts'),
  host('packages/attachment/attachment-local/src/index.ts'),
  import(pathToFileURL(join(process.cwd(), '../dvr/index.js')).href),
])
class NativeImageModel extends llm.LlmAdapter {
  providerInfo(id) { return { id, name: 'Exact offline native image provider' } }
  async listModels(provider) { return [await this.resolveModel(provider, 'test-mm')] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }
  async *stream() { throw new Error('No LLM request is allowed in this authorization test') }
}

const ctx = new Context()
await ctx.plugin(llm.default)
await ctx.plugin(Sessions)
await ctx.plugin(Projection)
await ctx.plugin(AttachmentLocal, { dshHome: '/tmp/dvr-865-native-command-fixture' })
await ctx.plugin(SystemPrompt)
await ctx.plugin(Tools)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Commands)
const adapter = ctx.llm.registerAdapter(['native-proof'], new NativeImageModel())
let handle
try {
  await dvr.apply(ctx, dvr.Config({
    tool: true, routing: false, progressiveTools: false,
    autoWrapProviders: false, wrappedProviders: [],
    providers: [], freeFallback: false, downscale: false, cache: false,
  }))
  handle = await ctx.agents.create({
    sessionId: 'dvr-865-real-plugin-native-commands',
    agentOptions: { provider: 'native-proof', model: 'test-mm' },
  })
  const agent = handle.agent
  const visible = ctx.commands.list(agent)
  assert.equal(visible.filter(def => def.name === 'vision-router').length, 1,
    'DVR plugin.apply must install exactly one model-preserving command')
  const before = agent.session.snapshotEvents()
    .filter(event => event.type === 'model/selection').length
  const invoke = async line => {
    const call = await ctx.commands.execute(agent, line, [], AbortSignal.timeout(8000))
    assert.ok(call, 'command must be admitted')
    return call.result
  }
  const on = await invoke('/vision-router on')
  assert.equal(on.kind, 'success', on.text)
  assert.equal(agent.model.current().provider, 'native-proof')
  const statusOn = await invoke('/vision-router status')
  assert.equal(statusOn.kind, 'success')
  assert.match(statusOn.text, /tools: on/)
  const off = await invoke('/vision-router off')
  assert.equal(off.kind, 'success', off.text)
  const statusOff = await invoke('/vision-router status')
  assert.match(statusOff.text, /tools: off/)
  const events = agent.session.snapshotEvents()
  assert.equal(events.filter(e => e.type === 'model/selection').length, before)
  assert.equal(events.filter(e => e.type === 'command/run').length, 4)
  assert.equal(events.filter(e => e.type === 'command/done').length, 4)
  assert.equal(agent.model.current().provider, 'native-proof')
  assert.equal(agent.model.current().model, 'test-mm')
  assert.equal(agent.session.deriveMessages().some(message =>
    message.content?.some(block => block.type === 'text' &&
      block.text.includes('/vision-router'))), false)
  console.log(JSON.stringify({
    ok: true, scenario: 'actual DVR apply + Host commands native permission',
    sessionCommandCount: 4, selectionEventsAdded: 0,
    modelIdentityUnchanged: true, finalPolicy: 'off',
  }))
} finally {
  if (handle) await handle.dispose()
  adapter?.dispose?.()
  await ctx.fiber.dispose()
}

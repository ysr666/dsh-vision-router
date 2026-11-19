// #865 B1: real DVR plugin.apply() + exact pinned DSH Commands/Agent.
// Synthetic model transport only; no credentials, external API or native addon.
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
  { default: TypertRegistry }, { default: RemoteAccess }, { default: Gateway },
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
  // The published npm root is lib/public-entry.js, not the legacy Core
  // implementation index.js. Testing Core directly bypasses runtime
  // composition and would produce a false missing-command diagnosis.
  import(pathToFileURL(join(process.cwd(), '../dvr/lib/public-entry.js')).href),
  host('packages/typert/registry/src/index.ts'),
  host('packages/api/remote-access/src/index.ts'),
  host('packages/api/gateway/src/index.ts'),
])
class NativeImageModel extends llm.LlmAdapter {
  providerInfo(id) { return { id, name: 'Exact offline native image provider' } }
  async listModels(provider) { return [await this.resolveModel(provider, 'test-mm')] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'], toolUpdate: 'addition-only', systemPromptUpdate: 'in-history' }
  }
  async *stream(options) {
    requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'synthetic answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const requests = []
const ctx = new Context()
await ctx.plugin(TypertRegistry)
await ctx.plugin(RemoteAccess)
await ctx.plugin(llm.default)
await ctx.plugin(Sessions)
await ctx.plugin(Projection)
await ctx.plugin(AttachmentLocal, { dshHome: '/tmp/dvr-865-native-command-fixture' })
await ctx.plugin(SystemPrompt)
await ctx.plugin(Tools)
// Only the executor's schema projection is synthetic; the real Host agent
// resolves registered tools, applies restrictions and assembles the request.
ctx.tools.setExecutor({
  describe(definitions) {
    return { schemas: definitions.map(({ name, description, parameters, deferLoading }) => ({
      name, description, parameters: structuredClone(parameters),
      ...(deferLoading === true ? { deferLoading } : {}),
    })) }
  },
  async execute() { throw new Error('Synthetic transport never calls a tool') },
})
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Commands)
await ctx.plugin(Gateway)
const adapter = ctx.llm.registerAdapter(['native-proof'], new NativeImageModel())
let handle, observer
const carrier = new AbortController()
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
  assert.ok(ctx.typert.local.get('dvrNativeVision/observe'), 'public apply registered strict Remote')
  const owner = { id: 'dvr-real-plugin-owner', ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: carrier.signal, dispose: async () => carrier.abort() }
  const stream = await ctx.typertGateway.stream({ peer: owner, namespace: 'dvrNativeVision',
    method: 'observe', args: { agentId: agent.id }, signal: AbortSignal.timeout(30000) })
  observer = stream[Symbol.asyncIterator]()
  const firstView = (await observer.next()).value
  assert.equal(firstView.kind, 'native', JSON.stringify(firstView))
  assert.equal(firstView.enabled, false)
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
  const allOwned = ctx.tools.definitions().filter(definition =>
    definition[Symbol.for('dsh-vision-router.tool-owner')] === true
  ).map(definition => definition.name)
  assert.ok(allOwned.length > 0, 'the actual plugin must register owned tools')
  const known = new Set(allOwned)
  const turn = async (text) => {
    const offset = requests.length
    agent.followup(llm.createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text }],
    }))
    await agent.whenIdle()
    assert.equal(requests.length, offset + 1, 'exactly one native synthetic request')
    const request = requests.at(-1)
    assert.equal(request.provider, 'native-proof')
    assert.equal(request.model, 'test-mm')
    // DSH addition-only may keep a leading baseline plus developer activation
    // blocks. request/header records the complete assembled declaration set;
    // compare this alongside the actual provider-facing projection.
    const header = agent.session.requestHeader()
    assert.ok(header && (header.tools === undefined || Array.isArray(header.tools)),
      'Host committed assembled request header (empty tools are omitted)')
    const active = (header.tools ?? []).map(tool => tool.name).filter(name => known.has(name))
    return { active, leadingOwned: (request.tools ?? []).filter(tool => known.has(tool.name)).length }
  }
  const firstOff = await turn('First text turn: Vision initially off')
  assert.equal(firstOff.active.length, 0, 'OFF must not admit owned DVR definitions')
  const onView = observer.next()
  const on = await ctx.typertGateway.invoke({
    peer: owner, namespace: 'dvrNativeVision', method: 'set',
    args: { agentId: agent.id, request: { enabled: true,
      selection: { provider: 'native-proof', model: 'test-mm' } } },
    signal: AbortSignal.timeout(8000),
  })
  assert.equal(on.kind, 'success', on.text)
  assert.equal((await onView).value.enabled, true)
  assert.equal(agent.model.current().provider, 'native-proof')
  const statusOn = await invoke('/vision-router status')
  assert.equal(statusOn.kind, 'success')
  assert.match(statusOn.text, /tools: on/)
  const enabled = await turn('Second text turn: Vision now on')
  assert.ok(enabled.active.includes('vision_describe'), 'ON must admit precision vision tools to the real Agent request')
  const offView = observer.next()
  const off = await invoke('/vision-router off')
  assert.equal(off.kind, 'success', off.text)
  assert.equal((await offView).value.enabled, false)
  await observer.return()
  observer = undefined
  const statusOff = await invoke('/vision-router status')
  assert.match(statusOff.text, /tools: off/)
  const lastOff = await turn('Third text turn: Vision off again')
  assert.equal(lastOff.active.length, 0, 'returning OFF must remove owned tools from the active header')
  assert.equal(lastOff.leadingOwned, 0, 'OFF must not leave owned declarations in the actual native request')
  const events = agent.session.snapshotEvents()
  assert.equal(events.filter(e => e.type === 'model/selection').length, before)
  assert.equal(events.filter(e => e.type === 'command/run').length, 3)
  assert.equal(events.filter(e => e.type === 'command/done').length, 3)
  assert.equal(agent.model.current().provider, 'native-proof')
  assert.equal(agent.model.current().model, 'test-mm')
  assert.equal(agent.session.deriveMessages().some(message =>
    message.content?.some(block => block.type === 'text' &&
      block.text.includes('/vision-router'))), false)
  console.log(JSON.stringify({
    ok: true, scenario: 'actual DVR apply + Host commands native permission',
    sessionCommandCount: 3, selectionEventsAdded: 0,
    modelIdentityUnchanged: true, finalPolicy: 'off',
    activeOwnedToolCounts: [firstOff.active.length, enabled.active.length, lastOff.active.length],
    nativeRequests: requests.length, productionRemoteTransitions: [false, true, false],
  }))
} finally {
  carrier.abort()
  await observer?.return?.().catch(() => {})
  if (handle) await handle.dispose()
  adapter?.dispose?.()
  await ctx.fiber.dispose()
}

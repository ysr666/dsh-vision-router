// #865 end-to-end acceptance: actual DVR apply() + generated twin registry +
// current pinned DSH Host, no network or real user session.
// Run from Host workspace: pnpm exec tsx ../dvr/scripts/issue-865-plugin-host-integration.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_SOURCE_ROOT
assert.ok(root, 'DSH_SOURCE_ROOT is required')
const host = file => import(pathToFileURL(join(resolve(root), file)).href)
const hostRequire = createRequire(join(root, 'packages/llm/llm/package.json'))
const [
  { Context }, llm, { default: SessionStore }, { default: SessionProjection },
  { default: SystemPrompt }, { default: ToolRuntime }, { default: AgentRegistry },
  { default: AgentLoop }, { default: JsonlPersistence },
  { default: AttachmentLocal }, plugin,
] = await Promise.all([
  import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href),
  host('packages/llm/llm/src/index.ts'),
  host('packages/core/session/src/index.ts'),
  host('packages/session/session-projection/src/index.ts'),
  host('packages/core/system-prompt/src/index.ts'),
  host('packages/core/tools/src/index.ts'),
  host('packages/core/agent/src/index.ts'),
  host('packages/core/agent-loop/src/index.ts'),
  host('packages/session/session-persistence-jsonl/src/index.ts'),
  host('packages/attachment/attachment-local/src/index.ts'),
  import(pathToFileURL(join(process.cwd(), '../dvr/index.js')).href),
])
const { LlmAdapter, createUserMessage, createAssistantMessage, createSystemMessage,
  createDeveloperMessage } = llm
const provider = 'synthetic-account'
const twin = provider + '-vision'
const model = 'synthetic-flash'
const replay = () => ({
  response: { kind: 'deepseek-messages', version: 1, model },
  blocks: [{ type: 'reasoning', signature: 'SYNTHETIC_HOST_SIGNATURE' }],
})
const user = message => createUserMessage({ source: { kind: 'user' },
  content: [{ type: 'text', text: message }] })
const schema = name => ({ name, description: name, parameters: { type: 'object', properties: {} } })
const ctx = new Context()
await ctx.plugin(llm.default)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjection)
await ctx.plugin(AttachmentLocal, { dshHome: '/tmp/dvr-issue-865-fake-attachments' })
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(JsonlPersistence, { root: '/tmp/dvr-issue-865-fake-sessions' })
await ctx.plugin(AgentLoop, { agents: [] })

const received = []
class SyntheticSource extends LlmAdapter {
  providerInfo(route) { return { id: route, name: 'Synthetic account' } }
  async listModels(route) { return [await this.resolveModel(route, model)] }
  async resolveModel(route, id) {
    return { provider: route, id, name: id, inputModalities: ['text', 'image'],
      toolUpdate: 'addition-only', systemPromptUpdate: 'in-history' }
  }
  async *stream(options) {
    received.push(options)
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'synthetic reasoning' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'synthetic reasoning' } }
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: replay() }
  }
}
ctx.llm.registerAdapter([provider], new SyntheticSource())
try {
  await plugin.apply(ctx, plugin.Config({
    routing: false, tool: true, progressiveTools: false,
    autoWrapProviders: false,
    wrappedProviders: [{ provider, models: [model] }],
    providers: [], freeFallback: false, downscale: false, cache: false,
  }))
  assert.ok(ctx.llm.listProviders().some(row => row.id === twin), 'real DVR must mount the generated twin')

  async function call(route, messages, extras = {}) {
    const before = received.length
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: route, model, messages, sessionId: 'synthetic-session',
      maxTokens: 128, ...extras,
    })) {
      assert.notEqual(chunk.type === 'finish' ? chunk.reason.kind : 'ok', 'error',
        'synthetic Host call must not terminate in error')
      chunks.push(chunk)
    }
    assert.equal(received.length, before + 1, 'exactly one source adapter execution')
    assert.equal(received.at(-1).provider, provider)
    return { requested: received.at(-1), chunks }
  }
  const baseHistory = [
    createSystemMessage('stable synthetic system'),
    user('old turn'),
    createAssistantMessage({
      content: [{ type: 'reasoning', text: 'old thinking' }],
      source: { provider, model, replayState: replay() },
    }),
    user('enable vision for the next turn'),
  ]
  const first = await call(twin, baseHistory)
  assert.ok(first.requested.messages.some(message =>
    message.role === 'assistant' && message.source.replayState?.response?.kind === 'deepseek-messages'),
  'twin admission must not erase source-authored native replay')
  const finish = first.chunks.findLast(chunk => chunk.type === 'finish')
  assert.equal(finish?.replayState?.response?.provider, provider,
    'DVR must stamp the provenance of an actually successful native delegated finish')

  const twinHistory = [
    createSystemMessage('stable synthetic system'),
    user('first visual round'),
    createAssistantMessage({
      content: [{ type: 'reasoning', text: 'synthetic reasoning' }],
      source: { provider: twin, model, replayState: finish.replayState },
    }),
    user('second visual round'),
  ]
  const second = await call(twin, twinHistory)
  const saved = second.requested.messages.find(message => message.role === 'assistant')
  assert.equal(saved?.source?.provider, provider, 'proven twin-origin replay is rebound only at dispatch')
  assert.equal(saved?.source?.replayState?.response?.provider, provider)
  assert.equal(twinHistory[2].source.provider, twin, 'durable public route must remain unchanged')

  const removed = createDeveloperMessage({ source: { kind: 'user' },
    content: [{ type: 'tool-removal', toolName: 'base' }] })
  const addedOne = createDeveloperMessage({ source: { kind: 'user' },
    content: [{ type: 'tool-addition', toolName: 'first' }] })
  const addedTwo = createDeveloperMessage({ source: { kind: 'user' },
    content: [{ type: 'tool-addition', toolName: 'later' }] })
  const tools = [schema('first'), schema('later')]
  const history = [
    createSystemMessage('stable synthetic system'),
    user('one'), createAssistantMessage({ content: [{ type: 'text', text: 'answer' }],
      source: { provider, model } }),
    user('remove'), removed, user('add one'), addedOne,
    user('add two'), addedTwo, user('continue'),
  ]
  const toolHistory = {
    tools: [schema('base')],
    updates: [
      { messageId: removed.id, additions: [] },
      { messageId: addedOne.id, additions: [tools[0]] },
      { messageId: addedTwo.id, additions: [tools[1]] },
    ],
  }
  const result = await call(twin, history, { tools, toolHistory })
  const survivingUpdates = result.requested.messages.flatMap(message => message.content)
    .filter(block => block.type === 'tool-addition' || block.type === 'tool-removal')
  assert.equal(survivingUpdates.length, 1, 'source Host must receive exactly one unprojected late addition')
  console.log(JSON.stringify({ ok: true, kind: 'real DVR plugin+Host twin delegation',
    firstSignedReplay: true, twinOriginReplay: true,
    lateToolUpdates: survivingUpdates.length, sourceCalls: received.length }))
} finally {
  await ctx.fiber.dispose()
}

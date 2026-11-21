// #865: actual public DVR apply + pinned Host's Agent loop and Commands.
// Offline synthetic usage only; no credentials or user history.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_SOURCE_ROOT
assert.ok(root, 'DSH_SOURCE_ROOT required')
const host = p => import(pathToFileURL(join(resolve(root), p)).href)
const requireHost = createRequire(join(resolve(root), 'packages/llm/llm/package.json'))
const [
  { Context }, llm, { default: Sessions }, { default: Projection },
  { default: SystemPrompt }, { default: Tools }, { default: AgentRegistry },
  { default: AgentLoop }, { default: Commands }, { default: AttachmentLocal }, dvr,
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
  import(pathToFileURL(join(process.cwd(), '../dvr/lib/public-entry.js')).href),
])
const dir = await mkdtemp(join(tmpdir(), 'dvr-865-cache-'))
const requests = []
const samples = [
  { inputTokens: 10, cacheReadTokens: 90, outputTokens: 7, totalTokens: 107 },
  { inputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10, outputTokens: 8, totalTokens: 108 },
  { inputTokens: 1234, cacheReadTokens: 0, outputTokens: 7, totalTokens: 1241 },
]
class OfflineModel extends llm.LlmAdapter {
  providerInfo(id) { return { id, name: 'Offline cache fixture' } }
  async listModels(provider) { return [await this.resolveModel(provider, 'PRIVATE_MODEL')] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'],
      toolUpdate: 'addition-only', systemPromptUpdate: 'in-history' }
  }
  async *stream(options) {
    const usage = samples[requests.length]
    assert.ok(usage, 'unexpected extra model dispatch')
    requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'PRIVATE_ASSISTANT_CONTENT' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PRIVATE_ASSISTANT_CONTENT' } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const ctx = new Context()
const handles = []
try {
  await ctx.plugin(llm.default)
  await ctx.plugin(Sessions)
  await ctx.plugin(Projection)
  await ctx.plugin(AttachmentLocal, { dshHome: dir })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.setExecutor({
    describe(definitions) { return { schemas: definitions.map(({ name, description, parameters }) =>
      ({ name, description, parameters: structuredClone(parameters) })) } },
    async execute() { throw new Error('No tools expected') },
  })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Commands)
  ctx.llm.registerAdapter(['private-account'], new OfflineModel())
  await ctx.plugin({ inject: dvr.inject, apply(scope) {
    return dvr.apply(scope, dvr.Config({ tool: true, routing: false, progressiveTools: false,
      autoWrapProviders: false, wrappedProviders: [], providers: [],
      freeFallback: false, downscale: false, cache: false }))
  } })
  async function session(id) {
    const handle = await ctx.agents.create({ sessionId: id,
      agentOptions: { provider: 'private-account', model: 'PRIVATE_MODEL' } })
    handles.push(handle)
    return handle.agent
  }
  const a = await session('cache-proof-a')
  const b = await session('cache-proof-b')
  async function turn(agent) {
    const before = requests.length
    agent.followup(llm.createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'PRIVATE_USER_CONTENT' }] }))
    await agent.whenIdle()
    assert.equal(requests.length, before + 1)
  }
  await turn(a)
  await turn(a)
  await turn(b)
  assert.equal(ctx.commands.list(a).filter(d => d.name === 'vision-cache').length, 1)
  const before = a.session.snapshotEvents()
  const selections = before.filter(e => e.type === 'model/selection').length
  const committed = before.filter(e => e.type === 'assistant/message')
  assert.equal(committed.length, 2)
  assert.deepEqual(committed.map(e => e.data.usage?.cacheReadTokens), [90, 70])
  // The command itself appends Host command events. These must not rewrite
  // either Session's existing model-visible message history or request header.
  const historyA = structuredClone(a.session.deriveMessages())
  const historyB = structuredClone(b.session.deriveMessages())
  const headerA = structuredClone(a.session.requestHeader())
  const headerB = structuredClone(b.session.requestHeader())
  async function report(agent) {
    const call = await ctx.commands.execute(agent, '/vision-cache', [], AbortSignal.timeout(8000))
    assert.ok(call, 'Host admitted command')
    assert.equal(call.result.kind, 'success', call.result.text)
    assert.doesNotMatch(call.result.text, /PRIVATE_|private-account|cache-proof-/)
    return call.result.text
  }
  const first = await report(a)
  assert.match(first, /R1 \| 10 \| 90 \| \? \| 7 \| 107 \| 90\.0%/)
  assert.match(first, /R1 \| 20 \| 70 \| 10 \| 8 \| 108 \| 70\.0%/)
  assert.doesNotMatch(first, /1234/)
  const second = await report(b)
  assert.match(second, /R1 \| 1234 \| 0 \| \? \| 7 \| 1241 \| 0\.0%/)
  assert.doesNotMatch(second, /90\.0%|70\.0%/)
  assert.equal(requests.length, 3)
  const after = a.session.snapshotEvents()
  assert.equal(after.filter(e => e.type === 'model/selection').length, selections)
  assert.equal(after.filter(e => e.type === 'assistant/message').length, 2)
  assert.equal(after.filter(e => e.type === 'command/run').length, 1)
  assert.equal(after.filter(e => e.type === 'command/done').length, 1)
  assert.deepEqual(a.session.deriveMessages(), historyA,
    'manual cache command must not rewrite the affected Session model history')
  assert.deepEqual(b.session.deriveMessages(), historyB,
    'manual cache command must not rewrite another Session model history')
  assert.deepEqual(a.session.requestHeader(), headerA,
    'manual cache command must not alter the affected request header')
  assert.deepEqual(b.session.requestHeader(), headerB,
    'manual cache command must not alter another Session request header')
  assert.equal(a.session.deriveMessages().some(message => message.content?.some(
    block => block.type === 'text' && block.text.includes('DVR cache usage'))), false)
  console.log(JSON.stringify({ ok: true, scenario: 'actual DVR public entry + real Host cache command',
    committedUsageRows: 3, sessionIsolation: true, anonymousReport: true,
    addedModelRequests: 0, addedModelSelections: 0, commandEvents: 2 }))
} finally {
  for (const handle of handles.reverse()) await handle.dispose()
  await ctx.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
}

// #865: characterize the REAL DSH LlmRuntime adapter boundary and the native
// DeepSeek Messages serializer. No network, user data, API key or paid requests.
// Run from a pinned Host checkout: node --import tsx ../dvr/scripts/issue-865-wire-characterization.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWrapperStreamBody } from '../lib/core-primitives.js'

const root = resolve(process.env.DSH_SOURCE_ROOT ?? '')
assert.ok(process.env.DSH_SOURCE_ROOT, 'DSH_SOURCE_ROOT is required')
const hostRequire = createRequire(join(root, 'packages/llm/llm/package.json'))
const host = (relative) => import(pathToFileURL(join(root, relative)).href)
const [{ Context }, llm, { serialize }] = await Promise.all([
  import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href),
  host('packages/llm/llm/src/index.ts'),
  host('packages/llm/llm-deepseek/src/serialize.ts'),
])
const { LlmAdapter, createUserMessage, createAssistantMessage, createDeveloperMessage, createSystemMessage } = llm
const modelId = 'deepseek-flash'
const sourceRoute = 'deepseek-account'
const twinRoute = 'deepseek-account-vision'
const connection = {
  models: [{ id: modelId, systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' }],
  defaults: { reasoningEffort: 'high' },
  maxTokens: 1024,
}
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
const text = (value) => ({ type: 'text', text: value })
const user = (value) => createUserMessage({ content: [text(value)], source: { kind: 'user' } })
const assistant = (value, replay = undefined) => createAssistantMessage({
  content: replay ? [{ type: 'reasoning', text: value }] : [text(value)],
  source: { provider: sourceRoute, model: modelId, ...(replay ? { replayState: replay } : {}) },
})
const schema = (name) => ({
  name, description: name + ' synthetic schema',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
})
const ctx = new Context()
await ctx.plugin(llm.default)
const requests = []

class SourceAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Offline synthetic DeepSeek' } }
  async listModels(provider) { return [await this.resolveModel(provider, modelId)] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'],
      toolUpdate: 'addition-only', systemPromptUpdate: 'in-history' }
  }
  async *stream(options) {
    requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const sourceAdapter = new SourceAdapter()
ctx.llm.registerAdapter([sourceRoute], sourceAdapter)
const bridge = createWrapperStreamBody(ctx, {
  imageMemory: new Map(),
  delegateProvider: sourceRoute,
  preserveImageInput: true,
})
class TwinAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Offline twin' } }
  async listModels(provider) { return [await this.resolveModel(provider, modelId)] }
  async resolveModel(provider, model) {
    return { ...await sourceAdapter.resolveModel(sourceRoute, model), provider }
  }
  async *stream(options) { yield* bridge.stream(options) }
}
ctx.llm.registerAdapter([twinRoute], new TwinAdapter())

async function request(provider, messages, opts = {}) {
  const before = requests.length
  for await (const chunk of ctx.llm.stream({
    provider, model: modelId, messages, maxTokens: 128, reasoningEffort: 'high',
    sessionId: 'issue-865-synthetic', signal: AbortSignal.timeout(10000), ...opts,
  })) {
    if (chunk.type === 'error') throw new Error(JSON.stringify(chunk.failure ?? chunk))
  }
  assert.equal(requests.length, before + 1, 'one source adapter dispatch per main call')
  const actual = requests.at(-1)
  assert.equal(actual.provider, sourceRoute, 'both paths must delegate to the same source provider')
  return { options: actual, wire: serialize(actual, connection, actual.messages, new Map(), () => undefined) }
}

const extractSignatures = (wire) =>
  wire.messages.flatMap(message =>
    message.role !== 'assistant' ? [] : message.content.flatMap(block =>
      block.type === 'thinking' && typeof block.signature === 'string' ? [block.signature] : []))
const countChanges = (wire) =>
  wire.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'tool_addition' || block.type === 'tool_removal').length

try {
  const replayState = {
    response: { kind: 'deepseek-messages', version: 1, model: modelId },
    blocks: [{ type: 'reasoning', signature: 'SYNTHETIC_NON_SECRET_SIGNATURE' }],
  }
  const fixed = [
    createSystemMessage('stable synthetic system'),
    user('old user message'),
    assistant('synthetic private thinking', replayState),
    user('new user message'),
  ]
  const direct = await request(sourceRoute, fixed)
  const viaTwin = await request(twinRoute, fixed)
  const restored = await request(sourceRoute, fixed)
  assert.deepEqual(extractSignatures(direct.wire), ['SYNTHETIC_NON_SECRET_SIGNATURE'],
    'native adapter must retain signed DeepSeek Messages replay')
  assert.deepEqual(extractSignatures(restored.wire), extractSignatures(direct.wire),
    'switching back to native route restores original source replay')
  assert.deepEqual(extractSignatures(viaTwin.wire), [],
    'CHARACTERIZATION: the independent twin loses source-owned replay before delegate')
  assert.notEqual(fingerprint(direct.wire), fingerprint(viaTwin.wire))
  assert.equal(fingerprint(direct.wire), fingerprint(restored.wire))

  const base = schema('base')
  const first = schema('first')
  const later = schema('later')
  const removed = createDeveloperMessage({
    source: { kind: 'user' }, content: [{ type: 'tool-removal', toolName: 'base' }],
  })
  const addedFirst = createDeveloperMessage({
    source: { kind: 'user' }, content: [{ type: 'tool-addition', toolName: 'first' }],
  })
  const addedLater = createDeveloperMessage({
    source: { kind: 'user' }, content: [{ type: 'tool-addition', toolName: 'later' }],
  })
  const toolMessages = [
    createSystemMessage('stable synthetic system'),
    user('first user'), assistant('answer one'),
    user('remove tool'), removed, assistant('answer two'),
    user('add first'), addedFirst, assistant('answer three'),
    user('add later'), addedLater, assistant('answer four'),
    user('continue'),
  ]
  const toolHistory = {
    tools: [base],
    updates: [
      { messageId: removed.id, additions: [] },
      { messageId: addedFirst.id, additions: [first] },
      { messageId: addedLater.id, additions: [later] },
    ],
  }
  const config = { tools: [first, later], toolHistory }
  const directTools = await request(sourceRoute, toolMessages, config)
  const viaTwinTools = await request(twinRoute, toolMessages, config)
  // The Host addition-only baseline rebases at the removal and the first
  // post-removal addition. A later update must survive as an activation block.
  assert.ok(countChanges(directTools.wire) > 0,
    'single projection retains the last incremental tool activation')
  assert.equal(countChanges(viaTwinTools.wire), 0,
    'CHARACTERIZATION: wrapper double projection strips a surviving developer update')
  assert.notEqual(fingerprint(directTools.wire), fingerprint(viaTwinTools.wire))

  console.log(JSON.stringify({
    ok: true,
    host: process.env.DSH_EXPECTED_VERSION ?? 'pinned DSH',
    scenario: 'issue-865 real LlmRuntime + DeepSeek Messages serializer',
    replay: {
      directSignatureCount: extractSignatures(direct.wire).length,
      wrappedSignatureCount: extractSignatures(viaTwin.wire).length,
      restoredSignatureCount: extractSignatures(restored.wire).length,
      directPrefix: fingerprint(direct.wire),
      wrappedPrefix: fingerprint(viaTwin.wire),
    },
    toolHistory: {
      directChangeBlocks: countChanges(directTools.wire),
      wrappedChangeBlocks: countChanges(viaTwinTools.wire),
      directPrefix: fingerprint(directTools.wire),
      wrappedPrefix: fingerprint(viaTwinTools.wire),
    },
  }))
} finally {
  await ctx.fiber.dispose()
}

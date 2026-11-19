// #865: characterize the REAL DSH LlmRuntime adapter boundary and the native
// DeepSeek Messages serializer. No network, user data, API key or paid requests.
// Run from a pinned Host checkout: node --import tsx ../dvr/scripts/issue-865-wire-characterization.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWrapperStreamBody } from '../lib/core-primitives.js'
import { contextWithDelegatedReplay } from '../lib/replay-delegation.js'
import { installOwnedTwinStreamBoundary, identifyOwnedTwinStream } from '../lib/owned-twin-stream-boundary.js'

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
      reasoning: { efforts: [
        { id: 'off', name: 'Off' }, { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' }, { id: 'max', name: 'Max' },
      ], defaultEffort: 'high' },
      toolUpdate: 'addition-only', systemPromptUpdate: 'in-history' }
  }
  async *stream(options) {
    requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const sourceAdapter = new SourceAdapter()
ctx.llm.registerAdapter([sourceRoute], sourceAdapter)
const privateContext = contextWithDelegatedReplay(ctx, { wrapperRoute: 'synthetic-not-used' })
const bridge = createWrapperStreamBody(privateContext, {
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
const twinAdapter = new TwinAdapter()
ctx.llm.registerAdapter([twinRoute], twinAdapter)

async function request(provider, messages, opts = {}) {
  const before = requests.length
  for await (const chunk of ctx.llm.stream({
    provider, model: modelId, messages, maxTokens: 128, reasoningEffort: 'high',
    sessionId: 'issue-865-synthetic', signal: AbortSignal.timeout(10000), ...opts,
  })) {
    if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop') {
      throw new Error('DSH request failed before source dispatch: ' + JSON.stringify(chunk.reason))
    }
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

  // Candidate fix seam: the Host's documented llm/stream waterfall runs BEFORE
  // adapterStream's projection. Short-circuit only our synthetic twin so
  // createWrapperStreamBody delegates directly to the real source Runtime.
  // The source Runtime must then project and filter history exactly once.
  // This characterizes correctness, not retry/usage/middleware ordering.
  let delegatedAtWaterfall = 0
  installOwnedTwinStreamBoundary(ctx, (route) => {
    if (route !== twinRoute) return undefined
    delegatedAtWaterfall += 1
    return twinAdapter
  })
  const transparentReplay = await request(twinRoute, fixed)
  const transparentTools = await request(twinRoute, toolMessages, config)
  assert.equal(delegatedAtWaterfall, 2)
  assert.deepEqual(extractSignatures(transparentReplay.wire), extractSignatures(direct.wire),
    'waterfall delegation must preserve source-owned signed history')
  assert.equal(fingerprint(transparentReplay.wire), fingerprint(direct.wire),
    'waterfall delegation must produce identical native DeepSeek replay wire')
  assert.equal(countChanges(transparentTools.wire), countChanges(directTools.wire),
    'waterfall delegation must not lose tool-update blocks')
  assert.equal(fingerprint(transparentTools.wire), fingerprint(directTools.wire),
    'waterfall delegation must produce identical native tool history wire')

  // Known residual gap: a successfully streamed source response is persisted
  // with the *twin* public route as its source identity. Native DeepSeek
  // replayState v1 carries a model id but no separate provider ownership proof.
  // The subsequent source dispatch cannot safely replay that signature until
  // an explicit alias-provenance contract is introduced. This must be covered
  // by a separate fix, not hidden by claiming complete prefix transparency.
  const twinAuthored = [
    createSystemMessage('stable synthetic system'),
    user('first twin conversation turn'),
    createAssistantMessage({
      content: [{ type: 'reasoning', text: 'synthetic private thinking' }],
      source: { provider: twinRoute, model: modelId, replayState },
    }),
    user('next twin conversation turn'),
  ]
  const twinContinuation = await request(twinRoute, twinAuthored)
  assert.equal(extractSignatures(twinContinuation.wire).length, 0,
    'unstamped old twin replay must not be inferred from an alias name')

  const provenTwinAuthored = twinAuthored.map(message => {
    if (message.role !== 'assistant') return message
    return {
      ...message,
      source: {
        ...message.source,
        replayState: {
          ...message.source.replayState,
          response: {
            ...message.source.replayState.response,
            provider: sourceRoute,
          },
        },
      },
    }
  })
  const trustedTwinContinuation = await request(twinRoute, provenTwinAuthored)
  assert.equal(extractSignatures(trustedTwinContinuation.wire).length, 1,
    'provider-stamped native twin replay must survive private DVR source rebinding')

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
      waterfallChangeBlocks: countChanges(transparentTools.wire),
      directPrefix: fingerprint(directTools.wire),
      wrappedPrefix: fingerprint(viaTwinTools.wire),
      waterfallPrefix: fingerprint(transparentTools.wire),
    },
    waterfall: {
      delegatedCalls: delegatedAtWaterfall,
      preservedReplaySignatureCount: extractSignatures(transparentReplay.wire).length,
      sameReplayWire: fingerprint(transparentReplay.wire) === fingerprint(direct.wire),
      sameToolWire: fingerprint(transparentTools.wire) === fingerprint(directTools.wire),
      twinAuthoredReplaySignatureCount: extractSignatures(twinContinuation.wire).length,
      provenTwinReplaySignatureCount: extractSignatures(trustedTwinContinuation.wire).length,
    },
  }))
  // A prepared call is bound to its original registered generation by DSH.
  // Verify the real Host positive control, then the DVR waterfall shortcut
  // against exactly the same synchronous route replacement.
  async function preparedGenerationProbe(route, intercept) {
    const calls = []
    class Generation extends LlmAdapter {
      constructor(label) { super(); this.label = label }
      providerInfo(provider) { return { id: provider, name: 'Offline generation ' + this.label } }
      async listModels(provider) { return [await this.resolveModel(provider, modelId)] }
      async resolveModel(provider, model) {
        return { provider, id: model, name: model, inputModalities: ['text'] }
      }
      async *stream() {
        calls.push(this.label)
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    let current = identifyOwnedTwinStream(new Generation('prepared-old'))
    const old = ctx.llm.registerAdapter([route], current)
    const removeBoundary = intercept
      ? installOwnedTwinStreamBoundary(ctx, provider => provider === route ? current : undefined)
      : undefined
    let replacement
    try {
      const prepared = await ctx.llm.prepareCall({ provider: route, model: modelId, maxTokens: 128 })
      old.replace([])
      current = identifyOwnedTwinStream(new Generation('replacement-new'))
      replacement = ctx.llm.registerAdapter([route], current)
      const chunks = []
      for await (const chunk of prepared.stream({
        ...prepared.config, messages: [user('synthetic generation contract')],
        sessionId: 'synthetic-generation-fence',
      })) chunks.push(chunk)
      assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
      return calls
    } finally {
      removeBoundary?.()
      replacement?.()
      old()
    }
  }
  const baselineGeneration = await preparedGenerationProbe('baseline-prepared-vision', false)
  assert.deepEqual(baselineGeneration, ['prepared-old'], 'positive control: DSH pins its prepared registration')
  const candidateGeneration = await preparedGenerationProbe('candidate-prepared-vision', true)
  console.log(JSON.stringify({ scenario: 'issue-865 pinned prepared registration across HMR',
    baselineGeneration, candidateGeneration,
    candidatePreservesGeneration: candidateGeneration.length === 1 && candidateGeneration[0] === 'prepared-old' }))
  assert.deepEqual(candidateGeneration, ['prepared-old'],
    'DVR transparent dispatch must not replace the Host-pinned adapter generation')
} finally {
  await ctx.fiber.dispose()
}

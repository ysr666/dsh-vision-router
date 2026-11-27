// #864 architecture experiment: preserve real model identity, no wrapper routes.
// Synthetic model transport only; no credentials, external API or native addon.
import assert from 'node:assert/strict'
import { preserveClaimedMessagesOnBlockedStep } from '../lib/session-image-projection-mode.js'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  NativeExecutor, { toolCallResponse },
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
  host('packages/core/tool-executor-native/src/index.ts'),
  host('packages/core/agent-loop/tests/mock-adapter.ts'),
])
class NativeImageModel extends llm.LlmAdapter {
  providerInfo(id) { return { id, name: 'Exact offline native image provider' } }
  async listModels(provider) { return Promise.all(['test-text', 'test-mm'].map(model => this.resolveModel(provider, model))) }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: model === 'test-text' ? ['text'] : ['text', 'image'], reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }, toolUpdate: 'addition-only', systemPromptUpdate: 'in-history' }
  }
  async *stream(options) {
    if (options.model === 'test-mm') {
      visualRequests.push(options)
      const pixels = options.messages.flatMap(m => m.content ?? []).filter(b => b.type === 'image')
      assert.equal(pixels.length, 1, 'vision subcall receives the actual image, not a text marker')
      assert.equal(pixels[0].attachment.attachmentId, fixtureAttachmentId)
      const text = 'DVR864_VISUAL_BACKEND_OK'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    assert.equal(options.model, 'test-text')
    requests.push(options)
    if (pendingCall) {
      const call = pendingCall
      pendingCall = undefined
      yield* toolCallResponse(call.id, call.name, call.args)
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'synthetic answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const requests = []
const visualRequests = []
let fixtureAttachmentId
let modelVisibleHandle
let pendingCall
const ctx = new Context()
await ctx.plugin(TypertRegistry)
await ctx.plugin(RemoteAccess)
await ctx.plugin(llm.default)
await ctx.plugin(Sessions)
await ctx.plugin(Projection)
await ctx.plugin(AttachmentLocal, { dshHome: '/tmp/dvr-865-native-command-fixture' })
await ctx.plugin(SystemPrompt)
await ctx.plugin(Tools)
// Use the same native executor plugin as the official Host tests; only the
// model stream is synthetic. Tool admission, dispatch and result are real.
await ctx.plugin(NativeExecutor)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Commands)
await ctx.plugin(Gateway)
const adapter = ctx.llm.registerAdapter(['source-proof'], new NativeImageModel())
let handle, observer
const workspace = mkdtempSync(join(tmpdir(), 'dvr-864-identity-'))
const carrier = new AbortController()
try {
  await ctx.plugin({ inject: dvr.inject, apply(scope) {
    return dvr.apply(scope, dvr.Config({
      tool: true, routing: false, progressiveTools: false,
      wrapperRoute: '', chainRoute: '', autoWrapProviders: false, wrappedProviders: [],
      rewriteImages: false, autoActivateOnImage: false, instantDescribe: false,
      providers: [{ provider: 'source-proof', model: 'test-mm', fallbacks: [] }],
      structuredVisionBootstrap: false, freeFallback: false, downscale: false, cache: false,
    }))
  } })
  handle = await ctx.agents.create({
    sessionId: 'dvr-864-source-identity-proof',
    meta: { cwd: workspace },
    agentOptions: { provider: 'source-proof', model: 'test-text' },
  })
  const agent = handle.agent
  const owner = { id: 'dvr-864-owner', ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: carrier.signal, dispose: async () => carrier.abort() }
  const stream = await ctx.typertGateway.stream({ peer: owner, namespace: 'dvrNativeVision',
    method: 'observe', args: { agentId: agent.id }, signal: AbortSignal.timeout(30000) })
  observer = stream[Symbol.asyncIterator]()
  const first = (await observer.next()).value
  assert.equal(first.kind, 'native', JSON.stringify(first)) // diagnostic reuses existing wire tag; not the proposed final type
  assert.equal(first.enabled, false)
  const selectionEvents = () => agent.session.snapshotEvents().filter(e => e.type === 'model/selection').length
  const before = selectionEvents()
  const providers = () => ctx.llm.listProviders().map(p => p.id)
  assert.ok(providers().includes('source-proof'))
  assert.ok(!providers().includes('source-proof-vision') && !providers().includes('deepseek-vision'))
  const set = async enabled => {
    const next = observer.next()
    const r = await ctx.typertGateway.invoke({
      peer: owner, namespace: 'dvrNativeVision', method: 'set',
      args: { agentId: agent.id, request: { enabled, selection: { provider: 'source-proof', model: 'test-text' } } },
      signal: AbortSignal.timeout(8000),
    })
    assert.equal(r.kind, 'success', JSON.stringify(r))
    assert.equal((await next).value.enabled, enabled)
    assert.equal(selectionEvents(), before)
  }
  const originalBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const attachment = await ctx.attachments.saveImage({
    data: new Uint8Array(originalBytes),
    mediaType: 'image/png', name: 'identity-proof.png',
  })
  fixtureAttachmentId = attachment.attachmentId
  const turn = async (enabled, withImage) => {
    const offset = requests.length
    const content = [{ type: 'text', text: enabled ? 'Vision on' : 'Vision off' }]
    if (withImage) content.push({ type: 'image', attachment })
    const msg = llm.createUserMessage({ source: { kind: 'user' }, content })
    agent.followup(msg)
    await agent.whenIdle()
    assert.equal(requests.length, offset + 1, JSON.stringify(agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data))
    const request = requests.at(-1)
    assert.equal(request.provider, 'source-proof')
    assert.equal(request.model, 'test-text')
    assert.ok(!request.messages.some(m => m.content?.some(b => b.type === 'image')))
    const tools = agent.session.requestHeader()?.tools ?? []
    assert.equal(tools.some(t => t.name === 'vision_describe'), enabled)
    assert.equal(selectionEvents(), before)
    if (withImage) {
      const original = agent.session.deriveMessages().find(m => m.id === msg.id)
      assert.equal(original?.content.find(b => b.type === 'image')?.attachment?.attachmentId, attachment.attachmentId,
        'Host durable history must retain the original attachment, not a replacement marker')
      const projected = request.messages.find(m => m.id === msg.id)
      const digest = String(attachment.attachmentId).slice(7, 15)
      const marker = projected?.content.find(b => b.type === 'text' && b.text.includes('attachment sha256:' + digest))
      assert.ok(marker, 'Host native text projection must retain deterministic attachment reference')
      const handle = marker.text.match(/attachment (sha256:[0-9a-f]{8,63})\b/i)?.[1]
      assert.ok(handle && String(attachment.attachmentId).startsWith(handle), 'the model must see a resolvable short handle')
      if (modelVisibleHandle) assert.equal(handle, modelVisibleHandle)
      modelVisibleHandle = handle
    }
    return { enabled, withImage, ownedTool: tools.some(t => t.name === 'vision_describe') }
  }
  const results = [await turn(false, true)]
  // Test both direct stale-definition protection and the official Agent batch.
  const retained = ctx.tools.get('vision_materialize')
  assert.equal(typeof retained?.execute, 'function')
  const args = { image: attachment.attachmentId }
  const exec = () => ({ agent, signal: AbortSignal.timeout(10000) })
  const expectDenied = async () => {
    assert.equal(ctx.tools.get('vision_materialize', agent), undefined, 'OFF must hide the actual scoped tool')
    await assert.rejects(() => retained.execute(args, exec()), { code: 'VISION_MODE_DISABLED' })
  }
  const dispatch = async (id, enabled, name = 'vision_materialize') => {
    const offset = requests.length
    const visualOffset = visualRequests.length
    assert.ok(modelVisibleHandle)
    assert.equal(pendingCall, undefined)
    const callArgs = name === 'vision_describe'
      ? { attachmentIds: [modelVisibleHandle], question: 'Describe this fixture image.' }
      : { image: modelVisibleHandle }
    pendingCall = { id, name, args: callArgs }
    agent.followup(llm.createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Exercise local image tool ' + id }] }))
    await agent.whenIdle()
    assert.equal(pendingCall, undefined, 'model call must consume the scripted response')
    assert.equal(requests.length, offset + 2, JSON.stringify(agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data))
    const event = agent.session.snapshotEvents().find(e => e.type === 'tool/result' && e.data.message.source.callId === id)
    assert.ok(event, 'official NativeToolExecutor must settle ' + id)
    const message = event.data.message
    assert.equal(message.isError, !enabled, JSON.stringify(event.data))
    for (const request of requests.slice(offset)) {
      assert.equal(request.provider, 'source-proof')
      assert.equal(request.model, 'test-text')
      assert.ok(!request.messages.some(m => m.content?.some(b => b.type === 'image')))
    }
    if (enabled && name === 'vision_describe') {
      assert.ok(message.content.some(b => b.type === 'text' && b.text.includes('DVR864_VISUAL_BACKEND_OK')), JSON.stringify(event.data))
      assert.equal(visualRequests.length, visualOffset + 1, 'one and only one vision backend subcall')
      assert.equal(visualRequests.at(-1).provider, 'source-proof')
      assert.equal(visualRequests.at(-1).model, 'test-mm')
      const delivered = visualRequests.at(-1).messages.flatMap(m => m.content ?? []).find(b => b.type === 'image')
      const stored = await ctx.attachments.readImage(delivered.attachment)
      assert.deepEqual(Buffer.from(stored.data), originalBytes)
    } else if (enabled) {
      const value = JSON.parse(message.content.find(b => b.type === 'text').text)
      assert.equal(value.safeWorkspaceCopy, true)
      assert.equal(value.source, attachment.attachmentId)
      assert.deepEqual(readFileSync(value.path), originalBytes)
      assert.equal(visualRequests.length, visualOffset, 'local tool must not call a vision backend')
    } else {
      assert.equal(event.data.error?.code, 'UNKNOWN_TOOL', JSON.stringify(event.data))
      assert.equal(visualRequests.length, visualOffset, 'denied tool must not call a vision backend')
    }
    assert.equal(selectionEvents(), before)
    return { enabled, name, nativeDispatch: true, isError: message.isError, visualSubcalls: visualRequests.length - visualOffset }
  }
  await expectDenied()
  await set(true)
  results.push(await turn(true, true))
  const admitted = ctx.tools.get('vision_materialize', agent)
  assert.equal(typeof admitted?.execute, 'function')
  const materialized = JSON.parse(await admitted.execute(args, exec()))
  assert.equal(materialized.safeWorkspaceCopy, true)
  assert.equal(materialized.source, attachment.attachmentId)
  assert.equal(materialized.bytes, originalBytes.length)
  assert.deepEqual(readFileSync(materialized.path), originalBytes, 'actual image tool must recover original attachment bytes')
  const nativeResults = [await dispatch('dvr864-on', true), await dispatch('dvr864-describe', true, 'vision_describe')]
  await set(false)
  results.push(await turn(false, false))
  await expectDenied()
  nativeResults.push(await dispatch('dvr864-off', false))
  nativeResults.push(await dispatch('dvr864-describe-off', false, 'vision_describe'))
  assert.equal(agent.model.current().provider, 'source-proof')
  assert.equal(agent.model.current().model, 'test-text')
  assert.ok(!providers().includes('source-proof-vision') && !providers().includes('deepseek-vision'))
  console.log('ISSUE_864_IDENTITY_PROOF=' + JSON.stringify({ results, modelIdentityUnchanged: true, addedModelSelectionEvents: selectionEvents() - before, providers: providers(), localTool: 'vision_materialize', originalBytesVerified: true, offExecutionDenied: true, nativeResults, modelVisibleHandle, visualSubcalls: visualRequests.length, transport: 'synthetic main and vision model streams; official NativeToolExecutor and real DVR tool/backend dispatch' }))
} finally {
  carrier.abort()
  await observer?.return?.().catch(() => {})
  if (handle) await handle.dispose()
  adapter?.dispose?.()
  await ctx.fiber.dispose()
  rmSync(workspace, { recursive: true, force: true })
}

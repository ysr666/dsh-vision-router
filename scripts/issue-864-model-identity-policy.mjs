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
  NativeExecutor, { toolCallResponse }, { SessionCommandController }, { ApiSessionAgentController },
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
  host('packages/api/session-controller/src/commands.ts'),
  host('packages/api/session-controller/src/agent.ts'),
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
let handle, observer, legacyHandle, legacyObserver, legacyAdapter, diagnosticCommand
const workspace = mkdtempSync(join(tmpdir(), 'dvr-864-identity-'))
const carrier = new AbortController()
try {
  await ctx.plugin({ inject: dvr.inject, apply(scope) {
    return dvr.apply(scope, dvr.Config({
      tool: true, routing: false, progressiveTools: false,
      wrapperRoute: '', chainRoute: '', autoWrapProviders: false,
      // Dormant until the separate explicit legacy-migration fixture registers its source.
      wrappedProviders: [{ provider: 'legacy-source', models: ['test-text'] }],
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
  // Direct agent.followup deliberately proves execution *after* attachment
  // admission, not the product's normal browser upload. Test the actual
  // SessionCommandController separately: metadata remains truthfully text-only.
  const controller = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), workspace)
  // Separate counterexample: making an owned route invisible by returning an
  // empty listModels() must not be confused with a supported presentation alias.
  // Exercise both immutable Hosts' actual catalog and official selection gate.
  const { buildModelCatalog, modelAvailable } = await host('packages/api/session-controller/src/catalog.ts')
  let advertiseFixture = true
  class CatalogVisibilityFixture extends NativeImageModel {
    async listModels(provider) { return advertiseFixture ? super.listModels(provider) : [] }
  }
  const hiddenSelection = { provider: 'catalog-visibility-proof', model: 'test-mm' }
  const hiddenRegistration = ctx.llm.registerAdapter([hiddenSelection.provider], new CatalogVisibilityFixture())
  try {
    const defaultSelection = { provider: 'source-proof', model: 'test-text' }
    const visible = await buildModelCatalog(ctx, defaultSelection)
    assert.ok(visible.groups.some(g => g.id === hiddenSelection.provider))
    assert.equal(await modelAvailable(ctx, hiddenSelection), true)
    advertiseFixture = false
    const hidden = await buildModelCatalog(ctx, defaultSelection)
    assert.ok(!hidden.groups.some(g => g.id === hiddenSelection.provider))
    assert.ok(!hidden.routableProviders.includes(hiddenSelection.provider))
    assert.equal(await modelAvailable(ctx, hiddenSelection), false)
    const info = await ctx.llm.resolveModelInfo(hiddenSelection.provider, hiddenSelection.model)
    assert.equal(info.id, hiddenSelection.model, 'core route still resolves without catalog membership')
    assert.ok(info.inputModalities.includes('image'))
    const prior = JSON.stringify(agent.session.snapshotEvents())
    await assert.rejects(() => controller.selectModel({ sessionId: agent.id, ...hiddenSelection }),
      { code: 'session/model-unavailable' })
    assert.equal(JSON.stringify(agent.session.snapshotEvents()), prior, 'failed GUI selection must not change history')
    assert.equal(agent.model.current().provider, defaultSelection.provider)
    assert.equal(agent.model.current().model, defaultSelection.model)
    console.log('ISSUE_864_CATALOG_HIDING_NEGATIVE=' + JSON.stringify({
      hiddenFromSharedCatalog: true, coreResolves: true, guiAvailable: false,
      officialSelectionRejected: true, noSessionMutation: true,
    }))
  } finally {
    hiddenRegistration.dispose()
  }
  const assertHostAdmissionBlocked = async enabled => {
    const eventCount = agent.session.snapshotEvents().length
    const requestCount = requests.length
    const result = await controller.prompt({
      sessionId: agent.id, requestId: 'dvr864-host-admission-' + enabled,
      mode: 'queue', content: [{ type: 'text', text: 'Check native Host upload' },
        { type: 'image', data: originalBytes.toString('base64'), mediaType: 'image/png', name: 'admission.png' }],
    }, { kind: 'user', rpcId: 'dvr864-host-admission-' + enabled }).then(
      value => ({ value }), error => ({ code: error.code, reason: error.details?.reason, message: error.message }),
    )
    assert.equal(result.code, 'session/attachment-invalid', JSON.stringify(result))
    assert.equal(result.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES', JSON.stringify(result))
    assert.equal(agent.session.snapshotEvents().length, eventCount, 'rejected prompt cannot append a user message')
    assert.equal(requests.length, requestCount, 'rejected prompt cannot dispatch a model request')
    console.log('ISSUE_864_HOST_UPLOAD_GATE=' + JSON.stringify({ enabled, ...result, modelIdentityUnchanged: true }))
    return { enabled, ...result }
  }
  const hostUploadGate = [await assertHostAdmissionBlocked(false)]
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
  const dispatch = async (id, enabled, name = 'vision_materialize', submit) => {
    const offset = requests.length
    const visualOffset = visualRequests.length
    assert.ok(modelVisibleHandle)
    assert.equal(pendingCall, undefined)
    const callArgs = name === 'vision_describe'
      ? { attachmentIds: [modelVisibleHandle], question: 'Describe this fixture image.' }
      : { image: modelVisibleHandle }
    pendingCall = { id, name, args: callArgs }
    if (submit) await submit()
    else agent.followup(llm.createUserMessage({ source: { kind: 'user' },
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
  hostUploadGate.push(await assertHostAdmissionBlocked(true))
  results.push(await turn(true, true))
  const admitted = ctx.tools.get('vision_materialize', agent)
  assert.equal(typeof admitted?.execute, 'function')
  const materialized = JSON.parse(await admitted.execute(args, exec()))
  assert.equal(materialized.safeWorkspaceCopy, true)
  assert.equal(materialized.source, attachment.attachmentId)
  assert.equal(materialized.bytes, originalBytes.length)
  assert.deepEqual(readFileSync(materialized.path), originalBytes, 'actual image tool must recover original attachment bytes')
  const nativeResults = [await dispatch('dvr864-on', true), await dispatch('dvr864-describe', true, 'vision_describe')]
  // Separate positive control for an explicit, user-invoked image command.
  // The Host Commands service has its own documented attachment admission.
  // This is a diagnostic-only alternative interaction, NOT an intercept of
  // ordinary composer submissions or a proposal to silently rewrite them.
  diagnosticCommand = ctx.commands.register({
    name: 'dvr864-diagnostic-image', description: 'Explicit diagnostic image submission',
    input: { hint: 'question', attachments: true }, recordInput: false,
    handler: async ({ agent: receiver, rawInput, attachments, signal }) => {
      assert.equal(receiver, agent)
      signal.throwIfAborted()
      assert.equal(attachments.length, 1)
      assert.equal(attachments[0].type, 'image')
      assert.equal(attachments[0].attachment.attachmentId, attachment.attachmentId)
      receiver.followup(llm.createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: rawInput.trim() }, ...attachments] }))
      return { kind: 'success' }
    },
  })
  const explicitCommandResult = await dispatch('dvr864-explicit-command', true, 'vision_describe', async () => {
    const execution = await ctx.commands.execute(agent, '/dvr864-diagnostic-image Inspect this image',
      [{ type: 'image', data: originalBytes.toString('base64'), mediaType: 'image/png', name: 'command.png' }],
      AbortSignal.timeout(10000))
    assert.equal(execution?.result?.kind, 'success', JSON.stringify(execution))
  })
  assert.equal(explicitCommandResult.visualSubcalls, 1)
  console.log('ISSUE_864_EXPLICIT_COMMAND_PROOF=' + JSON.stringify({ ...explicitCommandResult,
    ordinaryPromptStillBlocked: true, publicCommandAttachmentAdmission: true, modelIdentityUnchanged: true }))
  await set(false)
  results.push(await turn(false, false))
  await expectDenied()
  nativeResults.push(await dispatch('dvr864-off', false))
  nativeResults.push(await dispatch('dvr864-describe-off', false, 'vision_describe'))
  assert.equal(agent.model.current().provider, 'source-proof')
  assert.equal(agent.model.current().model, 'test-text')
  assert.ok(!providers().includes('source-proof-vision') && !providers().includes('deepseek-vision'))
  console.log('ISSUE_864_IDENTITY_PROOF=' + JSON.stringify({ hostUploadGate, explicitCommandResult, results, modelIdentityUnchanged: true, addedModelSelectionEvents: selectionEvents() - before, providers: providers(), localTool: 'vision_materialize', originalBytesVerified: true, offExecutionDenied: true, nativeResults, modelVisibleHandle, visualSubcalls: visualRequests.length, transport: 'synthetic main and vision model streams; official NativeToolExecutor and real DVR tool/backend dispatch' }))

  // Separate explicit legacy-session migration. The source registration is
  // added only now, so the first proof had no generated twin at all.
  legacyAdapter = ctx.llm.registerAdapter(['legacy-source'], new NativeImageModel())
  assert.ok(providers().includes('legacy-source-vision'), 'DVR must create its real owned twin')
  legacyHandle = await ctx.agents.create({
    sessionId: 'dvr-864-legacy-migration', meta: { cwd: workspace },
    agentOptions: { provider: 'legacy-source-vision', model: 'test-text', reasoningEffort: 'high' },
  })
  const oldAgent = legacyHandle.agent
  const original = llm.createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Historical image in legacy session' }, { type: 'image', attachment }] })
  oldAgent.followup(original)
  await oldAgent.whenIdle()
  assert.equal(oldAgent.model.current().provider, 'legacy-source-vision')
  assert.equal(oldAgent.model.current().reasoningEffort, 'high')
  assert.ok(oldAgent.session.requestHeader()?.tools?.some(t => t.name === 'vision_describe'), 'legacy tools ON')
  const prefix = oldAgent.session.snapshotEvents()
  const prefixJson = JSON.stringify(prefix)
  const oldSelectionEvents = prefix.filter(e => e.type === 'model/selection').length
  // A deliberate explicit source-model selection is an ordinary Host event.
  // It is NOT an automatic or silent migration. Preserve the chosen effort.
  oldAgent.model.select({ ...oldAgent.model.current(), provider: 'legacy-source' })
  const observeLegacy = await ctx.typertGateway.stream({ peer: owner, namespace: 'dvrNativeVision',
    method: 'observe', args: { agentId: oldAgent.id }, signal: AbortSignal.timeout(30000) })
  legacyObserver = observeLegacy[Symbol.asyncIterator]()
  const migrated = (await legacyObserver.next()).value
  assert.equal(migrated.kind, 'native', JSON.stringify(migrated))
  assert.equal(migrated.enabled, false, 'route change resets legacy ON; do not silently preserve it')
  const next = legacyObserver.next()
  const receipt = await ctx.typertGateway.invoke({ peer: owner, namespace: 'dvrNativeVision', method: 'set',
    args: { agentId: oldAgent.id, request: { enabled: true, selection: { provider: 'legacy-source', model: 'test-text' } } },
    signal: AbortSignal.timeout(8000) })
  assert.equal(receipt.kind, 'success', JSON.stringify(receipt))
  assert.equal((await next).value.enabled, true)
  const beforeDispatch = requests.length
  oldAgent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue on the source model' }] }))
  await oldAgent.whenIdle()
  assert.equal(requests.length, beforeDispatch + 1)
  const continued = requests.at(-1)
  assert.equal(continued.provider, 'legacy-source')
  assert.equal(continued.model, 'test-text')
  assert.equal(continued.reasoningEffort, 'high')
  assert.ok(oldAgent.session.requestHeader()?.tools?.some(t => t.name === 'vision_describe'))
  const after = oldAgent.session.snapshotEvents()
  assert.equal(JSON.stringify(after.slice(0, prefix.length)), prefixJson, 'migration must not rewrite prior durable history')
  assert.equal(after.filter(e => e.type === 'model/selection').length, oldSelectionEvents + 1)
  const restored = oldAgent.session.deriveMessages().find(m => m.id === original.id)
  assert.equal(restored?.content.find(b => b.type === 'image')?.attachment?.attachmentId, attachment.attachmentId)
  const stored = await ctx.attachments.readImage(attachment)
  assert.deepEqual(Buffer.from(stored.data), originalBytes)
  console.log('ISSUE_864_EXPLICIT_LEGACY_MIGRATION=' + JSON.stringify({
    explicitSelectionEvents: 1, explicitPolicyEnable: true, legacyRoute: 'legacy-source-vision',
    originalProvider: continued.provider, reasoningEffort: continued.reasoningEffort,
    unchangedDurablePrefix: true, historicalImageBytesPreserved: true, automaticMigration: false,
    wrapperRetirementProven: false, coldResumeProven: false,
  }))
} finally {
  carrier.abort()
  await observer?.return?.().catch(() => {})
  await legacyObserver?.return?.().catch(() => {})
  if (legacyHandle) await legacyHandle.dispose()
  diagnosticCommand?.()
  legacyAdapter?.dispose?.()
  if (handle) await handle.dispose()
  adapter?.dispose?.()
  await ctx.fiber.dispose()
  rmSync(workspace, { recursive: true, force: true })
}

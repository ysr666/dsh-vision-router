import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const hostDir = process.env.DSH_CONTRACT_HOST_DIR
if (typeof hostDir !== 'string' || hostDir === '') {
  throw new Error('DSH_CONTRACT_HOST_DIR is required')
}

const hostRequire = createRequire(path.join(hostDir, 'contract-host.cjs'))
const importResolved = async (specifier) => import(pathToFileURL(hostRequire.resolve(specifier)).href)

const llmModule = await importResolved('@deepseek-ai/dsh-llm')
const sessionModule = await importResolved('@deepseek-ai/dsh-session')
const attachmentModule = await importResolved('@deepseek-ai/dsh-attachment-local')
const systemPromptModule = await importResolved('@deepseek-ai/dsh-system-prompt')
const toolsModule = await importResolved('@deepseek-ai/dsh-tools')
const agentModule = await importResolved('@deepseek-ai/dsh-agent')
const agentLoopModule = await importResolved('@deepseek-ai/dsh-agent-loop')
const persistenceModule = await importResolved('@deepseek-ai/dsh-session-persistence-jsonl')
const plugin = await importResolved('dsh-vision-router')

// Cordis is a transitive dependency of the released DSH packages. Resolve it
// from DSH itself so this contract test cannot accidentally load a second copy.
const llmRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-llm'))
const { Context } = await import(pathToFileURL(llmRequire.resolve('@deepseek-ai/cordis')).href)

const LlmRuntime = llmModule.default
const { LlmAdapter, createUserMessage } = llmModule
const SessionStore = sessionModule.default
const { SessionId } = sessionModule
const LocalAttachmentStore = attachmentModule.default
const SystemPrompt = systemPromptModule.default
const ToolRuntime = toolsModule.default
const AgentRegistry = agentModule.default
const AgentLoop = agentLoopModule.default
const JsonlSessionPersistence = persistenceModule.default

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII=',
  'base64',
)

function imageIdsInContent(content, out = []) {
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image' && block.attachment?.attachmentId) {
      out.push(String(block.attachment.attachmentId))
    }
    if (Array.isArray(block.content)) imageIdsInContent(block.content, out)
  }
  return out
}

function imageIdsInMessages(messages) {
  return messages.flatMap((message) => imageIdsInContent(message?.content, []))
}

function unique(values) {
  return [...new Set(values)]
}

function piReplayState() {
  return {
    response: {
      kind: 'pi-ai',
      version: 2,
      api: 'openai-completions',
      provider: 'native-mm',
      model: 'mm',
      stopReason: 'stop',
    },
    blocks: [{ type: 'text' }],
  }
}

function responseChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: piReplayState() },
  ]
}

function assertDelegateReplayIdentity(messages) {
  for (const message of messages ?? []) {
    if (message?.role !== 'assistant' || message?.source?.kind !== 'model') continue
    const response = message.source.replayState?.response
    if (response?.kind !== 'pi-ai' || response?.version !== 2) continue
    assert.equal(
      message.source.provider,
      response.provider,
      `delegate received wrapper source ${String(message.source.provider)} for replay owned by ${String(response.provider)}`,
    )
    assert.equal(message.source.model, response.model)
  }
}

class NativeMultimodalAdapter extends LlmAdapter {
  constructor(label) {
    super()
    this.label = label
    this.requests = []
  }

  providerInfo(provider) {
    return { id: provider, name: 'Native multimodal contract provider' }
  }

  listModels(provider) {
    return Promise.resolve([{
      provider,
      id: 'mm',
      name: 'mm',
      inputModalities: ['text', 'image'],
    }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
    })
  }

  async *stream(options) {
    // Model adapters such as DSH pi-ai validate durable replay metadata against
    // the source identity they receive. A Vision Router twin persists its
    // public route in assistant source.provider, so the plugin must rebind that
    // source to the real delegate provider at request time without mutating the
    // durable session. rc.7 stores that proof under replayState.response.
    assertDelegateReplayIdentity(options.messages)
    this.requests.push(options)
    for (const chunk of responseChunks(`${this.label}-${this.requests.length}`)) yield chunk
  }
}

async function mountHarness({ dshHome, sessionsRoot, adapter }) {
  process.env.DSH_HOME = dshHome
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  ctx.llm.registerAdapter(['native-mm'], adapter)

  const config = plugin.Config({
    routing: false,
    rewriteImages: true,
    tool: true,
    progressiveTools: false,
    autoActivateOnImage: true,
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'native-mm', models: ['mm'] }],
  })
  await plugin.apply(ctx, config)

  assert.ok(
    ctx.llm.listProviders().some((provider) => provider.id === 'native-mm-vision'),
    'Vision Router must register the native provider twin before the session starts',
  )
  const twin = await ctx.llm.resolveModelInfo('native-mm-vision', 'mm')
  assert.ok(twin.inputModalities?.includes('image'), 'the twin must advertise image input to DSH admission')
  return ctx
}

async function imageTurn(agent, refs, text) {
  agent.followup(createUserMessage({
    content: [
      { type: 'text', text },
      ...refs.map((attachment) => ({ type: 'image', attachment })),
    ],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const end = agent.session.events.findLast((event) => event.type === 'turn/end')
  assert.equal(end?.data?.reason?.kind, 'completed', `image turn did not complete: ${JSON.stringify(end?.data?.reason)}`)
}

async function textTurn(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const end = agent.session.events.findLast((event) => event.type === 'turn/end')
  assert.equal(end?.data?.reason?.kind, 'completed', `text turn did not complete: ${JSON.stringify(end?.data?.reason)}`)
}

function replayAssistants(messages) {
  return messages.filter((message) => message?.role === 'assistant' && message?.source?.replayState?.response?.kind === 'pi-ai')
}

const root = await mkdtemp(path.join(tmpdir(), 'vision-router-native-cold-resume-'))
const dshHome = path.join(root, 'dsh-home')
const sessionsRoot = path.join(dshHome, 'sessions')
const sessionId = SessionId('native-mm-cold-resume')
const previousDshHome = process.env.DSH_HOME

try {
  // Lifecycle 1: a completely new current-version session sends several image
  // turns through a source model that is natively multimodal.
  const firstAdapter = new NativeMultimodalAdapter('before')
  const firstCtx = await mountHarness({ dshHome, sessionsRoot, adapter: firstAdapter })
  const refs = await firstCtx.attachments.saveImages([
    { data: new Uint8Array(TRANSPARENT_PNG), mediaType: 'image/png', name: 'one.png' },
    { data: new Uint8Array(RED_PNG), mediaType: 'image/png', name: 'two.png' },
  ])
  assert.equal(refs.length, 2)
  assert.equal(unique(refs.map((ref) => String(ref.attachmentId))).length, 2, 'fixture images must have distinct durable ids')

  const firstHandle = await firstCtx.agents.create({
    sessionId,
    agentOptions: { provider: 'native-mm-vision', model: 'mm' },
  })
  await imageTurn(firstHandle.agent, [refs[0]], 'first image')
  await imageTurn(firstHandle.agent, [refs[1]], 'second image')
  await imageTurn(firstHandle.agent, refs, 'both images')

  assert.equal(firstAdapter.requests.length, 3, 'each image turn should make exactly one native model call')
  for (const request of firstAdapter.requests) {
    assert.equal(request.provider, 'native-mm', 'the twin must delegate to the original native provider')
    assert.equal(request.model, 'mm')
  }
  assert.deepEqual(
    unique(imageIdsInMessages(firstAdapter.requests.at(-1).messages)).sort(),
    refs.map((ref) => String(ref.attachmentId)).sort(),
    'native multimodal delegation must keep original durable image blocks before restart',
  )
  const durableBefore = firstHandle.agent.session.deriveMessages()
  assert.deepEqual(
    unique(imageIdsInMessages(durableBefore)).sort(),
    refs.map((ref) => String(ref.attachmentId)).sort(),
    'the durable session surface must retain both uploaded image refs',
  )
  assert.ok(replayAssistants(durableBefore).length >= 2, 'fixture must persist replay-bearing assistant history')
  assert.ok(
    replayAssistants(durableBefore).every((message) => message.source.provider === 'native-mm-vision'),
    'request-time replay rebinding must not mutate the durable public wrapper identity',
  )
  const persistedRoute = firstHandle.agent.session.requestHeader()?.config
  assert.equal(persistedRoute?.provider, 'native-mm-vision')
  assert.equal(persistedRoute?.model, 'mm')

  await firstCtx.sessions.flush(firstHandle.agent.session)
  await firstHandle.dispose()
  await firstCtx.fiber.dispose()

  // Lifecycle 2: destroy the entire Context, remount DSH + Vision Router from
  // the same on-disk home, resume the same session, then keep chatting. This is
  // the boundary that the previous mock/unit tests did not exercise.
  const secondAdapter = new NativeMultimodalAdapter('after')
  const secondCtx = await mountHarness({ dshHome, sessionsRoot, adapter: secondAdapter })
  for (const ref of refs) {
    const stored = await secondCtx.attachments.readImage(ref)
    assert.ok(stored.data.byteLength > 0, `attachment ${String(ref.attachmentId)} did not survive restart`)
  }

  const secondHandle = await secondCtx.agents.resume({
    resumeSessionId: sessionId,
    // The Web host reconstructs this selection from the session's latest
    // request/header before calling resume. Exercise that same route here.
    agentOptions: { provider: persistedRoute.provider, model: persistedRoute.model },
  })
  const durableAfter = secondHandle.agent.session.deriveMessages()
  assert.deepEqual(
    unique(imageIdsInMessages(durableAfter)).sort(),
    refs.map((ref) => String(ref.attachmentId)).sort(),
    'cold resume must reconstruct the same image-bearing conversation surface',
  )
  assert.ok(
    replayAssistants(durableAfter).every((message) => message.source.provider === 'native-mm-vision'),
    'cold restore must keep durable replay messages attributed to the public twin',
  )

  await textTurn(secondHandle.agent, 'continue after a full DSH restart')
  assert.equal(secondAdapter.requests.length, 1)
  assert.equal(secondAdapter.requests[0].provider, 'native-mm')
  assert.deepEqual(
    unique(imageIdsInMessages(secondAdapter.requests[0].messages)).sort(),
    refs.map((ref) => String(ref.attachmentId)).sort(),
    'the first post-restart model call must still receive historical native image blocks',
  )
  assertDelegateReplayIdentity(secondAdapter.requests[0].messages)

  await imageTurn(secondHandle.agent, [refs[0]], 'new image turn after restart')
  assert.equal(secondAdapter.requests.length, 2)
  assert.ok(
    imageIdsInMessages(secondAdapter.requests[1].messages).includes(String(refs[0].attachmentId)),
    'a new image turn must remain usable after cold resume',
  )
  assertDelegateReplayIdentity(secondAdapter.requests[1].messages)

  await secondCtx.sessions.flush(secondHandle.agent.session)
  await secondHandle.dispose()
  await secondCtx.fiber.dispose()

  console.log('native multimodal cold-resume + replay-v2 contract: OK')
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(root, { recursive: true, force: true })
}

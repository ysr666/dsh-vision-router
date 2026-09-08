import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const hostDir = process.env.DSH_CONTRACT_HOST_DIR
if (typeof hostDir !== 'string' || hostDir === '') throw new Error('DSH_CONTRACT_HOST_DIR is required')

const phase = process.env.DVR_PREVIEW_LIFECYCLE_PHASE
const scriptPath = fileURLToPath(import.meta.url)

if (phase === undefined) {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-preview-native-lifecycle-'))
  try {
    for (const next of ['before', 'after']) {
      const child = spawnSync(process.execPath, [scriptPath], {
        stdio: 'inherit',
        env: {
          ...process.env,
          DVR_PREVIEW_LIFECYCLE_PHASE: next,
          DVR_PREVIEW_LIFECYCLE_ROOT: root,
        },
      })
      assert.equal(child.status, 0, `${next} preview lifecycle process exited with ${String(child.status)}`)
    }
    console.log('DSH preview native multimodal process-restart contract: OK')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  process.exit(0)
}

if (phase !== 'before' && phase !== 'after') throw new Error(`unknown preview lifecycle phase: ${phase}`)
const root = process.env.DVR_PREVIEW_LIFECYCLE_ROOT
if (typeof root !== 'string' || root === '') throw new Error('DVR_PREVIEW_LIFECYCLE_ROOT is required')

const hostRequire = createRequire(path.join(hostDir, 'contract-host.cjs'))
const importResolved = async (specifier) => import(pathToFileURL(hostRequire.resolve(specifier)).href)

const llmModule = await importResolved('@deepseek-ai/dsh-llm')
const sessionModule = await importResolved('@deepseek-ai/dsh-session')
const sessionProjectionModule = await importResolved('@deepseek-ai/dsh-session-projection')
const attachmentModule = await importResolved('@deepseek-ai/dsh-attachment-local')
const systemPromptModule = await importResolved('@deepseek-ai/dsh-system-prompt')
const toolsModule = await importResolved('@deepseek-ai/dsh-tools')
const agentModule = await importResolved('@deepseek-ai/dsh-agent')
const agentLoopModule = await importResolved('@deepseek-ai/dsh-agent-loop')
const persistenceModule = await importResolved('@deepseek-ai/dsh-session-persistence-jsonl')
const plugin = await importResolved('dsh-vision-router')

const llmRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-llm'))
const { Context } = await import(pathToFileURL(llmRequire.resolve('@deepseek-ai/cordis')).href)

const LlmRuntime = llmModule.default
const { LlmAdapter, createUserMessage } = llmModule
const SessionStore = sessionModule.default
const { SessionId } = sessionModule
const SessionProjectionRegistry = sessionProjectionModule.default
const LocalAttachmentStore = attachmentModule.default
const SystemPrompt = systemPromptModule.default
const ToolRuntime = toolsModule.default
const AgentRegistry = agentModule.default
const AgentLoop = agentLoopModule.default
const JsonlSessionPersistence = persistenceModule.default

const dshHome = path.join(root, 'dsh-home')
const sessionsRoot = path.join(dshHome, 'sessions')
const statePath = path.join(root, 'state.json')
const sessionId = SessionId('dvr-preview-native-lifecycle')
process.env.DSH_HOME = dshHome

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function imageIds(messages) {
  const ids = []
  const walk = (content) => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image' && block.attachment?.attachmentId) ids.push(String(block.attachment.attachmentId))
      if (Array.isArray(block.content)) walk(block.content)
    }
  }
  for (const message of messages ?? []) walk(message?.content)
  return [...new Set(ids)]
}

function responseChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class NativePreviewAdapter extends LlmAdapter {
  constructor(label) {
    super()
    this.label = label
    this.requests = []
  }

  providerInfo(provider) { return { id: provider, name: 'DSH preview native image fixture' } }
  providerRetryPolicy() { return undefined }
  listModels(provider) {
    return Promise.resolve([{ provider, id: 'mm', name: 'mm', inputModalities: ['text', 'image'] }])
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  async *stream(options) {
    this.requests.push(options)
    for (const chunk of responseChunks(`${this.label}-${this.requests.length}`)) yield chunk
  }
}

async function mount(label) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  // 0.1.3 makes session projections a concrete AgentLoop dependency. Mount the
  // same service topology used by the current upstream AgentLoop resume tests.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  // Persistence must outlive AgentLoop teardown so owned write handles can
  // drain before the backend closes.
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  await ctx.plugin(AgentLoop, { agents: [] })

  const adapter = new NativePreviewAdapter(label)
  ctx.llm.registerAdapter(['native-mm'], adapter)
  await plugin.apply(ctx, plugin.Config({
    routing: false,
    rewriteImages: true,
    tool: true,
    progressiveTools: false,
    autoActivateOnImage: true,
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'native-mm', models: ['mm'] }],
  }))

  assert.ok(ctx.agentLoop, 'current DSH AgentLoop service must activate')
  assert.ok(ctx.llm.listProviders().some((row) => row.id === 'native-mm-vision'))
  const twin = await ctx.llm.resolveModelInfo('native-mm-vision', 'mm')
  assert.ok(twin.inputModalities?.includes('image'))
  return { ctx, adapter }
}

async function turn(agent, content) {
  agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
  // Session v2 no longer exposes the old mutable session.events array. Idle is
  // the public Agent completion boundary; callers below additionally assert the
  // exact delegated request and durable reconstructed message surface.
  await agent.whenIdle()
}

if (phase === 'before') {
  const { ctx, adapter } = await mount('before')
  const [ref] = await ctx.attachments.saveImages([
    { data: new Uint8Array(PNG), mediaType: 'image/png', name: 'preview.png' },
  ])
  assert.ok(ref?.attachmentId)

  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'native-mm-vision', model: 'mm' },
  })
  await turn(handle.agent, [
    { type: 'text', text: 'remember this image' },
    { type: 'image', attachment: ref },
  ])
  assert.equal(adapter.requests.length, 1)
  assert.equal(adapter.requests[0].provider, 'native-mm')
  assert.ok(imageIds(adapter.requests[0].messages).includes(String(ref.attachmentId)))

  const route = handle.agent.session.requestHeader()?.config
  assert.equal(route?.provider, 'native-mm-vision')
  assert.equal(route?.model, 'mm')
  await handle.dispose()
  assert.ok(await ctx.sessionPersistence.stat(sessionId), 'disposed alpha session must be durably materialized')
  await writeFile(statePath, JSON.stringify({ ref, route }, null, 2))
  await ctx.fiber.dispose()
  console.log('DSH preview native lifecycle before: OK')
} else {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const { ctx, adapter } = await mount('after')
  const stored = await ctx.attachments.readImage(state.ref)
  assert.ok(stored.data.byteLength > 0, 'image attachment must survive the real process restart')

  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: state.route.provider, model: state.route.model },
  })
  const restored = handle.agent.session.deriveMessages()
  assert.ok(
    imageIds(restored).includes(String(state.ref.attachmentId)),
    'Session v2 resume must reconstruct the durable historical image block',
  )

  await turn(handle.agent, [{ type: 'text', text: 'continue after restart' }])
  assert.equal(adapter.requests.length, 1)
  assert.equal(adapter.requests[0].provider, 'native-mm')
  assert.ok(
    imageIds(adapter.requests[0].messages).includes(String(state.ref.attachmentId)),
    'first post-restart delegated call must still receive the historical image block',
  )
  await handle.dispose()
  await ctx.fiber.dispose()
  console.log('DSH preview native lifecycle after: OK')
}

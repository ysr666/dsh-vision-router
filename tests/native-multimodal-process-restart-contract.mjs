import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const phase = process.env.VISION_ROUTER_PROCESS_RESTART_PHASE
const hostDir = process.env.DSH_CONTRACT_HOST_DIR
if (typeof hostDir !== 'string' || hostDir === '') throw new Error('DSH_CONTRACT_HOST_DIR is required')

const scriptPath = fileURLToPath(import.meta.url)

if (phase === undefined) {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-process-restart-'))
  try {
    for (const next of ['before', 'after']) {
      const child = spawnSync(process.execPath, [scriptPath], {
        stdio: 'inherit',
        env: {
          ...process.env,
          VISION_ROUTER_PROCESS_RESTART_PHASE: next,
          VISION_ROUTER_PROCESS_RESTART_ROOT: root,
        },
      })
      assert.equal(child.status, 0, `${next} process exited with ${String(child.status)}`)
    }
    console.log('native multimodal real-process restart contract: OK')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  process.exit(0)
}

if (phase !== 'before' && phase !== 'after') throw new Error(`unknown process-restart phase: ${phase}`)
const root = process.env.VISION_ROUTER_PROCESS_RESTART_ROOT
if (typeof root !== 'string' || root === '') throw new Error('VISION_ROUTER_PROCESS_RESTART_ROOT is required')

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

const dshHome = path.join(root, 'dsh-home')
const sessionsRoot = path.join(dshHome, 'sessions')
const statePath = path.join(root, 'state.json')
const sessionId = SessionId('native-mm-direct-process-restart')
process.env.DSH_HOME = dshHome

const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII=',
  'base64',
)

function replayState() {
  return {
    response: {
      kind: 'pi-ai', version: 2, api: 'openai-completions',
      provider: 'native-mm', model: 'mm', stopReason: 'stop',
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
    { type: 'finish', reason: { kind: 'stop' }, replayState: replayState() },
  ]
}

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

function toolNames(options) {
  const tools = Array.isArray(options?.tools) ? options.tools : []
  return tools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
}

class NativeAdapter extends LlmAdapter {
  constructor(label) {
    super()
    this.label = label
    this.requests = []
  }
  providerInfo(provider) { return { id: provider, name: 'Direct native multimodal provider' } }
  listModels(provider) {
    return Promise.resolve([{ provider, id: 'mm', name: 'mm', inputModalities: ['text', 'image'] }])
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  async *stream(options) {
    for (const message of options.messages ?? []) {
      if (message?.role !== 'assistant' || message?.source?.replayState?.response?.kind !== 'pi-ai') continue
      assert.equal(message.source.provider, 'native-mm')
      assert.equal(message.source.model, 'mm')
    }
    this.requests.push(options)
    for (const chunk of responseChunks(`${this.label}-${this.requests.length}`)) yield chunk
  }
}

async function mount(label) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  const adapter = new NativeAdapter(label)
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
  return { ctx, adapter }
}

async function turn(agent, content) {
  agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
  await agent.whenIdle()
  const end = agent.session.events.findLast((event) => event.type === 'turn/end')
  assert.equal(end?.data?.reason?.kind, 'completed', JSON.stringify(end?.data?.reason))
}

function assertPluginMessagesIdentified(messages) {
  const pluginMessages = messages.filter((message) =>
    message?.role === 'user'
      && message?.source?.kind === 'plugin'
      && message?.source?.plugin === 'dsh-vision-router')
  for (const message of pluginMessages) {
    assert.equal(typeof message.id, 'string')
    assert.ok(message.id.length > 0, 'persisted Vision Router message must have an id')
  }
}

function assertRouterToolsAbsent(requests) {
  assert.equal(
    requests.some((request) => toolNames(request).some((name) => name.startsWith('vision_'))),
    false,
    'ordinary native multimodal route must keep Vision Router tools out while composer Vision mode is off',
  )
}

if (phase === 'before') {
  const { ctx, adapter } = await mount('before')
  const refs = await ctx.attachments.saveImages([
    { data: new Uint8Array(PNG_A), mediaType: 'image/png', name: 'a.png' },
    { data: new Uint8Array(PNG_B), mediaType: 'image/png', name: 'b.png' },
  ])
  assert.equal(refs.length, 2)
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'native-mm', model: 'mm' },
  })
  await turn(handle.agent, [{ type: 'text', text: 'image one' }, { type: 'image', attachment: refs[0] }])
  await turn(handle.agent, [{ type: 'text', text: 'image two' }, { type: 'image', attachment: refs[1] }])
  await turn(handle.agent, [
    { type: 'text', text: 'compare both' },
    { type: 'image', attachment: refs[0] },
    { type: 'image', attachment: refs[1] },
  ])
  assert.equal(adapter.requests.length, 3)
  assert.ok(adapter.requests.every((request) => request.provider === 'native-mm'))
  assert.deepEqual(imageIds(adapter.requests.at(-1).messages).sort(), refs.map((ref) => String(ref.attachmentId)).sort())
  assertRouterToolsAbsent(adapter.requests)
  assertPluginMessagesIdentified(handle.agent.session.deriveMessages())
  const route = handle.agent.session.requestHeader()?.config
  assert.equal(route?.provider, 'native-mm')
  assert.equal(route?.model, 'mm')
  await ctx.sessions.flush(handle.agent.session)
  await writeFile(statePath, JSON.stringify({ refs, route }, null, 2))
  await handle.dispose()
  await ctx.fiber.dispose()
  console.log('native direct process-restart phase before: OK')
} else {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const { ctx, adapter } = await mount('after')
  for (const ref of state.refs) {
    const stored = await ctx.attachments.readImage(ref)
    assert.ok(stored.data.byteLength > 0, `attachment ${String(ref.attachmentId)} missing after process restart`)
  }
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: state.route.provider, model: state.route.model },
  })
  const restored = handle.agent.session.deriveMessages()
  assertPluginMessagesIdentified(restored)
  assert.deepEqual(imageIds(restored).sort(), state.refs.map((ref) => String(ref.attachmentId)).sort())

  await turn(handle.agent, [{ type: 'text', text: 'continue after a real Node process restart' }])
  assert.equal(adapter.requests.length, 1)
  assert.deepEqual(imageIds(adapter.requests[0].messages).sort(), state.refs.map((ref) => String(ref.attachmentId)).sort())

  await turn(handle.agent, [
    { type: 'text', text: 'new image after restart' },
    { type: 'image', attachment: state.refs[0] },
  ])
  assert.equal(adapter.requests.length, 2)
  assert.ok(imageIds(adapter.requests[1].messages).includes(String(state.refs[0].attachmentId)))
  assertRouterToolsAbsent(adapter.requests)
  await ctx.sessions.flush(handle.agent.session)
  await handle.dispose()
  await ctx.fiber.dispose()
  console.log('native direct process-restart phase after: OK')
}

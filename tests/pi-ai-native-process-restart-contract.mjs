import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const phase = process.env.VISION_ROUTER_PI_PROCESS_PHASE
const hostDir = process.env.DSH_CONTRACT_HOST_DIR
if (typeof hostDir !== 'string' || hostDir === '') throw new Error('DSH_CONTRACT_HOST_DIR is required')
const scriptPath = fileURLToPath(import.meta.url)

if (phase === undefined) {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-pi-process-restart-'))
  try {
    for (const next of ['before', 'after']) {
      const child = spawnSync(process.execPath, [scriptPath], {
        stdio: 'inherit',
        env: {
          ...process.env,
          VISION_ROUTER_PI_PROCESS_PHASE: next,
          VISION_ROUTER_PI_PROCESS_ROOT: root,
        },
      })
      assert.equal(child.status, 0, `${next} pi-ai process exited with ${String(child.status)}`)
    }
    console.log('real pi-ai native multimodal process-restart contract: OK')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  process.exit(0)
}

if (phase !== 'before' && phase !== 'after') throw new Error(`unknown phase: ${phase}`)
const root = process.env.VISION_ROUTER_PI_PROCESS_ROOT
if (typeof root !== 'string' || root === '') throw new Error('VISION_ROUTER_PI_PROCESS_ROOT is required')

const hostRequire = createRequire(path.join(hostDir, 'contract-host.cjs'))
const importResolved = async (specifier) => import(pathToFileURL(hostRequire.resolve(specifier)).href)
const llmModule = await importResolved('@deepseek-ai/dsh-llm')
const piModule = await importResolved('@deepseek-ai/dsh-llm-pi-ai')
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
const { createUserMessage } = llmModule
const LlmPiAi = piModule.default ?? piModule
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
const sessionId = SessionId('pi-native-process-restart')
process.env.DSH_HOME = dshHome
process.env.PI_TEST_KEY = 'test-key'

const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII=',
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

function pluginMessages(messages) {
  return (messages ?? []).filter((message) =>
    message?.role === 'user'
      && message?.source?.kind === 'plugin'
      && message?.source?.plugin === 'dsh-vision-router')
}

function assertPluginMessagesIdentified(messages) {
  for (const message of pluginMessages(messages)) {
    assert.equal(typeof message.id, 'string')
    assert.ok(message.id.length > 0)
  }
}

function hasInlineImage(request) {
  return JSON.stringify(request).includes('data:image/png;base64,')
}

function hasVisionTool(request) {
  const tools = Array.isArray(request?.tools) ? request.tools : []
  return tools.some((tool) => {
    const name = tool?.function?.name ?? tool?.name
    return typeof name === 'string' && name.startsWith('vision_')
  })
}

function assertRouterToolsAbsent(requests) {
  assert.equal(
    requests.some(hasVisionTool),
    false,
    'ordinary native pi-ai route must keep Vision Router tools out while composer Vision mode is off',
  )
}

async function mockOpenAiServer() {
  const requests = []
  const paths = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(body === '' ? undefined : JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
        '{"choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":null}]}',
        '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}',
        '[DONE]',
      ]
      for (const event of events) response.write(`data: ${event}\n\n`)
      response.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock provider did not expose a port')
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    paths,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function mount(baseURL) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  await ctx.plugin(LlmPiAi, {
    providers: {
      'native-pi': {
        displayName: 'Native Pi vision test',
        apiKeyEnv: 'PI_TEST_KEY',
        api: 'openai-completions',
        baseURL,
        models: [{
          id: 'mm',
          name: 'mm',
          contextWindow: 65536,
          maxTokens: 4096,
          input: ['text', 'image'],
        }],
      },
    },
  })
  await plugin.apply(ctx, plugin.Config({
    routing: false,
    rewriteImages: true,
    tool: true,
    progressiveTools: false,
    autoActivateOnImage: true,
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'native-pi', models: ['mm'] }],
  }))
  const resolved = await ctx.llm.resolveModelInfo('native-pi', 'mm')
  assert.ok(resolved.inputModalities?.includes('image'), 'real pi-ai route must advertise native image input')
  return ctx
}

async function turn(agent, content) {
  agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
  await agent.whenIdle()
  const end = agent.session.events.findLast((event) => event.type === 'turn/end')
  assert.equal(end?.data?.reason?.kind, 'completed', `turn failed: ${JSON.stringify(end?.data?.reason)}`)
}

const server = await mockOpenAiServer()
let ctx
let handle
try {
  ctx = await mount(server.baseURL)
  if (phase === 'before') {
    const refs = await ctx.attachments.saveImages([
      { data: new Uint8Array(PNG_A), mediaType: 'image/png', name: 'a.png' },
      { data: new Uint8Array(PNG_B), mediaType: 'image/png', name: 'b.png' },
    ])
    handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'native-pi', model: 'mm' },
    })
    await turn(handle.agent, [{ type: 'text', text: 'first' }, { type: 'image', attachment: refs[0] }])
    await turn(handle.agent, [{ type: 'text', text: 'second' }, { type: 'image', attachment: refs[1] }])
    await turn(handle.agent, [
      { type: 'text', text: 'compare' },
      { type: 'image', attachment: refs[0] },
      { type: 'image', attachment: refs[1] },
    ])
    assert.equal(server.requests.length, 3)
    assert.ok(server.requests.every(hasInlineImage), 'real pi-ai must materialize durable image refs onto the wire')
    assertRouterToolsAbsent(server.requests)
    assertPluginMessagesIdentified(handle.agent.session.deriveMessages())
    const route = handle.agent.session.requestHeader()?.config
    assert.equal(route?.provider, 'native-pi')
    assert.equal(route?.model, 'mm')
    await ctx.sessions.flush(handle.agent.session)
    await writeFile(statePath, JSON.stringify({ refs, route }, null, 2))
    console.log('real pi-ai native phase before: OK')
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    for (const ref of state.refs) {
      const stored = await ctx.attachments.readImage(ref)
      assert.ok(stored.data.byteLength > 0)
    }
    handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: state.route.provider, model: state.route.model },
    })
    const restored = handle.agent.session.deriveMessages()
    assertPluginMessagesIdentified(restored)
    assert.deepEqual(imageIds(restored).sort(), state.refs.map((ref) => String(ref.attachmentId)).sort())

    await turn(handle.agent, [{ type: 'text', text: 'continue after restart' }])
    assert.equal(server.requests.length, 1)
    assert.ok(hasInlineImage(server.requests[0]), 'post-restart text turn must rematerialize historical images for pi-ai')
    assertRouterToolsAbsent(server.requests)

    await turn(handle.agent, [
      { type: 'text', text: 'new image after restart' },
      { type: 'image', attachment: state.refs[0] },
    ])
    assert.equal(server.requests.length, 2)
    assert.ok(hasInlineImage(server.requests[1]))
    assertRouterToolsAbsent(server.requests)
    await ctx.sessions.flush(handle.agent.session)
    console.log('real pi-ai native phase after: OK')
  }
} finally {
  if (handle !== undefined) await handle.dispose()
  if (ctx !== undefined) await ctx.fiber.dispose()
  await server.close()
}

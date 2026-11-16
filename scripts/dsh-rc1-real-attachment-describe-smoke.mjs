import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dvrRoot = path.resolve(process.env.DVR_SOURCE_ROOT || fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = process.env.DSH_SOURCE_ROOT
const publishedHost = process.env.DSH_CONTRACT_HOST_DIR
if (!sourceRoot && !publishedHost) {
  throw new Error('DSH_SOURCE_ROOT or DSH_CONTRACT_HOST_DIR is required for exact Host validation')
}
const hostRequire = createRequire(path.join(sourceRoot
  ? path.join(sourceRoot, 'packages/llm/llm')
  : publishedHost, 'package.json'))
const load = async (name, source) => import(pathToFileURL(
  sourceRoot ? path.join(sourceRoot, source) : hostRequire.resolve(name),
).href)

const llm = await load('@deepseek-ai/dsh-llm', 'packages/llm/llm/src/index.ts')
const sessionApi = await load('@deepseek-ai/dsh-session', 'packages/core/session/src/index.ts')
const llmRequire = sourceRoot
  ? hostRequire
  : createRequire(hostRequire.resolve('@deepseek-ai/dsh-llm'))
const { Context } = await import(pathToFileURL(llmRequire.resolve('@deepseek-ai/cordis')).href)
const SessionStore = sessionApi.default
const { SessionId } = sessionApi
const { LlmAdapter, ToolCallId, createUserMessage } = llm
const LlmRuntime = llm.default
const SessionProjection = (await load('@deepseek-ai/dsh-session-projection', 'packages/session/session-projection/src/index.ts')).default
const AttachmentLocal = (await load('@deepseek-ai/dsh-attachment-local', 'packages/attachment/attachment-local/src/index.ts')).default
const SystemPrompt = (await load('@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt/src/index.ts')).default
const Tools = (await load('@deepseek-ai/dsh-tools', 'packages/core/tools/src/index.ts')).default
const NativeToolExecutor = await load('@deepseek-ai/dsh-tool-executor-native', 'packages/core/tool-executor-native/src/index.ts')
const AgentRegistry = (await load('@deepseek-ai/dsh-agent', 'packages/core/agent/src/index.ts')).default
const AgentLoop = (await load('@deepseek-ai/dsh-agent-loop', 'packages/core/agent-loop/src/index.ts')).default
const JsonlPersistence = await load('@deepseek-ai/dsh-session-persistence-jsonl', 'packages/session/session-persistence-jsonl/src/index.ts')
const plugin = await import(pathToFileURL(path.join(dvrRoot, 'index.js')).href)

const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const RESULT = 'DSH_RC1_VISION_ATTACHMENT_OK'
const id = SessionId('dvr-rc1-upload-integration')

class OfflineVision extends LlmAdapter {
  constructor(attachments) { super(); this.attachments = attachments; this.calls = 0 }
  providerInfo(provider) { return { id: provider, name: 'Local offline contract vision model' } }
  providerRetryPolicy() { return undefined }
  async listModels(provider) {
    return [{ provider, id: 'probe', name: 'probe', inputModalities: ['text', 'image'] }]
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }
  async *stream(options) {
    assert.equal(options.provider, 'rc1-offline-mm')
    const retained = options.messages.flatMap(message =>
      (Array.isArray(message.content) ? message.content : [])
        .filter(block => block?.type === 'image' && block.attachment))
    assert.equal(retained.length, 1, 'model must receive exactly one retained image block')
    const stored = await this.attachments.readImage(retained[0].attachment, options.signal)
    assert.ok(stored.data.byteLength > 0, 'last-mile model read needs actual Host bytes')
    this.calls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: RESULT }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: RESULT } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mount(home) {
  process.env.DSH_HOME = home
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(AttachmentLocal, { dshHome: home })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root: path.join(home, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new OfflineVision(ctx.attachments)
  ctx.llm.registerAdapter(['rc1-offline-mm'], adapter)
  await plugin.apply(ctx, plugin.Config({
    routing: false, tool: true, progressiveTools: false,
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'rc1-offline-mm', models: ['probe'] }],
    providers: [{ provider: 'rc1-offline-mm', model: 'probe' }],
    freeFallback: false, downscale: false, cache: false,
    visionTaskTimeoutMs: 8000, timeoutMs: 5000,
  }))
  return { ctx, adapter }
}

async function executeDescribe(ctx, agent, attachmentId, shouldSucceed = true) {
  // Exercise the *Host-owned* NativeToolExecutor pipeline, including per-Agent
  // tool admission, argument parsing, cancellation and canonical result
  // publication. Directly invoking a registered definition would miss these
  // seams and allow an unrelated dispatch regression to escape CI.
  const signal = AbortSignal.timeout(8000)
  const admitted = await ctx.tools.resolve({
    agent,
    modelSelection: { provider: 'rc1-offline-mm-vision', model: 'probe' },
    signal,
  })
  try {
    const batch = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('rc1-upload-image-probe'),
        name: 'vision_describe',
        arguments: JSON.stringify({
          attachmentIds: [attachmentId],
          question: 'identify the uploaded test image',
        }),
      }],
      agent,
      toolSet: admitted,
      signal,
    })
    assert.equal(batch.results.length, 1)
    const result = batch.results[0].result
    if (!shouldSucceed) {
      assert.equal(result.isError, true, 'foreign attachment ID must be rejected')
      const message = result.content?.filter(block => block.type === 'text')
        .map(block => block.text).join(' ') ?? ''
      assert.match(message, /unknown attachment id|not authorized|uploaded in this conversation/)
      return
    }
    assert.equal(result.isError, false, 'authorized upload must return a successful canonical tool result')
    assert.equal(result.value, RESULT, 'real Host attached image must reach the offline vision model')
  } finally {
    admitted.dispose()
  }
}

const root = await mkdtemp(path.join(tmpdir(), 'dvr-rc1-upload-'))
const home = path.join(root, 'dsh-home')
const previousHome = process.env.DSH_HOME
try {
  const first = await mount(home)
  const ref = await first.ctx.attachments.saveImage({
    data: new Uint8Array(fixturePng), mediaType: 'image/png', name: 'fixture.png',
  })
  const agent = await first.ctx.agents.create({
    sessionId: id, agentOptions: { provider: 'rc1-offline-mm-vision', model: 'probe' },
  })
  agent.agent.session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'local image' }, { type: 'image', attachment: ref }],
  }), { surfaceOp: 'append' })
  await executeDescribe(first.ctx, agent.agent, ref.attachmentId)
  assert.equal(first.adapter.calls, 1)

  const foreign = await first.ctx.agents.create({
    sessionId: SessionId('dvr-rc1-foreign-session'),
    agentOptions: { provider: 'rc1-offline-mm-vision', model: 'probe' },
  })
  await executeDescribe(first.ctx, foreign.agent, ref.attachmentId, false)
  assert.equal(first.adapter.calls, 1, 'foreign Session must not reach any visual backend')
  await foreign.dispose()

  await first.ctx.sessions.flush(agent.agent.session)
  await agent.dispose()
  await first.ctx.fiber.dispose()

  const second = await mount(home)
  const resumed = await second.ctx.agents.resume({
    resumeSessionId: id,
    agentOptions: { provider: 'rc1-offline-mm-vision', model: 'probe' },
  })
  await executeDescribe(second.ctx, resumed.agent, ref.attachmentId)
  assert.equal(second.adapter.calls, 1)
  await resumed.dispose()
  await second.ctx.fiber.dispose()
  console.log('DSH_RC1_VISION_DESCRIBE_REAL_HOST_HOT_COLD_ISOLATION_OK')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(root, { recursive: true, force: true })
}

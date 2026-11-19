// #865 D2: production JSONL + upstream native lock + two separate processes.
// Uses real DVR evidence/wrapper helpers, synthetic admission/OCR and LLM.
// Not a full public-plugin, real OCR or paid-provider test.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { planAppendOnlyImageEvidence } from '../lib/stable-image-evidence.js'
import { createWrapperStreamBody } from '../lib/core-primitives.js'

const [phase, temp] = process.argv.slice(2)
if (!phase) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dvr-865-jsonl-'))
  try {
    for (const child of ['write', 'resume']) {
      const run = spawnSync(process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url), child, dir],
        { cwd: process.cwd(), env: { ...process.env, DSH_HOME: path.join(dir, 'home') },
          stdio: 'inherit', timeout: 120_000 })
      if (run.error) throw run.error
      assert.equal(run.status, 0, child + ' process failed: ' + run.signal)
    }
    const first = JSON.parse(await readFile(path.join(dir, 'write.json'), 'utf8'))
    const second = JSON.parse(await readFile(path.join(dir, 'resume.json'), 'utf8'))
    assert.notEqual(first.pid, second.pid, 'must resume in another process')
    assert.deepEqual(second.marker, first.marker)
    assert.deepEqual(second.evidence, first.evidence)
    assert.equal(second.attachmentId, first.attachmentId)
    console.log(JSON.stringify({ ok: true, scenario: 'production JSONL cross-process cold resume',
      rawImageRetained: true, exactMarkerAndEvidenceReplay: true, evidenceCount: 1,
      restoredWithoutVisionMemory: true }))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
} else {
  assert.ok(['write', 'resume'].includes(phase) && temp)
  await runChild()
}

async function runChild() {
const sourceRoot = process.env.DSH_SOURCE_ROOT
assert.ok(sourceRoot, 'DSH_SOURCE_ROOT is required')
const root = path.resolve(sourceRoot)
const host = relative => import(pathToFileURL(path.join(root, relative)).href)
const hostRequire = createRequire(path.join(root, 'packages/llm/llm/package.json'))
const [
  { Context }, llm, { default: SessionStore }, { default: SessionProjection },
  { default: AttachmentLocal }, { default: SystemPrompt }, { default: ToolRuntime },
  { default: AgentRegistry }, { default: AgentLoop }, JsonlPersistence,
] = await Promise.all([
  import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href),
  host('packages/llm/llm/src/index.ts'),
  host('packages/core/session/src/index.ts'),
  host('packages/session/session-projection/src/index.ts'),
  host('packages/attachment/attachment-local/src/index.ts'),
  host('packages/core/system-prompt/src/index.ts'),
  host('packages/core/tools/src/index.ts'),
  host('packages/core/agent/src/index.ts'),
  host('packages/core/agent-loop/src/index.ts'),
  host('packages/session/session-persistence-jsonl/src/index.ts'),
])
const { LlmAdapter, createUserMessage } = llm
const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const home = path.join(temp, 'home')
const sessionId = 'issue-865-evidence-cold-resume'
const SOURCE = { kind: 'plugin:dsh-vision-router' }
class TextAdapter extends LlmAdapter {
  constructor() { super(); this.requests = [] }
  providerInfo(provider) { return { id: provider, name: 'Offline text-only model' } }
  async listModels(provider) { return [await this.resolveModel(provider, 'text')] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text'] }
  }
  async *stream(options) {
    this.requests.push(options)
    assert.ok(options.messages.every(message =>
      message.content.every(block => block.type !== 'image')),
    'native text-only adapter must never receive an image')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'synthetic answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}


async function mount(memory) {
  process.env.DSH_HOME = home
  const ctx = new Context()
  await ctx.plugin(llm.default)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(AttachmentLocal, { dshHome: home })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // The headless Host fixture has no bundled native System binding; this
  // synthetic call never executes a tool. Supply only the real ToolExecutor
  // interface required for schema resolution, without pulling a native addon.
  ctx.tools.setExecutor({
    describe() { return { schemas: [] } },
    async execute() { throw new Error('tool execution is outside this contract') },
  })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root: path.join(home, 'sessions'), compression: 'zstd' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new TextAdapter()
  ctx.llm.registerAdapter(['synthetic-text'], adapter)
  const wrapper = createWrapperStreamBody({
    llm: ctx.llm,
  }, { imageMemory: memory, delegateProvider: 'synthetic-text',
    preserveImageInput: false, stableImageHistory: true })
  class AdmissionAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Offline image admission' } }
    async listModels(provider) { return [await this.resolveModel(provider, 'text')] }
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
    }
    async *stream(options) { yield* wrapper.stream(options) }
  }
  ctx.llm.registerAdapter(['synthetic-admission'], new AdmissionAdapter())
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const original = decision.messages
    // Keep the original attachment in the committed Session; only the adapter
    // projects a stable marker for the text-only source.
    const added = planAppendOnlyImageEvidence(original, original, memory, SOURCE)
    return added.length > 0
      ? { ...decision, messages: [...original, ...added] }
      : decision
  })
  return { ctx, adapter }
}

async function runTurn(agent, content) {
  agent.followup(createUserMessage({
    source: { kind: 'user' },
    content,
  }))
  await agent.whenIdle()
  const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  assert.equal(end?.data?.reason?.kind, 'completed', JSON.stringify(end?.data))
}

const memory = new Map()
const { ctx, adapter } = await mount(memory)
let handle
try {
  let attachmentId
  if (phase === 'write') {
    const ref = await ctx.attachments.saveImage({
      data: new Uint8Array(samplePng), mediaType: 'image/png', name: 'synthetic.png',
    })
    attachmentId = ref.attachmentId
    memory.set(attachmentId, 'SYNTHETIC_OCR_EVIDENCE_V1')
    handle = await ctx.agents.create({
      sessionId, agentOptions: { provider: 'synthetic-admission', model: 'text' },
    })
    await runTurn(handle.agent, [
      { type: 'text', text: 'What does this image say?' },
      { type: 'image', attachment: ref },
    ])
  } else {
    assert.equal(memory.size, 0)
    handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'synthetic-admission', model: 'text' },
    })
    const restored = handle.agent.session.snapshotEvents().filter(event =>
      event.type === 'user/message' && event.data?.id?.startsWith('vision-router-image-evidence-v1-'))
    assert.equal(restored.length, 1, 'production log must restore evidence before next turn')
    await runTurn(handle.agent, [{ type: 'text', text: 'Continue without loading OCR memory' }])
  }
  const events = handle.agent.session.snapshotEvents()
  const original = events.find(event => event.type === 'user/message' &&
    event.data?.content?.some(block => block.type === 'image'))?.data
  assert.ok(original, 'durable original user message must retain the image')
  const image = original.content.find(block => block.type === 'image')
  const durableId = image.attachment?.attachmentId ?? image.attachment?.id
  assert.ok(durableId)
  if (phase === 'write') assert.equal(durableId, attachmentId)
  const durableEvidence = events.filter(event => event.type === 'user/message' &&
    event.data?.id?.startsWith('vision-router-image-evidence-v1-'))
  assert.equal(durableEvidence.length, 1, 'no duplicate evidence in the real log')
  assert.equal(adapter.requests.length, 1)
  const wire = adapter.requests[0].messages
  const marker = wire.find(message => message.id === original.id)
  assert.ok(marker?.content.some(block => block.type === 'text' && block.text.includes(durableId)))
  assert.ok(!marker.content.some(block => block.type === 'image'))
  const evidence = wire.filter(message => message.id?.startsWith('vision-router-image-evidence-v1-'))
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].id, durableEvidence[0].data.id)
  assert.match(evidence[0].content[0].text, /SYNTHETIC_OCR_EVIDENCE_V1/)
  await ctx.sessions.flush(handle.agent.session)
  await handle.dispose()
  handle = undefined
  await writeFile(path.join(temp, phase + '.json'), JSON.stringify({
    pid: process.pid, attachmentId: durableId,
    marker: { id: marker.id, content: marker.content },
    evidence: { id: evidence[0].id, content: evidence[0].content },
  }))
} finally {
  try { await handle?.dispose() } finally { await ctx.fiber.dispose() }
}
}

// Stage D #865: validate the *actual* Host pre-step durable append contract
// with the same pure append-only evidence module used by DVR. This is NOT a
// synthetic OCR quality or full DVR plug-in e2e; it tests Host persistence,
// context continuity and offline cold resume without external network.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { planAppendOnlyImageEvidence } from '../lib/stable-image-evidence.js'
import { rewriteHistoryImages } from '../lib/core-primitives.js'

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
const originalHome = process.env.DSH_HOME
const temp = await mkdtemp(path.join(tmpdir(), 'dvr-865-evidence-'))
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
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root: path.join(home, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new TextAdapter()
  ctx.llm.registerAdapter(['synthetic-text'], adapter)
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const original = decision.messages
    const stable = rewriteHistoryImages(original, memory, { stable: true }).messages
    const added = planAppendOnlyImageEvidence(original, stable, memory, SOURCE)
    return added.length > 0 || stable !== original
      ? { ...decision, messages: [...stable, ...added] }
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
try {
  const first = await mount(new Map())
  const ref = await first.ctx.attachments.saveImage({
    data: new Uint8Array(samplePng), mediaType: 'image/png', name: 'synthetic.png',
  })
  // Simulate the successful recognized image returned by an offline OCR
  // backend *before* admission; no real HTTP request is performed.
  const visionMemory = new Map([[ref.attachmentId, 'SYNTHETIC_OCR_EVIDENCE_V1']])
  await first.ctx.fiber.dispose()
  const ready = await mount(visionMemory)
  const handle = await ready.ctx.agents.create({
    sessionId, agentOptions: { provider: 'synthetic-text', model: 'text' },
  })
  await runTurn(handle.agent, [
    { type: 'text', text: 'What does this image say?' },
    { type: 'image', attachment: ref },
  ])
  assert.equal(ready.adapter.requests.length, 1)
  const firstWire = ready.adapter.requests[0].messages
  const firstMarker = firstWire.find(message => message?.role === 'user' &&
    message.content.some(block => block.type === 'text' && block.text.includes(ref.attachmentId)))
  const evidence = firstWire.filter(message => message?.id?.startsWith('vision-router-image-evidence-v1-'))
  assert.ok(firstMarker, 'stable marker must be model visible')
  assert.equal(evidence.length, 1)
  assert.match(evidence[0].content[0].text, /SYNTHETIC_OCR_EVIDENCE_V1/)
  const storedEvidence = handle.agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' &&
    event.data?.id?.startsWith('vision-router-image-evidence-v1-'))
  assert.equal(storedEvidence.length, 1, 'pre-step evidence must be a real durable user/message')
  await ready.ctx.sessions.flush(handle.agent.session)
  await handle.dispose()
  await ready.ctx.fiber.dispose()

  const reopened = await mount(new Map())
  const resumed = await reopened.ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'synthetic-text', model: 'text' },
  })
  await runTurn(resumed.agent, [{ type: 'text', text: 'Continue without loading the OCR cache' }])
  assert.equal(reopened.adapter.requests.length, 1)
  const secondWire = reopened.adapter.requests[0].messages
  const persisted = secondWire.filter(message => message?.id?.startsWith('vision-router-image-evidence-v1-'))
  assert.equal(persisted.length, 1, 'evidence must survive cold resume with an empty in-memory Map')
  assert.equal(persisted[0].id, evidence[0].id, 'replayed evidence identity must be stable')
  assert.deepEqual(persisted[0].content, evidence[0].content)
  assert.equal(secondWire.find(message => message?.id === firstMarker.id)?.content[0].text,
    firstMarker.content[0].text, 'old prefix marker remains stable')
  await resumed.dispose()
  await reopened.ctx.fiber.dispose()
  console.log(JSON.stringify({
    ok: true, scenario: 'actual DSH pre-step persisted evidence and cold resume',
    savedEvidenceCount: storedEvidence.length, reopenedEvidenceCount: persisted.length,
    restoredWithoutVisionMemory: true,
  }))
} finally {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  await rm(temp, { recursive: true, force: true })
}

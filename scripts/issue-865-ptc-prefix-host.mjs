// #865 experimental: actual PTC executor and DVR permission/Agent assembly.
// Offline model and program runtime; actual Host SDK renderer and tool registry.
// No production changes, credentials, external API, or generated program execution.
import assert from 'node:assert/strict'
import { compareFinalWireRequests } from './issue-865-final-wire-diff.mjs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
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
])
class NativeImageModel extends llm.LlmAdapter {
  providerInfo(id) { return { id, name: 'Exact offline native image provider' } }
  async listModels(provider) { return [await this.resolveModel(provider, 'test-mm')] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }, toolUpdate: 'addition-only', systemPromptUpdate: 'in-history' }
  }
  async *stream(options) {
    requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'synthetic answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const [{ PtcExecutor }, { PtcRuntime }, { serialize }] = await Promise.all([
  host('packages/core/tool-executor-ptc/src/index.ts'),
  host('packages/ptc-runtime/ptc-runtime/src/index.ts'),
  host('packages/llm/llm-deepseek/src/serialize.ts'),
])
class OfflinePtcRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'fake'
  resolve(request) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120000 }
  }
  async run() {
    throw new Error('This presentation-only probe must never execute a program')
  }
}
const requests = []
const ctx = new Context()
await ctx.plugin(TypertRegistry)
await ctx.plugin(RemoteAccess)
await ctx.plugin(llm.default)
await ctx.plugin(Sessions)
await ctx.plugin(Projection)
await ctx.plugin(AttachmentLocal, { dshHome: '/tmp/dvr-865-ptc-prefix-fixture' })
await ctx.plugin(SystemPrompt)
await ctx.plugin(Tools)
await ctx.plugin(OfflinePtcRuntime)
ctx.tools.setExecutor(new PtcExecutor(ctx))
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Commands)
await ctx.plugin(Gateway)
const adapter = ctx.llm.registerAdapter(['native-proof'], new NativeImageModel())
const handles = []
try {
  await ctx.plugin({ inject: dvr.inject, apply(scope) {
    return dvr.apply(scope, dvr.Config({
      tool: true, routing: false, progressiveTools: false,
      autoWrapProviders: false, wrappedProviders: [],
      providers: [], freeFallback: false, downscale: false, cache: false,
    }))
  } })
  const connection = {
    models: [{ id: 'test-mm', systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' }],
    defaults: { reasoningEffort: 'low' }, maxTokens: 1024,
  }
  const observations = new Map()
  const candidateId = 'dvr-865-ptc-context'
  // Preserve the Host's generated SDK verbatim, but experiment with carrying
  // its current snapshot in the tail context rather than the leading section.
  // No change to the resolver, actual tool bindings, or Session restrictions.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = typeof next === 'function' ? await next() : assembly
    const agent = context.agent ?? context.scope
    if (!agent?.session || !context.signal) return out
    const sdk = out.sections.find(section => section.name === 'tools:sdk')
    if (!sdk || !sdk.text) return out
    observations.set(agent.session.id, sdk.text)
    if (agent.session.id !== candidateId) return out
    return {
      ...out,
      sections: out.sections.map(section => section === sdk ? {
        ...section,
        text: 'Use the most recent runtime tool SDK snapshot for currently admitted bindings. Earlier snapshots are historical only.',
        interpolate: false,
      } : section),
      contexts: [...out.contexts, {
        name: 'dvr-865-ptc-sdk-experiment', text: sdk.text, interpolate: false,
      }],
    }
  })
  const record = request => ({
    wire: serialize(request, connection, request.messages, new Map(), () => undefined),
    upstream: { provider: request.provider, model: request.model },
  })
  for (const id of ['dvr-865-ptc-baseline', candidateId]) {
    const handle = await ctx.agents.create({
      sessionId: id, agentOptions: { provider: 'native-proof', model: 'test-mm' },
    })
    handles.push(handle)
    const agent = handle.agent
    let previous
    const rows = []
    const selections = () => agent.session.snapshotEvents().filter(e => e.type === 'model/selection').length
    const originalSelections = selections()
    for (const [index, enabled] of [false, true, false, true].entries()) {
      if (index > 0) {
        const call = await ctx.commands.execute(agent, '/vision-router ' + (enabled ? 'on' : 'off'), [], AbortSignal.timeout(8000))
        assert.equal(call?.result?.kind, 'success', 'actual DVR command must admit transition')
      }
      const before = requests.length
      agent.followup(llm.createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'PTC presentation turn ' + index }],
      }))
      await agent.whenIdle()
      assert.equal(requests.length, before + 1, 'one main request per turn')
      const request = requests.at(-1)
      assert.equal(request.provider, 'native-proof')
      assert.equal(request.model, 'test-mm')
      assert.equal(selections(), originalSelections, 'native toggle cannot select a model')
      const sdk = observations.get(id)
      assert.ok(sdk, 'real PTC executor must produce SDK')
      assert.equal(sdk.includes('vision_describe'), enabled, 'current SDK matches actual DVR permission')
      const header = agent.session.requestHeader()
      assert.deepEqual(header.tools.map(t => t.name), ['run_code'], 'real PTC active transport must be fixed')
      const current = record(request)
      assert.deepEqual(current.wire.tools.map(t => t.name), ['run_code'])
      const diff = previous ? compareFinalWireRequests(previous, current) : null
      rows.push({ enabled, currentSdkHasVision: sdk.includes('vision_describe'),
        headerTools: current.wire.tools.map(t => t.name),
        prefixPreserved: diff?.localSerializedPrefixPreserved ?? null,
        changedDimensions: diff?.changedDimensions ?? [] })
      previous = current
    }
    // This is a characterization of two viable presentation paths, not a
    // release gate requiring a hypothesis to be true. Permission, transport
    // and dispatch invariants above are hard assertions in either case.
    console.log(JSON.stringify({ scenario: 'real PTC executor SDK prefix experiment',
      variant: id === candidateId ? 'tail-context-sdk' : 'native-sdk-section', rows,
      limitations: ['offline program runtime', 'no nested execution or provider cache proof', 'historical SDK remains in prior messages'] }))
  }
} finally {
  for (const handle of handles.reverse()) await handle.dispose()
  adapter?.dispose?.()
  await ctx.fiber.dispose()
}

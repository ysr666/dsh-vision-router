import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const hostDir = process.env.DSH_CONTRACT_HOST_DIR
if (typeof hostDir !== 'string' || hostDir === '') throw new Error('DSH_CONTRACT_HOST_DIR is required')

const hostRequire = createRequire(path.join(hostDir, 'contract-host.cjs'))
const importResolved = async (specifier) => import(pathToFileURL(hostRequire.resolve(specifier)).href)
const llmModule = await importResolved('@deepseek-ai/dsh-llm')
const piModule = await importResolved('@deepseek-ai/dsh-llm-pi-ai')
const llmRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-llm'))
const { Context } = await import(pathToFileURL(llmRequire.resolve('@deepseek-ai/cordis')).href)
const pluginRoot = path.dirname(hostRequire.resolve('dsh-vision-router/package.json'))
const { installPiAiBridgeWireCompat } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib/pi-ai-bridge-wire-compat.js')).href
)
const { streamWithVisionSessionAffinity } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib/session-affinity-runtime.js')).href
)

const LlmRuntime = llmModule.default
const LlmPiAi = piModule.default ?? piModule
process.env.OPENCODE_WIRE_TEST_KEY = 'test-key'

const routes = [
  ['wire-completions', 'openai-completions', 'https://opencode.ai/zen/go/v1', 'chat/completions'],
  ['wire-responses', 'openai-responses', 'https://opencode.ai/zen/go/v1', 'responses'],
  ['wire-anthropic', 'anthropic-messages', 'https://opencode.ai/zen/go', 'v1/messages'],
]
const captured = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  captured.push({ url: String(input), headers: new Headers(init?.headers ?? {}) })
  // The contract is about the final request wire, not response parsing. A
  // deterministic non-retryable response ends each real SDK call immediately.
  return new Response(JSON.stringify({ error: { message: 'wire captured' } }), {
    status: 418,
    headers: { 'content-type': 'application/json' },
  })
}

const ctx = new Context()
let cleanup = () => {}
try {
  await ctx.plugin(LlmRuntime)
  // Mount pi-ai before the compatibility wrapper, matching real DSH startup.
  // If any SDK captures fetch at mount time, the corresponding API path fails
  // this final-wire contract rather than passing a synthetic unit seam.
  await ctx.plugin(LlmPiAi, {
    providers: Object.fromEntries(routes.map(([provider, api, baseURL]) => [provider, {
      displayName: provider,
      apiKeyEnv: 'OPENCODE_WIRE_TEST_KEY',
      api,
      baseURL,
      models: [{
        id: provider,
        name: provider,
        contextWindow: 8192,
        maxTokens: 128,
        input: ['text'],
      }],
    }])),
  })
  cleanup = installPiAiBridgeWireCompat(ctx)

  for (const [provider] of routes) {
    const call = {
      provider,
      model: provider,
      sessionId: 'session-real-pi-wire',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 16,
    }
    try {
      for await (const _chunk of streamWithVisionSessionAffinity(call.sessionId, () => ctx.llm.stream(call))) {
        // Drain the real DSH -> pi-ai stream so the SDK request starts under
        // the same lazy affinity scope used by production visual calls.
      }
    } catch {
      // The fetch stub intentionally returns 418 after recording the wire.
    }
  }

  assert.equal(captured.length, routes.length, 'each real pi-ai API path should perform one provider request')
  for (let index = 0; index < routes.length; index += 1) {
    const expectedPath = routes[index][3]
    assert.match(
      captured[index].url,
      new RegExp(`^https://opencode\\.ai/zen/go/(?:v1/)?${expectedPath.replace('/', '\\/')}(?:\\?|$)`),
    )
    assert.equal(
      captured[index].headers.get('x-opencode-session'),
      'session-real-pi-wire',
      `${routes[index][1]} final pi-ai wire must carry OpenCode Go session affinity`,
    )
  }
  console.log('real pi-ai OpenCode Go session wire contract: OK')
} finally {
  cleanup()
  globalThis.fetch = originalFetch
}

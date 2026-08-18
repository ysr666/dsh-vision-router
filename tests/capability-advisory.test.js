import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideVisionBackendCapability,
  isOpenAIHttpBridgeTransport,
} from '../index.js'
import {
  assertScreenshotSourceInWorkspace,
  installScreenshotSourceBoundary,
} from '../lib/screenshot-source-boundary.js'

test('undeclared and text-only metadata are advisory for generative backends', () => {
  const unknown = decideVisionBackendCapability(undefined, 'custom-ws', 'mystery-chat', [])
  assert.equal(unknown.image, false)
  assert.equal(unknown.attemptable, true)
  assert.match(unknown.reason, /does not declare image input/)

  const textOnly = decideVisionBackendCapability(
    { inputModalities: ['text'] },
    'custom-provider',
    'mystery-chat',
    [],
  )
  assert.equal(textOnly.image, false)
  assert.equal(textOnly.attemptable, true)
  assert.match(textOnly.reason, /declares no image input/)
})

test('non-generative endpoints remain a hard structural exclusion', () => {
  const embedding = decideVisionBackendCapability(
    { inputModalities: ['text', 'image'] },
    'custom',
    'qwen-vl-embedding',
    [],
  )
  assert.equal(embedding.image, false)
  assert.equal(embedding.attemptable, false)
})

test('direct compatibility bridge accepts only http(s) OpenAI Chat Completions', () => {
  assert.equal(
    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'https://example.test/v1' }),
    true,
  )
  assert.equal(
    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'http://127.0.0.1:9000/v1' }),
    true,
  )
  assert.equal(
    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'wss://example.test/v1' }),
    false,
  )
  assert.equal(
    isOpenAIHttpBridgeTransport({ api: 'anthropic-messages', baseURL: 'https://example.test/v1' }),
    false,
  )
})

test('screenshot source authority uses provider canonical containment and fails closed outside workspace', async () => {
  const workspaceTarget = { targetKey: 'workspace', displayPath: '/workspace' }
  const sourceTarget = { targetKey: 'secret', displayPath: '/workspace/link.html' }
  const calls = []
  const fsService = {
    async resolve(value) {
      calls.push(['resolve', value])
      return value === '/workspace' ? workspaceTarget : sourceTarget
    },
    contains(parent, child) {
      calls.push(['contains', parent, child])
      return false
    },
  }
  const ctx = { get: (name) => (name === 'fs' ? fsService : undefined) }
  const exec = { agent: { session: { header: { cwd: '/workspace' } } } }

  await assert.rejects(
    assertScreenshotSourceInWorkspace(ctx, {}, 'link.html', exec),
    /source must stay inside the session workspace/,
  )
  assert.equal(calls.some(([kind]) => kind === 'contains'), true)
})

test('screenshot source boundary blocks execution before the renderer when containment fails', async () => {
  const defs = new Map()
  const workspaceTarget = { targetKey: 'workspace', displayPath: '/workspace' }
  const insideTarget = { targetKey: 'inside', displayPath: '/workspace/page.html' }
  let allow = false
  const ctx = {
    get(name) {
      if (name !== 'fs') return undefined
      return {
        async resolve(value) { return value === '/workspace' ? workspaceTarget : insideTarget },
        contains() { return allow },
      }
    },
    tools: {
      register(def) {
        defs.set(def.name, def)
        return () => defs.delete(def.name)
      },
    },
  }
  const wrapped = installScreenshotSourceBoundary(ctx, {})
  let rendererCalls = 0
  wrapped.tools.register({
    name: 'vision_html_screenshot',
    async execute() {
      rendererCalls += 1
      return 'rendered'
    },
  })
  const exec = { agent: { session: { header: { cwd: '/workspace' } } } }

  await assert.rejects(
    defs.get('vision_html_screenshot').execute({ source: 'page.html' }, exec),
    /source must stay inside/,
  )
  assert.equal(rendererCalls, 0)

  allow = true
  assert.equal(
    await defs.get('vision_html_screenshot').execute({ source: 'page.html' }, exec),
    'rendered',
  )
  assert.equal(rendererCalls, 1)
})

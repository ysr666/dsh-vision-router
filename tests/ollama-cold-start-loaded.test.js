import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OLLAMA_WARMUP_KEEP_ALIVE,
  createOllamaWarmupManager,
} from '../lib/ollama-cold-start.js'

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('already-loaded Ollama model skips the empty generate on the image fast path', async () => {
  const calls = []
  const manager = createOllamaWarmupManager({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options })
      assert.match(String(url), /\/api\/ps$/)
      return jsonResponse({ models: [{ name: 'qwen2.5vl:latest', model: 'qwen2.5vl:latest' }] })
    },
  })
  try {
    const result = await manager.ensure({
      name: 'local-ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5vl',
    }, { reason: 'hot-image-turn' })
    assert.equal(result.ok, true)
    assert.equal(result.alreadyLoaded, true)
    assert.equal(calls.length, 1)
  } finally {
    manager.dispose()
  }
})

test('forced post-success renewal sends keep_alive even when the model is already loaded', async () => {
  const calls = []
  const manager = createOllamaWarmupManager({
    fetchImpl: async (url, options = {}) => {
      const href = String(url)
      calls.push({ url: href, options })
      if (href.endsWith('/api/ps')) {
        return jsonResponse({ models: [{ name: 'qwen2.5vl', model: 'qwen2.5vl' }] })
      }
      if (href.endsWith('/api/generate')) {
        return jsonResponse({ done: true, response: '', load_duration: 0 })
      }
      return jsonResponse({}, 404)
    },
  })
  try {
    const result = await manager.ensure({
      name: 'local-ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5vl',
    }, { reason: 'post-success-renewal', forceKeepAlive: true })
    assert.equal(result.ok, true)
    assert.equal(result.renewed, true)
    assert.equal(calls.length, 2)
    const generate = calls.find((call) => call.url.endsWith('/api/generate'))
    assert.ok(generate)
    assert.deepEqual(JSON.parse(generate.options.body), {
      model: 'qwen2.5vl',
      prompt: '',
      stream: false,
      keep_alive: OLLAMA_WARMUP_KEEP_ALIVE,
    })
  } finally {
    manager.dispose()
  }
})

test('a different running model does not suppress preload of the selected vision model', async () => {
  const calls = []
  const manager = createOllamaWarmupManager({
    fetchImpl: async (url, options = {}) => {
      const href = String(url)
      calls.push(href)
      if (href.endsWith('/api/ps')) {
        return jsonResponse({ models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }] })
      }
      return jsonResponse({ done: true, response: '' })
    },
  })
  try {
    const result = await manager.ensure({
      name: 'local-ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5vl',
    })
    assert.equal(result.ok, true)
    assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/api/ps', '/api/generate'])
  } finally {
    manager.dispose()
  }
})

test('preload is not reported ready until its JSON body has been consumed successfully', async () => {
  let generateCalled = false
  const manager = createOllamaWarmupManager({
    fetchImpl: async (url) => {
      const href = String(url)
      if (href.endsWith('/api/ps')) return jsonResponse({ models: [] })
      generateCalled = true
      return new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  try {
    const result = await manager.ensure({
      name: 'local-ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5vl',
    })
    assert.equal(generateCalled, true)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'warmup-failed')
    assert.equal(result.error?.code, 'HTTP_RESPONSE_INVALID_JSON')
  } finally {
    manager.dispose()
  }
})

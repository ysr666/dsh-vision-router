import assert from 'node:assert/strict'
import test from 'node:test'

import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

test('endpoint edit rotates breaker identity without invalidating the selected vision-http model id', async () => {
  let config = {
    cache: false,
    cacheMaxEntries: 2,
    cacheTtlSeconds: 60,
    httpProviders: [
      { name: 'custom', model: 'vision', apiKeyEnv: 'KEY', baseURL: 'https://a.example/v1' },
    ],
    proxy: '',
    proxyHosts: [],
  }
  let watchCallback
  let registeredAdapter
  let receivedModel
  const scope = {
    get() { return config },
    watch(callback) { watchCallback = callback; return () => {} },
  }
  const ctx = {
    tools: { register() { return () => {} } },
    llm: {
      registerAdapter(_routes, adapter) {
        registeredAdapter = adapter
        return () => {}
      },
    },
    inject(deps, callback) {
      if (deps.includes('settings')) {
        return callback({ settings: { register() { return scope } } })
      }
      return undefined
    },
    get() { return undefined },
    effect(factory) { return factory() },
  }
  const savedFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('ok')
    const wrapped = installVisionToolRuntimeBoundary(ctx)
    wrapped.inject(['settings'], (child) => {
      const live = child.settings.register('vision-router')
      live.watch(() => {})
    })
    wrapped.llm.registerAdapter(['vision-http'], {
      async *stream(options) {
        receivedModel = options.model
        yield { type: 'text', text: 'ok' }
      },
    })

    config = {
      ...config,
      httpProviders: [{ ...config.httpProviders[0], baseURL: 'https://b.example/v1' }],
    }
    watchCallback?.()

    const chunks = []
    for await (const chunk of registeredAdapter.stream({ model: 'custom/vision' })) chunks.push(chunk)
    assert.equal(receivedModel, 'custom~vr1/vision')
    assert.equal(chunks.length, 1)
    // The caller/Host still used the persisted route id custom/vision; only the
    // adapter's internal lookup identity rotated.
  } finally {
    globalThis.fetch = savedFetch
  }
})

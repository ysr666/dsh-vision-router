import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextWithNativeImageCoexistence,
  sessionUsesNativeImageModel,
} from '../lib/native-image-coexistence.js'

function session(provider, model) {
  return {
    requestHeader() {
      return { config: { provider, model } }
    },
  }
}

function boot({ inputModalities = ['text', 'image'], config = {} } = {}) {
  const handlers = new Map()
  const adapters = new Map()
  const persisted = {
    rewriteImages: true,
    instantDescribe: true,
    routing: false,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
    ...config,
  }
  const scope = {
    get() {
      return persisted
    },
  }
  const settings = {
    get(namespace) {
      if (namespace === 'vision-router') return persisted
      return undefined
    },
    register(namespace) {
      assert.equal(namespace, 'vision-router')
      return scope
    },
  }
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        const list = Array.isArray(routes) ? routes : [routes]
        for (const route of list) adapters.set(route, adapter)
        return () => {
          for (const route of list) {
            if (adapters.get(route) === adapter) adapters.delete(route)
          }
        }
      },
      async resolveModelInfo(provider, model) {
        return { provider, id: model, inputModalities }
      },
    },
    get(name) {
      return name === 'settings' ? settings : undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    inject(_dependencies, callback) {
      return callback({ settings })
    },
  }
  return { ctx, handlers, persisted }
}

test('recognizes an explicitly selected Host-native image model', async () => {
  const { ctx } = boot()
  assert.equal(
    await sessionUsesNativeImageModel(ctx, session('deepseek-official', 'deepseek-v4-flash-vision-exp'), {}),
    true,
  )
})

test('direct capability helper recognizes only explicit plugin routes, not arbitrary -vision names', async () => {
  const text = boot({ inputModalities: ['text'] })
  assert.equal(
    await sessionUsesNativeImageModel(text.ctx, session('deepseek-official', 'deepseek-v4-pro'), {}),
    false,
  )

  const wrapped = boot()
  assert.equal(
    await sessionUsesNativeImageModel(
      wrapped.ctx,
      session('deepseek-vision', 'deepseek-v4-pro'),
      { wrapperRoute: 'deepseek-vision' },
    ),
    false,
  )
  assert.equal(
    await sessionUsesNativeImageModel(
      wrapped.ctx,
      session('openrouter-vision', 'some-model'),
      {},
    ),
    true,
    'a third-party provider ending in -vision remains Host-owned unless Vision Router registered it',
  )
})

test('native image pre-step preserves raw pixels without promoting the route', async () => {
  const harness = boot()
  const bootConfig = {
    rewriteImages: true,
    instantDescribe: true,
    routing: false,
    providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B' }],
  }
  const { ctx, config } = contextWithNativeImageCoexistence(harness.ctx, bootConfig)
  let liveScope
  ctx.inject(['settings'], (child) => {
    liveScope = child.settings.register('vision-router')
  })

  let observed
  ctx.on('agent/pre-step', async (_payload, next) => {
    observed = {
      bootRewrite: config.rewriteImages,
      bootInstant: config.instantDescribe,
      liveRewrite: liveScope.get().rewriteImages,
      liveInstant: liveScope.get().instantDescribe,
      providers: config.providers,
    }
    return next()
  })

  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  await handler(
    { agent: { session: session('deepseek-official', 'deepseek-v4-flash-vision-exp') } },
    async () => ({ kind: 'ok' }),
  )

  assert.deepEqual(observed, {
    bootRewrite: false,
    bootInstant: false,
    liveRewrite: false,
    liveInstant: false,
    providers: bootConfig.providers,
  })
  // The override is turn-local only: no settings mutation and no provider
  // priority/order change survives the pre-step.
  assert.equal(config.rewriteImages, true)
  assert.equal(config.instantDescribe, true)
  assert.equal(harness.persisted.rewriteImages, true)
  assert.equal(harness.persisted.instantDescribe, true)
  assert.equal(config.providers, bootConfig.providers)
})

test('ordinary text and explicitly registered plugin-wrapper turns retain the existing rewrite path', async () => {
  for (const [provider, model, modalities] of [
    ['deepseek-official', 'deepseek-v4-pro', ['text']],
    ['deepseek-vision', 'deepseek-v4-pro', ['text', 'image']],
  ]) {
    const harness = boot({ inputModalities: modalities })
    const { ctx, config } = contextWithNativeImageCoexistence(harness.ctx, {
      rewriteImages: true,
      instantDescribe: true,
      wrapperRoute: 'deepseek-vision',
    })
    if (provider === 'deepseek-vision') {
      ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })
    }
    let observed
    ctx.on('agent/pre-step', async (_payload, next) => {
      observed = [config.rewriteImages, config.instantDescribe]
      return next()
    })
    await harness.handlers.get('agent/pre-step')(
      { agent: { session: session(provider, model) } },
      async () => ({ kind: 'ok' }),
    )
    assert.deepEqual(observed, [true, true])
  }
})
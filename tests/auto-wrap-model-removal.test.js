import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config } from '../index.js'

function autoWrapHarness() {
  const adapters = new Map()
  const registrations = new Map()
  const listeners = new Map()
  const userDoc = {}

  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => undefined }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
    effect(factory) {
      if (typeof factory === 'function') factory()
      return () => {}
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    inject(_deps, callback) {
      const scope = {
        get: () => ({ ...Config({}), ...userDoc }),
        watch() {},
      }
      callback({
        settings: {
          register: (_name, _schema, options) => {
            const base = options && options.base ? options.base : {}
            return { ...scope, get: () => ({ ...Config({}), ...base, ...userDoc }) }
          },
        },
        effect: () => () => {},
      })
    },
    tools: { register: () => () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) {
          if (adapters.has(provider)) throw new Error(`duplicate adapter: ${provider}`)
        }
        for (const provider of providers) {
          adapters.set(provider, adapter)
          registrations.set(provider, {
            adapter,
            retryPolicy:
              typeof adapter.providerRetryPolicy === 'function'
                ? adapter.providerRetryPolicy(provider)
                : undefined,
          })
        }
        return () => {
          for (const provider of providers) {
            if (adapters.get(provider) === adapter) adapters.delete(provider)
            if (registrations.get(provider)?.adapter === adapter) registrations.delete(provider)
          }
        }
      },
      registration(provider) {
        const registration = registrations.get(provider)
        if (!registration) throw new Error(`no adapter registered for provider "${provider}"`)
        return registration
      },
      registerConfigurableProviders() {
        return { replace() {} }
      },
      listProviders() {
        return [...registrations.entries()].map(([provider, registration]) => {
          let info
          try {
            info = registration.adapter.providerInfo?.(provider)
          } catch {
            info = undefined
          }
          return { id: provider, name: info?.name || provider }
        })
      },
      async listModels(provider) {
        const registration = registrations.get(provider)
        if (!registration || typeof registration.adapter.listModels !== 'function') return []
        return registration.adapter.listModels(provider)
      },
      async resolveModelInfo(provider, model) {
        const registration = registrations.get(provider)
        if (!registration || typeof registration.adapter.resolveModel !== 'function') {
          throw new Error(`no adapter registered for provider "${provider}"`)
        }
        return registration.adapter.resolveModel(provider, model)
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }

  return { ctx, adapters, listeners }
}

test('auto-wrap drops a model after the source catalog removes it', async () => {
  const { ctx, adapters } = autoWrapHarness()
  let sourceModels = ['model-a', 'model-b']
  const source = {
    providerInfo: (provider) => ({ id: provider, name: 'Mutable Provider' }),
    providerRetryPolicy: () => undefined,
    listModels: async (provider) =>
      sourceModels.map((id) => ({ provider, id, name: id, inputModalities: ['text'] })),
    resolveModel: async (provider, model) => {
      if (!sourceModels.includes(model)) throw new Error(`unknown model: ${model}`)
      return { provider, id: model, name: model, inputModalities: ['text'] }
    },
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  ctx.llm.registerAdapter(['mutable-provider'], source)
  apply(ctx, Config({ autoWrapProviders: true }))

  const twin = adapters.get('mutable-provider-vision')
  assert.ok(twin, 'expected the source provider to get an auto-vision twin')
  assert.deepEqual(
    (await twin.listModels('mutable-provider-vision')).map((model) => model.id),
    ['model-a', 'model-b'],
  )

  // Simulate Settings -> Models removing one row while the provider route stays
  // live. The already-registered twin must consult the source catalog again;
  // it must not retain a model snapshot captured when the twin was created.
  sourceModels = ['model-a']

  assert.strictEqual(adapters.get('mutable-provider-vision'), twin)
  assert.deepEqual(
    (await twin.listModels('mutable-provider-vision')).map((model) => model.id),
    ['model-a'],
  )
  await assert.rejects(
    () => twin.resolveModel('mutable-provider-vision', 'model-b'),
    /unknown model: model-b/,
  )
})

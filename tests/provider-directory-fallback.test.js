import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { LIVE_MODEL_CLIENT_PRELUDE } from '../lib/live-model-client-prelude.js'

const MANUAL_MODEL_ID = '__vision_router_manual_model__'

function rpc(value) {
  return { rpcId: 'test', result: { ok: true, value } }
}

function modelIds(group) {
  return Array.from(group.models, (model) => model.id)
}

function createHarness({ providerDirectoryFails = false, withDocument = false } = {}) {
  let captured
  const loader = { load(spec) { captured = spec } }
  const changeListeners = []
  const createdOptions = []
  const document = withDocument
    ? {
        documentElement: { lang: 'zh-CN' },
        addEventListener(type, listener, capture) {
          if (type === 'change') changeListeners.push({ listener, capture })
        },
        createElement(tag) {
          assert.equal(tag, 'option')
          const option = { value: '', textContent: '' }
          createdOptions.push(option)
          return option
        },
      }
    : undefined
  const sandbox = {
    window: {
      __ModuleLoader__: loader,
      prompt() { return 'vendor/new-vision-model' },
    },
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      version: 0,
      refreshing: false,
      providers: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    ...(document ? { document } : {}),
  }
  vm.runInNewContext(LIVE_MODEL_CLIENT_PRELUDE, sandbox)

  loader.load({
    id: 'dsh-vision-router',
    factory() {
      let activeCtx
      return {
        async apply(ctx) {
          activeCtx = ctx
          return activeCtx.get('connection').api.llm.models({})
        },
        async modelCatalog() {
          return activeCtx.get('connection').api.llm.models({})
        },
      }
    },
  })
  const exported = captured.factory(() => {})
  let modelCalls = 0
  let providerCalls = 0
  const baseCatalog = rpc({
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    }],
    failures: [{ id: 'openrouter', message: 'catalog unavailable' }],
  })
  const providerDirectory = rpc({
    providers: [
      {
        provider: 'deepseek-official',
        displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek',
        settingsPath: [],
        active: true,
      },
      {
        provider: 'openrouter',
        displayName: 'OpenRouter',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openrouter'],
        active: true,
      },
      {
        provider: 'dormant-provider',
        displayName: 'Dormant',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'dormant-provider'],
        active: false,
      },
    ],
  })
  const ctx = {
    remote: { $on() { return () => {} } },
    get(name) {
      if (name !== 'connection') return undefined
      return {
        api: {
          llm: {
            async models() {
              modelCalls += 1
              return structuredClone(baseCatalog)
            },
            async providers() {
              providerCalls += 1
              if (providerDirectoryFails) throw new Error('provider directory offline')
              return structuredClone(providerDirectory)
            },
          },
        },
      }
    },
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') this.dispose = disposer
    },
  }
  return {
    exported,
    ctx,
    sandbox,
    changeListeners,
    createdOptions,
    calls: () => ({ modelCalls, providerCalls }),
  }
}

function catalogGroups(body) {
  return body.result.value.groups
}

test('Vision Router uses active llm.providers as the provider directory when llm.models is partial', async () => {
  const harness = createHarness()
  const body = await harness.exported.apply(harness.ctx)
  const groups = catalogGroups(body)

  assert.deepEqual(groups.map((group) => group.id), ['deepseek-official', 'openrouter'])
  const openrouter = groups.find((group) => group.id === 'openrouter')
  assert.equal(openrouter.name, 'OpenRouter')
  assert.equal(openrouter.visionRouterProviderDirectory, true)
  assert.deepEqual(modelIds(openrouter), [MANUAL_MODEL_ID])
  assert.match(openrouter.models[0].name, /手动输入模型 ID|Enter model ID/)
  assert.equal(groups.some((group) => group.id === 'dormant-provider'), false)
  assert.deepEqual(harness.calls(), { modelCalls: 1, providerCalls: 1 })

  if (typeof harness.ctx.dispose === 'function') harness.ctx.dispose()
})

test('provider-directory lookup is fail-soft and never discards a sound llm.models catalog', async () => {
  const harness = createHarness({ providerDirectoryFails: true })
  const body = await harness.exported.apply(harness.ctx)
  const groups = catalogGroups(body)

  assert.deepEqual(groups.map((group) => group.id), ['deepseek-official'])
  assert.deepEqual(harness.calls(), { modelCalls: 1, providerCalls: 1 })

  if (typeof harness.ctx.dispose === 'function') harness.ctx.dispose()
})

test('manual model entry becomes a real catalog id before the controlled selector re-renders', async () => {
  const harness = createHarness({ withDocument: true })
  const first = await harness.exported.apply(harness.ctx)
  const openrouter = catalogGroups(first).find((group) => group.id === 'openrouter')
  assert.deepEqual(modelIds(openrouter), [MANUAL_MODEL_ID])
  assert.equal(harness.changeListeners.length, 1)
  assert.equal(harness.changeListeners[0].capture, true)

  const providerSelect = { value: 'openrouter' }
  const sentinelOption = { value: MANUAL_MODEL_ID }
  const modelSelect = {
    tagName: 'SELECT',
    value: MANUAL_MODEL_ID,
    closest() { return row },
    querySelector(selector) {
      return selector.includes(MANUAL_MODEL_ID) ? sentinelOption : undefined
    },
    insertBefore(option, before) {
      assert.equal(before, sentinelOption)
      this.inserted = option
    },
  }
  const row = { querySelectorAll() { return [providerSelect, modelSelect] } }
  const event = {
    target: modelSelect,
    preventDefault() { this.prevented = true },
    stopImmediatePropagation() { this.stopped = true },
  }

  harness.changeListeners[0].listener(event)
  assert.equal(modelSelect.value, 'vendor/new-vision-model')
  assert.equal(modelSelect.inserted.value, 'vendor/new-vision-model')
  assert.equal(harness.createdOptions.length, 1)

  // The entered id is retained in the private Vision Router catalog on the
  // next load; it never alters DSH's global llm.models response.
  const second = await harness.exported.modelCatalog()
  const secondOpenrouter = catalogGroups(second).find((group) => group.id === 'openrouter')
  assert.deepEqual(modelIds(secondOpenrouter), [
    'vendor/new-vision-model',
    MANUAL_MODEL_ID,
  ])

  if (typeof harness.ctx.dispose === 'function') harness.ctx.dispose()
})

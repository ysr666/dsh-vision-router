import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_OWNERSHIP,
  contextWithNativeImageCoexistence,
  currentSessionVisionPolicy,
  resolveSessionVisionPolicy,
} from '../lib/native-image-coexistence.js'
import { installLegacyCoreVisionPolicyBridge } from '../lib/legacy-core-vision-policy-bridge.js'
import { installStructuredFlowHardening } from '../lib/structured-flow-hardening.js'
import { REMOTE_SETTINGS_READABLE_FIELDS } from '../lib/remote-settings-bridge.js'

function session(provider, model = 'model') {
  return {
    requestHeader() {
      return { config: { provider, model } }
    },
  }
}

function boot() {
  const handlers = new Map()
  const defs = new Map()
  const adapters = new Map()
  const persisted = {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    routing: false,
    autoActivateOnImage: true,
    structuredVisionBootstrap: true,
    visionTurnBudgetMs: 10_000,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
  }
  const scope = {
    get() { return persisted },
    watch() { return () => {} },
  }
  const settings = {
    get(namespace) {
      return namespace === 'vision-router' ? persisted : undefined
    },
    register(namespace) {
      assert.equal(namespace, 'vision-router')
      return scope
    },
  }
  const llm = {
    registerAdapter(routes, adapter) {
      const list = Array.isArray(routes) ? routes : [routes]
      for (const route of list) adapters.set(route, adapter)
      return () => {
        for (const route of list) {
          if (adapters.get(route) === adapter) adapters.delete(route)
        }
      }
    },
    registration(provider) {
      const adapter = adapters.get(provider)
      if (!adapter) throw new Error(`no adapter: ${provider}`)
      return { adapter }
    },
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        inputModalities: provider === 'native-provider' ? ['text', 'image'] : ['text'],
      }
    },
  }
  const ctx = {
    llm,
    tools: {
      register(def) {
        defs.set(def.name, def)
        return () => defs.delete(def.name)
      },
    },
    get(name) {
      return name === 'settings' ? settings : undefined
    },
    inject(_dependencies, callback) {
      return callback({ settings })
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  return { ctx, handlers, defs, persisted }
}

test('Host-native image models make structured bootstrap optional, not tools unavailable', async () => {
  const harness = boot()
  const native = await resolveSessionVisionPolicy(
    harness.ctx,
    session('native-provider'),
    harness.persisted,
  )
  assert.equal(native.ownership, IMAGE_OWNERSHIP.NATIVE)
  assert.equal(native.preserveRawImages, true)
  assert.equal(native.suppressGenericAutoMount, true)
  assert.equal(native.allowStructuredBootstrap, false)

  const text = await resolveSessionVisionPolicy(
    harness.ctx,
    session('text-provider'),
    harness.persisted,
  )
  assert.equal(text.ownership, IMAGE_OWNERSHIP.TEXT_ONLY)
  assert.equal(text.allowStructuredBootstrap, true)
})

test('legacy core sees 1+x disabled only during a native turn while tool access stays enabled', async () => {
  const harness = boot()
  const native = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  const legacy = installLegacyCoreVisionPolicyBridge(native.ctx, native.config)
  let observed

  legacy.ctx.on('agent/pre-step', async (payload, next) => {
    observed = {
      ownership: currentSessionVisionPolicy()?.ownership,
      structuredVisionBootstrap: legacy.config.structuredVisionBootstrap,
      tool: legacy.config.tool,
    }
    return next()
  })

  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  await handler(
    { turn: 1, agent: { session: session('native-provider') }, messages: [] },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.deepEqual(observed, {
    ownership: IMAGE_OWNERSHIP.NATIVE,
    structuredVisionBootstrap: false,
    tool: true,
  })

  await handler(
    { turn: 2, agent: { session: session('text-provider') }, messages: [] },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.deepEqual(observed, {
    ownership: IMAGE_OWNERSHIP.TEXT_ONLY,
    structuredVisionBootstrap: true,
    tool: true,
  })
})

test('a native model may still explicitly call a Vision Router tool', async () => {
  const harness = boot()
  const native = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  const legacy = installLegacyCoreVisionPolicyBridge(native.ctx, native.config)
  const structured = installStructuredFlowHardening(legacy.ctx, legacy.config)
  const nativeSession = session('native-provider')

  structured.tools.register({
    name: 'vision_ocr',
    async execute() {
      return 'native-requested OCR evidence'
    },
  })
  structured.on('agent/pre-step', async (_payload, next) => next())

  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  const decision = await handler(
    { turn: 1, agent: { session: nativeSession }, messages: [] },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.equal(
    decision.messages.some((message) => String(message?.id).includes('structured-')),
    false,
    'native direct turns must not receive a mandatory 1+x guard before choosing a tool',
  )

  const result = await harness.defs.get('vision_ocr').execute(
    {},
    { agent: { session: nativeSession } },
  )
  assert.equal(result, 'native-requested OCR evidence')
})

test('the turn budget is available through the trusted remote settings channel', () => {
  assert.equal(REMOTE_SETTINGS_READABLE_FIELDS.includes('visionTurnBudgetMs'), true)
})

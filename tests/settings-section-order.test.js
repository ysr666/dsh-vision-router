import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { LIVE_MODEL_CLIENT_PRELUDE } from '../lib/live-model-client-prelude.js'

function runPreludeRegistration(existingEntries = [], registration = {
  name: 'settings.section',
  id: 'vision-router',
  order: 12,
}) {
  let loadedSpec
  let registeredOptions
  let registeredDictionaries

  const loader = {
    load(spec) {
      loadedSpec = spec
    },
  }
  const window = { __ModuleLoader__: loader }
  vm.runInNewContext(LIVE_MODEL_CLIENT_PRELUDE, { window })

  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) {
          ctx.locale.register('vision-router', {
            zh: {
              hintVisionDepthMaxCalls: 'old zh',
              hintVisionDepth: 'old zh depth',
              visionDepthStandard: 'old zh standard',
              visionDepthDeep: 'old zh deep',
            },
            en: {
              hintVisionDepthMaxCalls: 'old en',
              hintVisionDepth: 'old en depth',
              visionDepthStandard: 'old en standard',
              visionDepthDeep: 'old en deep',
            },
          })
          return ctx.slots.register(registration, () => {})
        },
      }
    },
  })

  const exported = loadedSpec.factory(() => undefined)
  const ctx = {
    remote: {},
    locale: {
      register(_namespace, dictionaries) {
        registeredDictionaries = dictionaries
      },
    },
    slots: {
      entries(name) {
        assert.equal(name, 'settings.section')
        return existingEntries
      },
      register(options) {
        registeredOptions = options
        return () => {}
      },
    },
    effect() {},
    get() { return undefined },
  }
  exported.apply(ctx)
  return { registeredOptions, registeredDictionaries }
}

test('Vision Router settings section is moved after DSH built-ins into a stable extension band', () => {
  const { registeredOptions } = runPreludeRegistration([
    { options: { id: 'general', order: 0 } },
    { options: { id: 'models', order: 10 } },
    { options: { id: 'plugins', order: 15 } },
    { options: { id: 'agent-presets', order: 20 } },
  ])

  assert.equal(registeredOptions.id, 'vision-router')
  assert.ok(registeredOptions.order >= 1_000_000)
  assert.notEqual(registeredOptions.order, 12)
})

test('Vision Router settings section walks forward when another plugin already owns its preferred order', () => {
  const first = runPreludeRegistration().registeredOptions.order
  const second = runPreludeRegistration([
    { options: { id: 'other-plugin', order: first } },
  ]).registeredOptions.order

  assert.equal(second, first + 1)
})

test('settings order wrapper does not rewrite other plugin section registrations', () => {
  const { registeredOptions } = runPreludeRegistration([], {
    name: 'settings.section',
    id: 'another-plugin',
    order: 12,
  })

  assert.equal(registeredOptions.order, 12)
})

test('client copy keeps standard capped at 2 while custom zero remains unlimited', () => {
  const { registeredDictionaries } = runPreludeRegistration()

  assert.match(registeredDictionaries.zh.hintVisionDepthMaxCalls, /留空或填 0 = 不限制/)
  assert.match(registeredDictionaries.zh.hintVisionDepthMaxCalls, /标准档仍固定最多 2 次/)
  assert.doesNotMatch(registeredDictionaries.zh.hintVisionDepthMaxCalls, /视同标准档/)
  assert.match(registeredDictionaries.en.hintVisionDepthMaxCalls, /blank or 0 = unlimited/i)
  assert.match(registeredDictionaries.en.hintVisionDepthMaxCalls, /Standard remains capped at 2/)
})

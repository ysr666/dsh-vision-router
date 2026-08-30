import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import {
  SETTINGS_FACTORY_LIFECYCLE_PRELUDE,
  injectSettingsFactoryLifecycle,
} from '../lib/settings-factory-lifecycle.js'

function lifecycleHarness({ alpha = true } = {}) {
  let registered
  const pending = []
  const loader = {
    mode: alpha ? 'queue' : 'live',
    load(spec) {
      if (this.mode === 'queue') pending.push(spec)
      else registered = spec
      return spec
    },
  }
  if (alpha) {
    loader.create = function create() {
      this.mode = 'live'
      this.load = (spec) => {
        registered = spec
        return spec
      }
      for (const spec of pending.splice(0)) this.load(spec)
      return this
    }
  }

  const window = {
    __ModuleLoader__: loader,
    location: { hostname: 'localhost' },
  }
  const document = {
    documentElement: { lang: 'zh-CN' },
  }
  const context = {
    window,
    document,
    navigator: { language: 'zh-CN' },
    Object,
    Promise,
    Array,
    String,
    Number,
    Reflect,
    Proxy,
    Symbol,
    Map,
    Set,
    WeakMap,
    Math,
    JSON,
    Error,
    TypeError,
    console,
    setTimeout() { return 1 },
    clearTimeout() {},
  }
  vm.runInNewContext(SETTINGS_FACTORY_LIFECYCLE_PRELUDE, context)
  if (alpha) loader.create()

  return {
    loader,
    register(spec) {
      loader.load(spec)
      return registered
    },
  }
}

function exerciseSettingsFactory(harness) {
  const localeDefinitions = []
  let registeredSection
  const legacy = function LegacySettingsSection() {}
  const spec = {
    id: 'dsh-vision-router',
    factory(require) {
      require('react')
      return {
        apply(ctx) {
          ctx.locale.define('vision-router', {
            zh: { quickStartTitle: '旧标题' },
            en: { quickStartTitle: 'Old title' },
          })
          ctx.slots.register(
            { name: 'settings.section', id: 'vision-router' },
            legacy,
          )
        },
      }
    },
  }
  const registered = harness.register(spec)
  const plugin = registered.factory((id) => {
    if (id === 'react') return {}
    throw new Error(`unexpected value request: ${id}`)
  })
  plugin.apply({
    locale: {
      define(namespace, dictionaries) {
        localeDefinitions.push([namespace, dictionaries])
      },
    },
    slots: {
      register(options, component) {
        registeredSection = { options, component }
        return { options, component }
      },
    },
  })
  return { plugin, localeDefinitions, registeredSection, legacy }
}

test('alpha.1 queue-to-live switch keeps Settings IA and numeric boundary composed', () => {
  const result = exerciseSettingsFactory(lifecycleHarness({ alpha: true }))

  assert.equal(result.localeDefinitions.length, 1)
  assert.equal(result.localeDefinitions[0][0], 'vision-router')
  assert.equal(
    result.localeDefinitions[0][1].zh.quickStartTitle,
    '聊天模型和识图模型分开设置',
  )
  assert.equal(result.registeredSection.options.id, 'vision-router')
  // Limit must remain the outer registration wrapper. If IA installs before
  // Limit, IA replaces this wrapper and the numeric/diagnostic contract is lost.
  assert.equal(result.registeredSection.component.name, 'VisionRouterIssue307SettingsBoundary')
  assert.notEqual(result.registeredSection.component, result.legacy)
  assert.equal(result.plugin.apply.__visionRouterLimitHardening, true)
})

test('pre-alpha live loader keeps the same converged Settings behavior', () => {
  const result = exerciseSettingsFactory(lifecycleHarness({ alpha: false }))

  assert.equal(
    result.localeDefinitions[0][1].zh.quickStartTitle,
    '聊天模型和识图模型分开设置',
  )
  assert.equal(result.registeredSection.component.name, 'VisionRouterIssue307SettingsBoundary')
  assert.equal(result.plugin.apply.__visionRouterLimitHardening, true)
})

test('Settings factory lifecycle ignores unrelated client plugins', () => {
  const harness = lifecycleHarness({ alpha: true })
  const apply = () => {}
  const registered = harness.register({
    id: 'other-plugin',
    factory: () => ({ apply }),
  })
  const plugin = registered.factory(() => ({}))
  assert.equal(plugin.apply, apply)
})

test('HTML convergence emits one lifecycle script, preserves IA style, and is idempotent', () => {
  const html = '<!doctype html><html><head></head><body></body></html>'
  const once = injectSettingsFactoryLifecycle(html)
  const twice = injectSettingsFactoryLifecycle(once)

  assert.equal(twice, once)
  assert.equal((once.match(/<script data-vision-router-settings-factory-lifecycle>/g) || []).length, 1)
  assert.equal((once.match(/<style data-vision-router-settings-ia>/g) || []).length, 1)
  assert.equal((once.match(/<script data-vision-router-settings-ia>/g) || []).length, 0)
  assert.equal((once.match(/<script data-vision-router-settings-limit-hardening>/g) || []).length, 0)
})

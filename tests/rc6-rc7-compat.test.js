import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config as EntryConfig, SETTINGS_CONTRACT_REVISION } from '../entry.js'
import {
  attachmentContextForContract,
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectRc7ProviderOwnership,
} from '../lib/dsh-contract-compat.js'

function runtimeWithAttachments(attachments, llm = {}) {
  return {
    llm,
    get(name) {
      return name === 'attachments' ? attachments : undefined
    },
  }
}

test('contract detection follows the released attachment API, not the pre-rc7 LLM directory', () => {
  // Official rc.6 already shipped registerConfigurableProviders(); using that
  // as a version probe would incorrectly route every rc.6 host through rc.7.
  const rc6 = runtimeWithAttachments(
    { saveImage() {}, readImage() {}, validateImage() {} },
    { registerConfigurableProviders() {} },
  )
  const rc7 = runtimeWithAttachments(
    { saveImage() {}, saveImages() {}, readImage() {}, validateImage() {} },
    { registerConfigurableProviders() {} },
  )
  assert.equal(isRc7ContractRuntime(rc6), false)
  assert.equal(isRc7ContractRuntime(rc7), true)
  assert.equal(isRc7ContractRuntime({ llm: { registerConfigurableProviders() {} } }), false)
})

test('rc7 provider ownership blocks only synthetic official routes', () => {
  const registered = []
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        registered.push({ routes, adapter })
        return () => {}
      },
    },
  }
  const wrapped = protectRc7ProviderOwnership(ctx)
  const adapter = {}
  wrapped.llm.registerAdapter(['vision-http'], adapter)
  assert.deepEqual(registered, [{ routes: ['vision-http'], adapter }])
  assert.throws(
    () => wrapped.llm.registerAdapter(['deepseek-official-native'], {}),
    (error) => error?.code === 'DSH_RC7_PROVIDER_OWNERSHIP',
  )
  assert.throws(
    () => wrapped.llm.registerAdapter(['deepseek-official'], {}),
    (error) => error?.code === 'DSH_RC7_PROVIDER_OWNERSHIP',
  )
})

test('rc7 settings bridge uses the common public SettingsProvider seam and masks legacy stealth', () => {
  let value = { foo: 'user', stealth: true }
  let serviceWatcher
  let observed
  let cleanup
  const scope = {
    get() {
      return value
    },
    watch(callback) {
      serviceWatcher = callback
      return () => {
        serviceWatcher = undefined
      }
    },
  }
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['settings'])
      callback({
        settings: {
          register(namespace, _Config, options) {
            assert.equal(namespace, 'vision-router')
            assert.deepEqual(options.base, { foo: 'base', stealth: true })
            return scope
          },
        },
        effect(factory) {
          cleanup = factory()
        },
      })
    },
  }
  const wrapped = installRc7SettingsCompatibility(ctx, { foo: 'base', stealth: true }, {
    Config: { name: 'fake-schema' },
    namespace: 'vision-router',
  })
  wrapped.inject(['settings'], (sctx) => {
    const compatScope = sctx.settings.register('vision-router')
    assert.deepEqual(compatScope.get(), { foo: 'user', stealth: false })
    compatScope.watch((next) => {
      observed = next
    })
  })
  value = { foo: 'changed', stealth: true }
  serviceWatcher()
  assert.deepEqual(observed, { foo: 'changed', stealth: false })
  cleanup()
  assert.equal(serviceWatcher, undefined)
})

test('rc7 registers the final entry settings contract including remote permission', () => {
  let registeredConfig
  const scope = { get() { return EntryConfig({}) }, watch() { return () => {} } }
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['settings'])
      callback({
        settings: {
          register(namespace, Config) {
            assert.equal(namespace, 'vision-router')
            registeredConfig = Config
            return scope
          },
        },
        effect(factory) { factory() },
      })
    },
  }

  installRc7SettingsCompatibility(ctx, {}, {
    Config: EntryConfig,
    namespace: 'vision-router',
  })

  assert.equal(SETTINGS_CONTRACT_REVISION, 4)
  assert.equal(registeredConfig, EntryConfig)
  assert.equal(registeredConfig({}).allowRemoteSettings, false)
  assert.equal(registeredConfig({ allowRemoteSettings: true }).allowRemoteSettings, true)
  assert.equal(registeredConfig({}).settingsContractRevision, 4)
  assert.equal(registeredConfig({}).visionDepth, 'standard')
  assert.equal(registeredConfig({ visionDepth: 'custom', visionDepthMaxCalls: 7 }).visionDepth, 'custom')
  assert.equal(registeredConfig({ visionDepth: 'custom', visionDepthMaxCalls: 7 }).visionDepthMaxCalls, 7)
})

test('attachment compatibility remains rc6-only and rc7 keeps host-owned refs', () => {
  const rc6 = runtimeWithAttachments({ saveImage() {}, readImage() {}, validateImage() {} })
  const rc7 = runtimeWithAttachments({ saveImage() {}, saveImages() {}, readImage() {}, validateImage() {} })
  let installs = 0
  const installAndroidAttachmentCompat = (ctx) => {
    installs += 1
    return { ...ctx, compat: true }
  }
  const wrappedRc6 = attachmentContextForContract(rc6, undefined, { installAndroidAttachmentCompat })
  const wrappedRc7 = attachmentContextForContract(rc7, undefined, { installAndroidAttachmentCompat })
  assert.equal(wrappedRc6.compat, true)
  assert.equal(wrappedRc7, rc7)
  assert.equal(installs, 1)
})

test('settings card registration is a structural superset of rc6 list and rc7 keyed slots', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const block = source.match(/name: 'settings\.plugin\.item',[\s\S]{0,320}VisionRouterLegacyEntry/)
  assert.ok(block, 'settings.plugin.item registration must exist')
  assert.match(block[0], /key: 'vision-router'/)
  assert.match(block[0], /id: 'vision-router'/)
  // rc.7 only requires key; rc.6 only requires id. The slot runtime ignores
  // the non-applicable extra metadata rather than rejecting it.
})

test('manifest keeps the rc6 host peers and does not add an rc7-only package edge', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines.node, '^22.19.0 || >=24.0.0')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm-deepseek'], '^0.1.0-rc.6')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-anonymous-user-id'], '^0.1.0-rc.6')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-settings'], undefined)
})

test('bundle patch widens attachment limits with fields valid on both rc6 and rc7', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // Long chat-log screenshots (vision_long_screenshot_ocr) and large design
  // files routinely exceed the host defaults (5MB / 40MP). Both rc6 and rc7
  // ship `- id: attachment-local` in dsh-base and accept optional
  // maxImageBytes/maxImagePixels overrides (verified against the released
  // 0.1.0-rc.6 / 0.1.0-rc.7 schemas), so widening them here stays host-neutral.
  assert.match(patch, /^\s*- id:\s*attachment-local/m)
  assert.match(patch, /maxImageBytes:\s*20971520/)
  assert.match(patch, /maxImagePixels:\s*100000000/)
})

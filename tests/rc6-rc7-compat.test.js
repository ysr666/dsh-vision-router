import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config as EntryConfig, SETTINGS_CONTRACT_REVISION } from '../entry.js'
import {
  attachmentContextForContract,
  hasBatchAttachmentContract,
  installHostSettingsCompatibility,
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectHostProviderOwnership,
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

test('contract detection follows the released attachment API, not unrelated LLM methods', () => {
  // Official rc.6 already shipped registerConfigurableProviders(); using that
  // as a version probe would incorrectly route every rc.6 host through the
  // batch-attachment contract. saveImages() is the released observable seam.
  const single = runtimeWithAttachments(
    { saveImage() {}, readImage() {}, validateImage() {} },
    { registerConfigurableProviders() {} },
  )
  const batch = runtimeWithAttachments(
    { saveImage() {}, saveImages() {}, readImage() {}, validateImage() {} },
    { registerConfigurableProviders() {} },
  )
  assert.equal(hasBatchAttachmentContract(single), false)
  assert.equal(hasBatchAttachmentContract(batch), true)
  assert.equal(hasBatchAttachmentContract({ llm: { registerConfigurableProviders() {} } }), false)
  // Transitional rc.7-era alias must remain behaviorally identical for callers
  // while runtime code migrates to the capability-named export.
  assert.equal(isRc7ContractRuntime, hasBatchAttachmentContract)
})

test('host provider ownership blocks only synthetic official routes', () => {
  const registered = []
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        registered.push({ routes, adapter })
        return () => {}
      },
    },
  }
  const wrapped = protectHostProviderOwnership(ctx)
  const adapter = {}
  wrapped.llm.registerAdapter(['vision-http'], adapter)
  assert.deepEqual(registered, [{ routes: ['vision-http'], adapter }])
  assert.throws(
    () => wrapped.llm.registerAdapter(['deepseek-official-native'], {}),
    (error) => error?.code === 'DSH_HOST_PROVIDER_OWNERSHIP',
  )
  assert.throws(
    () => wrapped.llm.registerAdapter(['deepseek-official'], {}),
    (error) => error?.code === 'DSH_HOST_PROVIDER_OWNERSHIP',
  )
  assert.equal(protectRc7ProviderOwnership, protectHostProviderOwnership)
})

test('host settings bridge uses the common public SettingsProvider seam and masks legacy stealth', () => {
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
  const wrapped = installHostSettingsCompatibility(ctx, { foo: 'base', stealth: true }, {
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
  assert.equal(installRc7SettingsCompatibility, installHostSettingsCompatibility)
})

test('host settings bridge registers the final entry settings contract including remote permission', () => {
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

  installHostSettingsCompatibility(ctx, {}, {
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

test('attachment compatibility follows the batch-attachment seam', () => {
  const single = runtimeWithAttachments({ saveImage() {}, readImage() {}, validateImage() {} })
  const batch = runtimeWithAttachments({ saveImage() {}, saveImages() {}, readImage() {}, validateImage() {} })
  let installs = 0
  const installAndroidAttachmentCompat = (ctx) => {
    installs += 1
    return { ...ctx, compat: true }
  }
  const wrappedSingle = attachmentContextForContract(single, undefined, { installAndroidAttachmentCompat })
  const wrappedBatch = attachmentContextForContract(batch, undefined, { installAndroidAttachmentCompat })
  assert.equal(wrappedSingle.compat, true)
  assert.equal(wrappedBatch, batch)
  assert.equal(installs, 1)
})

test('settings card registration is a structural superset of rc6 list and newer keyed slots', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const block = source.match(/name: 'settings\.plugin\.item',[\s\S]{0,320}VisionRouterLegacyEntry/)
  assert.ok(block, 'settings.plugin.item registration must exist')
  assert.match(block[0], /key: 'vision-router'/)
  assert.match(block[0], /id: 'vision-router'/)
  // rc.7+ requires key; rc.6 requires id. The slot runtime ignores the
  // non-applicable extra metadata rather than rejecting it.
})

test('manifest keeps the minimum rc6 host peers and adds no newer-only package edge', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines.node, '^22.19.0 || >=24.0.0')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm-deepseek'], '^0.1.0-rc.6')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-anonymous-user-id'], '^0.1.0-rc.6')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-settings'], undefined)
})

test('bundle patch defines Vision Router attachment storage admission including rc8 dimensions', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /^\s*- id:\s*attachment-local/m)
  assert.match(patch, /maxImageBytes:\s*20971520/)
  assert.match(patch, /maxImagePixels:\s*100000000/)
  assert.match(patch, /maxImageDimension:\s*10000/)
  // Dimension is intentionally bounded rather than disabled: attachment-local
  // is Host-global and also feeds native multimodal providers outside Vision
  // Router's request-normalization boundary.
  assert.doesNotMatch(patch, /maxImageDimension:\s*(?:32768|65535|99999)/)
})

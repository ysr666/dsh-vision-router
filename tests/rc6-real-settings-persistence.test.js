import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Config } from '../entry.js'
import { mutateLocalRemoteSettingsPermission } from '../lib/local-remote-settings-permission.js'

function realRc6SettingsRoot() {
  const store = path.resolve('node_modules/.pnpm')
  const candidates = readdirSync(store)
    .filter((name) => name.startsWith('@deepseek-ai+dsh-settings@0.1.0-rc.6'))
    .sort()
  assert.ok(candidates.length > 0, 'the locked real @deepseek-ai/dsh-settings@0.1.0-rc.6 package must be installed')
  return path.join(store, candidates[0], 'node_modules', '@deepseek-ai', 'dsh-settings')
}

test('real rc6 SettingsProvider persists allowRemoteSettings in the raw user section', async () => {
  const settingsRoot = realRc6SettingsRoot()
  const settingsModule = await import(pathToFileURL(path.join(settingsRoot, 'lib/index.js')).href)
  const peerRequire = createRequire(path.join(settingsRoot, 'package.json'))
  const cordisEntry = peerRequire.resolve('@deepseek-ai/cordis')
  const { Context } = await import(pathToFileURL(cordisEntry).href)

  class MemorySettings extends settingsModule.SettingsProvider {
    constructor(ctx) {
      super(ctx)
      this.doc = {}
    }
    get writable() { return true }
    load() { return Promise.resolve(structuredClone(this.doc)) }
    persist(ns, section) {
      this.doc[ns] = structuredClone(section)
      return Promise.resolve()
    }
  }

  const ctx = new Context()
  const fiber = ctx.plugin(MemorySettings)
  await fiber
  const provider = ctx.get('settings')
  provider.register(settingsModule.settingsNamespace('vision-router'), Config)

  const before = provider.describe({ redactSecrets: true }).find((entry) => entry.ns === 'vision-router')
  assert.ok(before)
  assert.equal(before.user, undefined)
  assert.equal(before.value.allowRemoteSettings, false)

  const result = await mutateLocalRemoteSettingsPermission(provider, {
    operation: 'set',
    value: true,
    expectedRevision: before.revision,
  })
  assert.equal(result.ok, true)

  const after = provider.describe({ redactSecrets: true }).find((entry) => entry.ns === 'vision-router')
  assert.ok(after)
  assert.equal(after.user.allowRemoteSettings, true)
  assert.equal(after.value.allowRemoteSettings, true)
  assert.equal(provider.doc['vision-router'].allowRemoteSettings, true)
  assert.ok(after.revision > before.revision)

  await fiber.dispose()
})

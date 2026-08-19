import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import {
  CLIENT_PRESENTATION_PRELUDE,
  injectClientPresentationBoundary,
} from '../lib/client-presentation-boundary.js'

const LEGACY_ATTACHMENT_VALUE = '@deepseek-ai/dsh-client-ui-attachment'

test('presentation prelude owns the legacy ImageGallery value without requiring DSH ui-attachment', () => {
  let registered
  const loader = {
    load(spec) {
      registered = spec
      return spec
    },
  }
  const window = { __ModuleLoader__: loader }
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, { window, Object, Promise, Array, String })

  const requested = []
  const React = {
    createElement() {},
    useState() { return [undefined, () => {}] },
    useEffect() {},
    Fragment: Symbol('Fragment'),
  }
  loader.load({
    id: 'dsh-vision-router',
    factory(require) {
      const presentation = require(LEGACY_ATTACHMENT_VALUE)
      return {
        ImageGallery: presentation.ImageGallery,
        empty: presentation.ImageGallery({ images: [] }),
      }
    },
  })

  assert.equal(typeof registered.factory, 'function')
  const exports = registered.factory((id) => {
    requested.push(id)
    if (id === 'react') return React
    throw new Error(`unexpected host value request: ${id}`)
  })
  assert.equal(typeof exports.ImageGallery, 'function')
  assert.equal(exports.empty, null)
  assert.deepEqual(requested, ['react'])
  assert.ok(!requested.includes(LEGACY_ATTACHMENT_VALUE))
})

test('presentation prelude composes with an already wrapped loader and injects once', () => {
  const originalCalls = []
  const loader = {
    load(spec) {
      originalCalls.push(spec.id)
      return spec
    },
  }
  const window = { __ModuleLoader__: loader }
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, { window, Object, Promise, Array, String })
  const first = loader.load
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, { window, Object, Promise, Array, String })
  assert.equal(loader.load, first)

  loader.load({ id: 'other-plugin', factory() { return {} } })
  assert.deepEqual(originalCalls, ['other-plugin'])

  const once = injectClientPresentationBoundary('<html><head></head><body></body></html>')
  const twice = injectClientPresentationBoundary(once)
  assert.equal(once, twice)
  assert.match(once, /data-vision-router-presentation-boundary/)
})

test('manifest does not declare DSH ui-attachment as a client value dependency', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies?.[LEGACY_ATTACHMENT_VALUE], undefined)
  assert.equal(pkg.peerDependencies?.[LEGACY_ATTACHMENT_VALUE], undefined)
  assert.equal(pkg.devDependencies?.[LEGACY_ATTACHMENT_VALUE], undefined)
  assert.ok(!Array.isArray(pkg.dsh?.client?.inject) || !pkg.dsh.client.inject.includes(LEGACY_ATTACHMENT_VALUE))
  assert.ok(!Array.isArray(pkg.dsh?.client?.external) || !pkg.dsh.client.external.includes(LEGACY_ATTACHMENT_VALUE))
})

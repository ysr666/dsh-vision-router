import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import {
  CLIENT_PRESENTATION_PRELUDE,
  injectClientPresentationBoundary,
} from '../lib/client-presentation-boundary.js'
import {
  LIVE_MODEL_CLIENT_PRELUDE,
  injectLiveModelClientPrelude,
} from '../lib/live-model-client-prelude.js'

const LEGACY_ATTACHMENT_VALUE = '@deepseek-ai/dsh-client-ui-attachment'

function fakeReact() {
  return {
    createElement() {},
    useState() { return [undefined, () => {}] },
    useEffect() {},
    Fragment: Symbol('Fragment'),
  }
}

function materializePresentation(order) {
  let registered
  const loader = {
    load(spec) {
      registered = spec
      return spec
    },
  }
  const window = { __ModuleLoader__: loader }
  const context = {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Math,
    setTimeout() { return 1 },
    clearTimeout() {},
  }
  for (const source of order) vm.runInNewContext(source, context)

  const requested = []
  const React = fakeReact()
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
  return { exports, requested }
}

test('presentation prelude owns the legacy ImageGallery value without requiring DSH ui-attachment', () => {
  const { exports, requested } = materializePresentation([CLIENT_PRESENTATION_PRELUDE])
  assert.equal(typeof exports.ImageGallery, 'function')
  assert.equal(exports.empty, null)
  assert.deepEqual(requested, ['react'])
  assert.ok(!requested.includes(LEGACY_ATTACHMENT_VALUE))
})

test('presentation and live-model preludes compose in either installation order', () => {
  for (const order of [
    [CLIENT_PRESENTATION_PRELUDE, LIVE_MODEL_CLIENT_PRELUDE],
    [LIVE_MODEL_CLIENT_PRELUDE, CLIENT_PRESENTATION_PRELUDE],
  ]) {
    const { exports, requested } = materializePresentation(order)
    assert.equal(typeof exports.ImageGallery, 'function')
    assert.equal(exports.empty, null)
    assert.ok(!requested.includes(LEGACY_ATTACHMENT_VALUE))
  }
})

test('index transforms run after the DSH module-loader bootstrap and before shell startup', () => {
  // This is the ordering produced by rc.8 client-modules before out-of-tree
  // bundle taps run. Both Vision Router preludes must come AFTER this script;
  // otherwise DSH assigns a new window.__ModuleLoader__ and erases our wrappers.
  const dshBootstrapped = [
    '<!doctype html><html><head>',
    '<script data-dsh-module-bootstrap>window.__ModuleLoader__={load(){}}</script>',
    '</head><body><script type="module" src="/assets/app.js"></script></body></html>',
  ].join('')

  for (const [inject, marker] of [
    [injectLiveModelClientPrelude, 'data-vision-router-live-models'],
    [injectClientPresentationBoundary, 'data-vision-router-presentation-boundary'],
  ]) {
    const output = inject(dshBootstrapped)
    const bootstrapAt = output.indexOf('data-dsh-module-bootstrap')
    const preludeAt = output.indexOf(marker)
    const closeHeadAt = output.indexOf('</head>')
    assert.ok(bootstrapAt !== -1)
    assert.ok(preludeAt > bootstrapAt, `${marker} must run after DSH creates its loader`)
    assert.ok(preludeAt < closeHeadAt, `${marker} must still run before the shell in body`)
  }
})

test('presentation prelude is idempotent, leaves other plugins alone, and injects once', () => {
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

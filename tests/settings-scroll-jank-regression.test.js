import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-boundary.js'

const GUIDE_OPTIONS = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['aria-expanded', 'aria-hidden', 'class'],
}

function bootMutationFence() {
  const instances = []
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      instances.push(this)
    }
    observe(target, options) {
      this.target = target
      this.options = options
    }
    disconnect() {}
    takeRecords() { return [] }
    emit(records) { this.callback(records, this) }
  }
  const body = {}
  const window = {
    document: { body },
    MutationObserver: FakeMutationObserver,
    __ModuleLoader__: { load(spec) { return spec } },
  }
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, {
    window, Object, Promise, Array, String, Proxy, Reflect,
  })
  return { window, body, instances }
}

test('settings scroll class churn cannot invalidate the guide target cache every frame', () => {
  const h = bootMutationFence()
  const seen = []
  const observer = new h.window.MutationObserver(function resolveSync(records) {
    seen.push(records.map((record) => `${record.type}:${record.attributeName || ''}`))
  })
  observer.observe(h.body, GUIDE_OPTIONS)
  const native = h.instances.at(-1)

  for (let index = 0; index < 30; index += 1) {
    native.emit([{ type: 'attributes', attributeName: 'class' }])
  }
  assert.deepEqual(seen, [])

  native.emit([
    { type: 'attributes', attributeName: 'class' },
    { type: 'attributes', attributeName: 'aria-expanded' },
  ])
  native.emit([{ type: 'childList' }])
  assert.deepEqual(seen, [['attributes:aria-expanded'], ['childList:']])
})

test('mutation fence leaves unrelated observers untouched', () => {
  const h = bootMutationFence()
  const seen = []
  const observer = new h.window.MutationObserver(function unrelatedObserver(records) {
    seen.push(records.length)
  })
  observer.observe(h.body, GUIDE_OPTIONS)
  h.instances.at(-1).emit([{ type: 'attributes', attributeName: 'class' }])
  assert.deepEqual(seen, [1])
})

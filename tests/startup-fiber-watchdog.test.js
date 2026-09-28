import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectStartupFiberSnapshot, installStartupFiberWatchdog } from '../lib/startup-fiber-watchdog.js'

function harness({ fibers = [], entries = [] } = {}) {
  let onReady
  let effectDispose
  const warnings = []
  const ready = { onReady(listener) { onReady = listener; return () => { onReady = undefined } } }
  const ctx = {
    registry: { values: () => [{ name: 'fixture-plugin', fibers }] },
    get(name) {
      if (name === 'appReady') return ready
      if (name === 'loader') return { entries: () => entries }
    },
    logger: { warn: (...args) => warnings.push(args) },
    effect(setup) { effectDispose = setup() },
  }
  return { ctx, warnings, ready: () => onReady?.(), dispose: () => effectDispose?.() }
}

test('snapshot reports loading and pending fibers without configs', () => {
  const loading = { uid: 1, state: 1, inject: {}, _store: {}, inertia: Promise.resolve() }
  const pending = { uid: 2, state: 0, inject: { webServer: {}, secretService: {} }, _store: { webServer: {} } }
  const { ctx } = harness({ fibers: [loading, pending], entries: [{ options: { id: 'row', name: 'fixture' }, fiber: pending }] })
  assert.deepEqual(collectStartupFiberSnapshot(ctx), {
    fibers: [
      { plugin: 'fixture-plugin', uid: 1, state: 'LOADING', inject: [], missing: [], injectTruncated: false, inertia: true },
      { plugin: 'fixture-plugin', uid: 2, state: 'PENDING', inject: ['secretService', 'webServer'], missing: ['secretService'], injectTruncated: false, inertia: false },
    ],
    entries: [{ id: 'row', module: 'fixture', fiberUid: 2, state: 'PENDING' }],
    truncated: { fibers: false, entries: false },
  })
})

test('watchdog logs once only when appReady does not commit', async () => {
  const fiber = { uid: 7, state: 1, inject: {}, _store: {}, inertia: Promise.resolve() }
  const stuck = harness({ fibers: [fiber] })
  installStartupFiberWatchdog(stuck.ctx, { delayMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(stuck.warnings.length, 1)
  assert.match(stuck.warnings[0][0], /startup still not ready/)
  assert.match(stuck.warnings[0][2], /fixture-plugin/)

  const healthy = harness({ fibers: [fiber] })
  installStartupFiberWatchdog(healthy.ctx, { delayMs: 10 })
  healthy.ready()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(healthy.warnings.length, 0)
})

test('snapshot bounds adversarial plugin and dependency metadata', () => {
  const rawNames = Array.from({ length: 100 }, (_, index) => `service-${String(index).padStart(3, '0')}-` + 'x'.repeat(200))
  const inject = Object.fromEntries(rawNames.map(name => [name, {}]))
  const fibers = Array.from({ length: 70 }, (_, index) => ({ uid: index + 1, state: 0, inject, _store: index === 0 ? { [rawNames[0]]: {} } : {} }))
  const entries = Array.from({ length: 70 }, (_, index) => ({ options: { id: `row-${index}-` + 'y'.repeat(300), name: `module-${index}-` + 'z'.repeat(300) }, fiber: fibers[index] }))
  const { ctx } = harness({ fibers, entries })
  const snapshot = collectStartupFiberSnapshot(ctx)
  assert.equal(snapshot.fibers.length, 64)
  assert.equal(snapshot.entries.length, 64)
  assert.deepEqual(snapshot.truncated, { fibers: true, entries: true })
  assert.equal(snapshot.fibers[0].inject.length, 64)
  assert.equal(snapshot.fibers[0].injectTruncated, true)
  assert.ok(snapshot.fibers[0].inject.every(name => name.length <= 161))
  assert.equal(snapshot.fibers[0].missing.includes(snapshot.fibers[0].inject[0]), false)
  assert.ok(snapshot.entries.every(entry => entry.id.length <= 161 && entry.module.length <= 161))
})

test('watchdog is inert when the Host has no appReady contract', async () => {
  const warnings = []
  const ctx = { get() {}, logger: { warn: (...args) => warnings.push(args) } }
  installStartupFiberWatchdog(ctx, { delayMs: 5 })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(warnings, [])
})

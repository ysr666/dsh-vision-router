import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { installDesktopVisionToggleAudit } from '../scripts/dsh-desktop-toggle-stability.mjs'

function harness() {
  let ms = 0
  let button = makeButton()
  let deliver
  const globals = {
    window: {},
    document: {
      body: {},
      querySelector: () => button,
    },
    performance: { now: () => ms },
    MutationObserver: class {
      constructor(callback) { deliver = callback }
      observe() {}
    },
  }
  vm.runInNewContext('(' + installDesktopVisionToggleAudit.toString() + ')()', globals)
  const audit = globals.window.__dvrDesktopToggleAudit
  return {
    audit,
    tick(value) { ms = value },
    mutate(patch) {
      Object.assign(button, patch)
      deliver([{ type: 'attributes', target: button, attributeName: 'aria-busy' }])
    },
    replace() {
      button = makeButton()
      deliver([{ type: 'childList', addedNodes: [button], removedNodes: [] }])
    },
    missing() {
      button = null
      deliver([{ type: 'childList', addedNodes: [], removedNodes: [] }])
    },
  }
}

function makeButton() {
  return {
    pressed: 'false',
    busy: 'false',
    disabled: false,
    getAttribute(key) {
      if (key === 'aria-pressed') return this.pressed
      if (key === 'aria-busy') return this.busy
      return null
    },
    matches: (selector) => selector === '[data-vision-router-mode-toggle="true"]',
    querySelector: () => null,
  }
}

test('issue #684 requires an uninterrupted 300ms ready interval, not two matching samples', () => {
  const { audit, tick, mutate } = harness()
  assert.equal(audit.stableFor('false', 300), false)
  tick(299)
  assert.equal(audit.stableFor('false', 300), false)
  tick(300)
  assert.equal(audit.stableFor('false', 300), true)

  // Old gate would see ready at t=300 and t=600, missing this busy pulse.
  tick(350)
  mutate({ busy: 'true' })
  tick(351)
  mutate({ busy: 'false' })
  tick(600)
  assert.equal(audit.stableFor('false', 300), false)
  tick(899)
  assert.equal(audit.stableFor('false', 300), false)
  tick(900)
  assert.equal(audit.stableFor('false', 300), true)
  assert.ok(audit.stabilitySummary().observedMutations >= 2)
})

test('issue #684 restarts the ready window on button replacement and target reversal', () => {
  const { audit, tick, replace, mutate } = harness()
  assert.equal(audit.stableFor('false', 300), false)
  tick(300)
  assert.equal(audit.stableFor('false', 300), true)
  tick(320)
  replace()
  assert.equal(audit.stableFor('false', 300), false)
  tick(620)
  assert.equal(audit.stableFor('false', 300), true)

  tick(621)
  assert.equal(audit.stableFor('true', 300), false)
  mutate({ pressed: 'true' })
  tick(921)
  assert.equal(audit.stableFor('true', 300), false)
  tick(1221)
  assert.equal(audit.stableFor('true', 300), true)
})

test('issue #684 refuses absent or disabled buttons, keeping history bounded', () => {
  const { audit, tick, mutate, missing } = harness()
  for (let i = 0; i < 70; i++) {
    tick(i)
    mutate({ disabled: i % 2 === 0 })
  }
  assert.ok(audit.history.length <= 48)
  assert.equal(audit.stableFor('false', 300), false)
  tick(500)
  missing()
  assert.equal(audit.stableFor('false', 300), false)
})

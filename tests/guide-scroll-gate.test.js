import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const GUIDE_STORAGE_KEY = 'dsh-vision-router:guide:vision-backend-v2'

function loadClientBundle() {
  let spec = null
  globalThis.window = { __ModuleLoader__: { load(s) { spec = s } } }
  const url = new URL('../lib/client.js', import.meta.url)
  // eslint-disable-next-line no-eval
  ;(0, eval)(readFileSync(url, 'utf8'))
  const ReactStub = {
    useState: (initial) => [initial, () => {}],
    useMemo: (fn) => fn(),
    useSyncExternalStore: () => ({ status: 'ready', writable: true, value: {}, user: {} }),
  }
  return spec.factory((name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-ui-attachment') {
      return { ImageGallery: () => null }
    }
    throw new Error('require(' + name + ')')
  })
}

function makeFakeElement(tag = 'div') {
  return {
    tag,
    type: '',
    className: '',
    dataset: {},
    textContent: '',
    offsetWidth: 360,
    offsetHeight: 160,
    children: [],
    style: {
      removeProperty() {},
      setProperty() {},
      remove() {},
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    setAttribute() {},
    addEventListener() {},
    removeAttribute() {},
    append(...children) { this.children.push(...children) },
    remove() {},
    querySelector(selector) {
      const match = selector.match(/^\.([\w-]+)$/)
      if (match) return this.children.find((child) => child.className.split(/\s+/).includes(match[1])) ?? null
      if (selector === 'nav') return null
      return null
    },
    getBoundingClientRect() {
      return { x: 100, y: 100, width: 120, height: 40, left: 100, right: 220, top: 100, bottom: 140 }
    },
    getAttribute() { return null },
    isConnected: true,
  }
}

function makeGuideHarness({ guideStep } = {}) {
  const counters = { domQueries: 0, rectReads: 0, scrollEvents: 0, frames: 0 }
  const listeners = {}
  const frames = []
  const timers = []
  let intervalCounter = 0
  let timeoutCounter = 0

  const panel = {
    ...makeFakeElement('div'),
    closest: () => null,
    getBoundingClientRect() {
      counters.rectReads += 1
      return { x: 0, y: 0, width: 800, height: 600, left: 0, right: 800, top: 0, bottom: 600 }
    },
  }
  const gear = {
    ...makeFakeElement('button'),
    closest: () => null,
    getBoundingClientRect() {
      counters.rectReads += 1
      return { x: 10, y: 10, width: 40, height: 40, left: 10, right: 50, top: 10, bottom: 50 }
    },
  }
  const composerTarget = {
    ...makeFakeElement('button'),
    closest: () => null,
    getBoundingClientRect() {
      counters.rectReads += 1
      return { x: 100, y: 100, width: 120, height: 40, left: 100, right: 220, top: 100, bottom: 140 }
    },
  }

  const documentStub = {
    body: { appendChild() {} },
    addEventListener(type, callback) { listeners[type] = callback },
    removeEventListener(type) { delete listeners[type] },
    dispatchEvent() {},
    querySelectorAll(selector) {
      counters.domQueries += 1
      if (selector === '[role="dialog"][aria-modal="true"]') return [panel]
      if (selector === 'button[aria-haspopup="dialog"]') return [gear]
      if (selector.includes('[data-slot="conversation.input.model"]')) return [composerTarget]
      return []
    },
    querySelector(selector) {
      counters.domQueries += 1
      return null
    },
    createElement(tag) { return makeFakeElement(tag) },
  }

  const windowStub = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (key) => (key === GUIDE_STORAGE_KEY ? guideStep ?? null : null),
      setItem() {},
      removeItem() {},
    },
    addEventListener(type, callback) { listeners['window:' + type] = callback },
    removeEventListener() {},
    dispatchEvent() {},
    requestAnimationFrame(callback) {
      frames.push(callback)
      return frames.length
    },
    setTimeout(callback, delay) {
      const id = ++timeoutCounter
      timers.push({ id, kind: 'timeout', callback, delay })
      return id
    },
    clearTimeout() {},
    setInterval(callback, delay) {
      const id = ++intervalCounter
      timers.push({ id, kind: 'interval', callback, delay })
      return id
    },
    clearInterval() {},
  }

  return {
    counters,
    get document() { return documentStub },
    get window() { return windowStub },
    runScrollEvent() {
      counters.scrollEvents += 1
      listeners['scroll'] && listeners['scroll']()
    },
    runFrame() {
      counters.frames += 1
      const pending = frames.splice(0)
      for (const callback of pending) callback()
    },
    runIntervals() {
      for (const timer of timers) {
        if (timer.kind === 'interval') timer.callback()
      }
    },
    disposeListeners() {
      delete listeners['scroll']
    },
  }
}

function bootBundle(harness, guideStep) {
  const realNow = Date.now
  let fakeNow = 0
  Date.now = () => fakeNow
  // Load the bundle first: the eval only needs window.__ModuleLoader__.
  // Afterwards the bundle code reads the real test window/document globals.
  const bundle = loadClientBundle()
  globalThis.document = harness.document
  globalThis.window = harness.window
  const dispose = bundle.installVisionSettingsGuide((key) => key)
  return {
    bundle,
    dispose,
    setNow(value) { fakeNow = value },
    restore() {
      Date.now = realNow
    },
  }
}

test('active walkthrough scroll frames never re-run DOM queries (only re-anchor)', () => {
  const harness = makeGuideHarness({ guideStep: 'step2' })
  const session = bootBundle(harness, 'step2')
  try {
    // Install-time sync resolves once (panel + target queries). From now on,
    // scroll frames must NOT add a single DOM query: only one target rect
    // read plus style writes per frame.
    const queriesAfterInstall = harness.counters.domQueries
    assert.ok(queriesAfterInstall > 0, 'install-time resolution must query the DOM')
    for (let i = 0; i < 30; i++) {
      harness.runScrollEvent()
      harness.runFrame()
    }
    assert.equal(
      harness.counters.domQueries,
      queriesAfterInstall,
      'scroll frames must not re-run querySelectorAll/querySelector',
    )
    assert.ok(harness.counters.rectReads > 0, 'frames must still re-anchor the target')

    // After the throttle window the resolution refreshes once (fresh DOM
    // query), then stays bounded again.
    const beforeRefresh = harness.counters.domQueries
    session.setNow(400)
    harness.runScrollEvent()
    harness.runFrame()
    const refreshed = harness.counters.domQueries - beforeRefresh
    assert.ok(refreshed >= 1, 'a stale resolution must refresh after the throttle window')
    assert.ok(refreshed <= 6, `refresh must be bounded (got ${refreshed})`)

    for (let i = 0; i < 10; i++) {
      harness.runScrollEvent()
      harness.runFrame()
    }
    assert.ok(
      harness.counters.domQueries <= beforeRefresh + refreshed + 1,
      'frames after the refresh must not keep re-resolving',
    )
  } finally {
    session.restore()
    harness.disposeListeners()
    session.dispose()
  }
})

test('idle (no walkthrough) scroll events perform zero DOM queries', () => {
  const harness = makeGuideHarness({ guideStep: null })
  const session = bootBundle(harness, null)
  try {
    const queriesAfterInstall = harness.counters.domQueries
    assert.equal(queriesAfterInstall, 0, 'idle install must not query the DOM')
    for (let i = 0; i < 30; i++) {
      harness.runScrollEvent()
      harness.runFrame()
    }
    assert.equal(harness.counters.domQueries, 0, 'idle scroll frames must stay DOM-free')
  } finally {
    session.restore()
    harness.disposeListeners()
    session.dispose()
  }
})

test('step1 selector walkthrough keeps per-frame queries bounded', () => {
  const harness = makeGuideHarness({ guideStep: 'step1' })
  const session = bootBundle(harness, 'step1')
  try {
    const queriesAfterInstall = harness.counters.domQueries
    for (let i = 0; i < 30; i++) {
      harness.runScrollEvent()
      harness.runFrame()
    }
    assert.equal(
      harness.counters.domQueries,
      queriesAfterInstall,
      'step1 scroll frames must not re-resolve selector targets per frame',
    )
  } finally {
    session.restore()
    harness.disposeListeners()
    session.dispose()
  }
})

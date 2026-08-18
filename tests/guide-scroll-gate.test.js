import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadClientBundle() {
  let spec = null
  globalThis.window = { __ModuleLoader__: { load(s) { spec = s } } }
  const url = new URL('../lib/client.js', import.meta.url)
  ;(0, eval)(readFileSync(url, 'utf8'))
  const ReactStub = {
    useState: (initial) => [initial, () => {}],
    useMemo: (fn) => fn(),
    useSyncExternalStore: () => ({ status: 'ready', writable: true, value: {}, user: {} }),
  }
  return spec.factory((name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-ui-attachment') return { ImageGallery: () => null }
    throw new Error('require(' + name + ')')
  })
}

function fakeElement() {
  return {
    className: '', dataset: {}, children: [], offsetWidth: 360, offsetHeight: 160, isConnected: true,
    style: { removeProperty() {}, setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, addEventListener() {}, remove() {}, append(...items) { this.children.push(...items) },
    querySelector(selector) {
      const cls = selector.match(/^\.([\w-]+)$/)
      return cls ? this.children.find((child) => String(child.className).split(/\s+/).includes(cls[1])) ?? null : null
    },
    getBoundingClientRect() {
      return { x: 100, y: 100, width: 120, height: 40, left: 100, right: 220, top: 100, bottom: 140 }
    },
    getAttribute() { return null }, closest() { return null },
  }
}

function harness() {
  const counters = { queries: 0, rects: 0 }
  const listeners = new Map()
  const frames = []
  const target = fakeElement()
  target.getBoundingClientRect = () => {
    counters.rects += 1
    return { x: 100, y: 100, width: 120, height: 40, left: 100, right: 220, top: 100, bottom: 140 }
  }
  const gear = fakeElement()
  const panel = fakeElement()
  panel.querySelector = () => null
  const document = {
    body: { appendChild() {} }, documentElement: {}, activeElement: null,
    addEventListener(type, fn) { listeners.set('document:' + type, fn) },
    removeEventListener(type) { listeners.delete('document:' + type) },
    dispatchEvent() {}, createElement() { return fakeElement() },
    querySelectorAll(selector) {
      counters.queries += 1
      if (selector.includes('conversation.input.model')) return [target]
      if (selector === 'button[aria-haspopup="dialog"]') return [gear]
      if (selector === '[role="dialog"][aria-modal="true"]') return [panel]
      return []
    },
    querySelector() { counters.queries += 1; return null },
  }
  const window = {
    innerWidth: 1280, innerHeight: 800,
    addEventListener(type, fn) { listeners.set('window:' + type, fn) },
    removeEventListener(type) { listeners.delete('window:' + type) }, dispatchEvent() {},
    requestAnimationFrame(fn) { frames.push(fn); return frames.length }, cancelAnimationFrame() {},
    setTimeout(fn) { frames.push(fn); return frames.length }, clearTimeout() {},
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
  }
  return { counters, document, window, listeners,
    scroll() { const fn = listeners.get('document:scroll'); if (fn) fn() },
    frame() { const work = frames.splice(0); for (const fn of work) fn() },
  }
}

function boot() {
  const h = harness()
  const bundle = loadClientBundle()
  globalThis.document = h.document
  globalThis.window = h.window
  const dispose = bundle.installVisionSettingsGuide((key) => key)
  return { h, bundle, dispose }
}

test('idle guide runtime installs zero global hot-path listeners and does zero DOM work', () => {
  const { h, dispose } = boot()
  try {
    assert.equal(h.listeners.has('document:scroll'), false)
    assert.equal(h.listeners.has('window:resize'), false)
    assert.equal(h.counters.queries, 0)
    for (let i = 0; i < 20; i++) { h.scroll(); h.frame() }
    assert.equal(h.counters.queries, 0)
  } finally { dispose() }
})

test('active guide installs listeners lazily and keeps scroll-frame resolution bounded', () => {
  const { h, bundle, dispose } = boot()
  const realNow = Date.now
  Date.now = () => 0
  try {
    bundle.startVisionSettingsGuide((key) => key)
    assert.equal(h.listeners.has('document:scroll'), true)
    const afterStart = h.counters.queries
    assert.ok(afterStart > 0)
    for (let i = 0; i < 30; i++) { h.scroll(); h.frame() }
    assert.equal(h.counters.queries, afterStart, 'cached active frames must not re-query DOM')
    assert.ok(h.counters.rects > 0)
  } finally {
    Date.now = realNow
    bundle.finishVisionSettingsGuide()
    dispose()
  }
})

test('ending a guide disposes global listeners so later scrolls stay inert', () => {
  const { h, bundle, dispose } = boot()
  try {
    bundle.startVisionSettingsGuide((key) => key)
    assert.equal(h.listeners.has('document:scroll'), true)
    bundle.finishVisionSettingsGuide()
    assert.equal(h.listeners.has('document:scroll'), false)
    const queries = h.counters.queries
    for (let i = 0; i < 10; i++) { h.scroll(); h.frame() }
    assert.equal(h.counters.queries, queries)
  } finally { dispose() }
})

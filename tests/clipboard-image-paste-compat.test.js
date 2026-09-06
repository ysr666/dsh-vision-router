import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-boundary.js'

class FakeBlob {
  constructor(parts = [], options = {}) {
    this.type = options.type ?? ''
    this._bytes = Uint8Array.from(parts.flatMap((part) => {
      if (part instanceof FakeBlob || part instanceof FakeFile) return [...part._bytes]
      if (part instanceof Uint8Array) return [...part]
      if (part instanceof ArrayBuffer) return [...new Uint8Array(part)]
      return [...new TextEncoder().encode(String(part))]
    }))
    this.size = this._bytes.length
  }
  slice(start = 0, end = this.size) {
    return new FakeBlob([this._bytes.slice(start, end)], { type: this.type })
  }
  async arrayBuffer() {
    return this._bytes.slice().buffer
  }
}

class FakeFile extends FakeBlob {
  constructor(parts, name, options = {}) {
    super(parts, options)
    this.name = name
    this.lastModified = options.lastModified ?? 0
  }
}

class FakeDataTransfer {
  constructor() {
    this._items = []
    this._text = new Map()
    const owner = this
    this.items = {
      add(value, type) {
        if (value instanceof FakeFile) {
          owner._items.push({ kind: 'file', type: value.type, getAsFile: () => value })
          return
        }
        const text = String(value)
        const mediaType = String(type ?? 'text/plain')
        owner._text.set(mediaType, text)
        owner._items.push({ kind: 'string', type: mediaType, getAsFile: () => null })
      },
      [Symbol.iterator]: function* () { yield* owner._items },
    }
  }
  setData(type, value) {
    const mediaType = String(type)
    this._text.set(mediaType, String(value))
    if (!this._items.some(item => item.kind === 'string' && item.type === mediaType)) {
      this._items.push({ kind: 'string', type: mediaType, getAsFile: () => null })
    }
  }
  getData(type) { return this._text.get(String(type)) ?? '' }
  get files() { return this._items.filter(item => item.kind === 'file').map(item => item.getAsFile()) }
  get types() {
    return [
      ...this._text.keys(),
      ...(this.files.length > 0 ? ['Files'] : []),
    ]
  }
}

class FakeClipboardEvent {
  constructor(type, init = {}) {
    this.type = type
    this.clipboardData = init.clipboardData ?? null
    this.bubbles = init.bubbles === true
    this.cancelable = init.cancelable === true
    this.composed = init.composed === true
  }
}

function runtime(options = {}) {
  const listeners = new Map()
  const dispatched = []
  let drawnBitmap = null
  const canvas = {
    width: 0,
    height: 0,
    getContext(type) {
      assert.equal(type, '2d')
      return {
        drawImage(bitmap) { drawnBitmap = bitmap },
        getImageData() {
          const pixels = drawnBitmap?.pixels ?? new Uint8Array([0, 0, 0, 255])
          return { data: Uint8Array.from(pixels) }
        },
      }
    },
    toBlob(callback, type) {
      assert.equal(type, 'image/png')
      callback(new FakeBlob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }))
    },
  }
  const document = {
    body: {},
    addEventListener(type, listener, options) { listeners.set(`${type}:${String(options)}`, listener) },
    removeEventListener(type, listener, options) {
      if (listeners.get(`${type}:${String(options)}`) === listener) listeners.delete(`${type}:${String(options)}`)
    },
    createElement(tag) {
      assert.equal(tag, 'canvas')
      return canvas
    },
  }
  const editable = {
    nodeType: 1,
    closest(selector) {
      if (selector === '[data-composer-input]') return this
      if (selector === '[data-composer-card]') return { contains: node => node === this }
      return null
    },
    dispatchEvent(event) {
      dispatched.push(event)
      return true
    },
  }
  const window = {
    document,
    DataTransfer: options.withoutReplayApis ? undefined : FakeDataTransfer,
    ClipboardEvent: options.withoutReplayApis ? undefined : FakeClipboardEvent,
    File: FakeFile,
    Blob: FakeBlob,
    createImageBitmap: async (file) => {
      if (typeof options.createImageBitmap === 'function') return options.createImageBitmap(file)
      return { width: 2, height: 3, pixels: new Uint8Array([0, 0, 0, 255]), close() {} }
    },
  }
  let registered
  window.__ModuleLoader__ = {
    load(spec) { registered = spec; return spec },
  }
  const context = {
    window, document,
    Object, Promise, Array, String, Map, Set, WeakMap, WeakSet,
    Math, Proxy, Reflect, Symbol, Uint8Array, ArrayBuffer, DataView, TextEncoder,
    setTimeout, clearTimeout, console,
  }
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, context)
  window.__ModuleLoader__.load({
    id: 'dsh-vision-router',
    factory() { return { apply() {} } },
  })
  const plugin = registered.factory((id) => {
    if (id === 'react') return {}
    throw new Error(`unexpected require: ${id}`)
  })
  const disposers = []
  plugin.apply({
    effect(install, label) {
      if (label === 'vision-router: clipboard image paste normalization') {
        const dispose = install()
        if (typeof dispose === 'function') disposers.push(dispose)
      }
    },
  })
  return {
    window, document, editable, dispatched,
    paste: listeners.get('paste:true'),
    dispose() { for (const fn of disposers) fn() },
    listeners,
  }
}

function bmpBytes(width = 2, height = 3) {
  const bytes = new Uint8Array(58)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, 58, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, 4, true)
  bytes[54] = 255
  return bytes
}

function pngBytes(width = 2, height = 1, tail = []) {
  const bytes = new Uint8Array(24 + tail.length)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  bytes.set(tail, 24)
  return bytes
}

function clipboard(files, text = '') {
  const data = new FakeDataTransfer()
  for (const file of files) data.items.add(file)
  if (text !== '') data.setData('text/plain', text)
  return data
}

async function settleUntil(predicate) {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.fail('async paste replay did not settle')
}

function originalPaste(target, data) {
  return {
    target,
    clipboardData: data,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true },
    stopImmediatePropagation() { this.stopped = true },
  }
}

test('BMP clipboard image is converted to PNG and text/plain is preserved for DSH Lexical paste', async () => {
  const rt = runtime()
  assert.equal(typeof rt.paste, 'function')
  const bmp = new FakeFile([bmpBytes()], 'shot.bmp', { type: 'image/bmp', lastModified: 7 })
  const event = originalPaste(rt.editable, clipboard([bmp], 'caption'))
  rt.paste(event)
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  await settleUntil(() => rt.dispatched.length === 1)
  const replay = rt.dispatched[0]
  assert.equal(replay.clipboardData.getData('text/plain'), 'caption')
  assert.equal(replay.clipboardData.files.length, 1)
  assert.equal(replay.clipboardData.files[0].type, 'image/png')
  assert.equal(replay.clipboardData.files[0].name, 'shot.png')
  rt.dispose()
  assert.equal(rt.listeners.has('paste:true'), false)
})

test('QQ/WeChat .png declared as image/png but carrying JPEG bytes is corrected before DSH intake', async () => {
  const rt = runtime()
  let decoded = 0
  rt.window.createImageBitmap = async () => { decoded += 1; throw new Error('canonical JPEG retype must not decode') }
  const mislabeled = new FakeFile([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], 'qq-export.png', {
    type: 'image/png',
    lastModified: 9,
  })
  const event = originalPaste(rt.editable, clipboard([mislabeled], 'caption'))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  const file = rt.dispatched[0].clipboardData.files[0]
  assert.equal(file.type, 'image/jpeg')
  assert.equal(file.name, 'qq-export.jpg')
  assert.equal(file.lastModified, 9)
  assert.equal(rt.dispatched[0].clipboardData.getData('text/plain'), 'caption')
  assert.equal(decoded, 0)
})

test('supported MIME mismatch is reconciled in both directions from magic bytes', async () => {
  const rt = runtime()
  const mislabeled = new FakeFile([pngBytes(2, 1, [7])], 'wechat.jpg', { type: 'image/jpeg' })
  const event = originalPaste(rt.editable, clipboard([mislabeled]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  const file = rt.dispatched[0].clipboardData.files[0]
  assert.equal(file.type, 'image/png')
  assert.equal(file.name, 'wechat.png')
})

test('supported MIME that hides BMP bytes is converted instead of merely retyped', async () => {
  const rt = runtime()
  let decoded = 0
  rt.window.createImageBitmap = async () => {
    decoded += 1
    return { width: 2, height: 3, close() {} }
  }
  const mislabeled = new FakeFile([bmpBytes()], 'clipboard.png', { type: 'image/png' })
  const event = originalPaste(rt.editable, clipboard([mislabeled]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  const file = rt.dispatched[0].clipboardData.files[0]
  assert.equal(file.type, 'image/png')
  assert.equal(file.name, 'clipboard.png')
  assert.equal(decoded, 1)
})

test('image-like filename is reconciled even when the browser declares application/octet-stream', async () => {
  const rt = runtime()
  const mislabeled = new FakeFile([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'qq-cache.png', {
    type: 'application/octet-stream',
  })
  const event = originalPaste(rt.editable, clipboard([mislabeled]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  const file = rt.dispatched[0].clipboardData.files[0]
  assert.equal(file.type, 'image/jpeg')
  assert.equal(file.name, 'qq-cache.jpg')
})

test('empty MIME with PNG bytes is retyped without image decoding', async () => {
  const rt = runtime()
  let decoded = 0
  rt.window.createImageBitmap = async () => { decoded += 1; throw new Error('must not decode canonical PNG') }
  const png = new FakeFile([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], '', { type: '' })
  const event = originalPaste(rt.editable, clipboard([png]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(rt.dispatched[0].clipboardData.files[0].type, 'image/png')
  assert.equal(decoded, 0)
})

test('ordinary supported image is magic-checked but replayed as the original File without decoding or re-encoding', async () => {
  const rt = runtime()
  let decoded = 0
  rt.window.createImageBitmap = async () => { decoded += 1; throw new Error('canonical PNG must not decode') }
  const png = new FakeFile([pngBytes(2, 1, [1])], 'ok.png', { type: 'image/png' })
  const event = originalPaste(rt.editable, clipboard([png]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  assert.equal(rt.dispatched[0].clipboardData.files[0], png)
  assert.equal(decoded, 0)
})

test('non-composer paste and empty-MIME non-image paste fail open', async () => {
  const rt = runtime()
  const badTarget = { nodeType: 1, closest() { return null } }
  const bmp = new FakeFile([new Uint8Array([0x42, 0x4d])], 'shot.bmp', { type: 'image/bmp' })
  const outside = originalPaste(badTarget, clipboard([bmp]))
  rt.paste(outside)
  assert.equal(outside.prevented, false)

  const unknown = new FakeFile([new Uint8Array([1, 2, 3, 4])], 'mystery', { type: '' })
  const event = originalPaste(rt.editable, clipboard([unknown], 'keep me'))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(rt.dispatched[0].clipboardData.files[0].type, '')
  assert.equal(rt.dispatched[0].clipboardData.getData('text/plain'), 'keep me')
})


test('missing synthetic clipboard APIs leave the trusted paste completely untouched', async () => {
  const rt = runtime({ withoutReplayApis: true })
  assert.equal(rt.paste, undefined)
  assert.equal(rt.listeners.has('paste:true'), false)
})

test('BMP decode failure replays the original files and text instead of swallowing the paste', async () => {
  const rt = runtime()
  rt.window.createImageBitmap = async () => { throw new Error('decoder rejected bitmap') }
  const bmp = new FakeFile([bmpBytes()], 'broken.bmp', { type: 'image/bmp' })
  const event = originalPaste(rt.editable, clipboard([bmp], 'still here'))
  rt.paste(event)
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(rt.dispatched[0].clipboardData.files[0], bmp)
  assert.equal(rt.dispatched[0].clipboardData.getData('text/plain'), 'still here')
})


test('oversized BMP dimensions are never decoded before DSH admission', async () => {
  const rt = runtime()
  let decoded = 0
  rt.window.createImageBitmap = async () => { decoded += 1; return { width: 1, height: 1, close() {} } }
  const huge = new FakeFile([bmpBytes(20_000, 1)], 'huge.bmp', { type: 'image/bmp' })
  const event = originalPaste(rt.editable, clipboard([huge]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(decoded, 0)
  assert.equal(rt.dispatched[0].clipboardData.files[0], huge)
})

test('same-byte supported images with different names are deduped within one paste batch', async () => {
  const rt = runtime()
  let decoded = 0
  rt.window.createImageBitmap = async () => { decoded += 1; throw new Error('exact duplicate must not decode') }
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const first = new FakeFile([bytes], 'a.png', { type: 'image/png' })
  const second = new FakeFile([bytes], 'b.png', { type: 'image/png' })
  const event = originalPaste(rt.editable, clipboard([first, second], 'caption'))
  rt.paste(event)
  assert.equal(event.prevented, true)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(rt.dispatched[0].clipboardData.files.length, 1)
  assert.equal(rt.dispatched[0].clipboardData.files[0].name, 'a.png')
  assert.equal(rt.dispatched[0].clipboardData.getData('text/plain'), 'caption')
  assert.equal(decoded, 0)
})

test('same-name supported images with different bytes are never deduped', async () => {
  const rt = runtime()
  const first = new FakeFile([new Uint8Array([1, 2, 3, 4])], 'same.png', { type: 'image/png' })
  const second = new FakeFile([new Uint8Array([4, 3, 2, 1])], 'same.png', { type: 'image/png' })
  const event = originalPaste(rt.editable, clipboard([first, second]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(rt.dispatched[0].clipboardData.files.length, 2)
  assert.equal(rt.dispatched[0].clipboardData.files[0], first)
  assert.equal(rt.dispatched[0].clipboardData.files[1], second)
})

test('synthetic bitmap-style PNG and named FileDrop PNG dedupe by identical pixels without re-encoding', async () => {
  let decoded = 0
  const rt = runtime({
    createImageBitmap: async (file) => {
      decoded += 1
      return {
        width: 2,
        height: 1,
        pixels: file.name === 'image.png'
          ? new Uint8Array([9, 8, 7, 255, 1, 2, 3, 255])
          : new Uint8Array([9, 8, 7, 255, 1, 2, 3, 255]),
        close() {},
      }
    },
  })
  const bitmapView = new FakeFile([pngBytes(2, 1, [1])], 'image.png', { type: 'image/png' })
  const fileDrop = new FakeFile([pngBytes(2, 1, [2, 2, 2])], 'QQ-shot.png', { type: 'image/png' })
  const event = originalPaste(rt.editable, clipboard([bitmapView, fileDrop], 'keep'))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  const files = rt.dispatched[0].clipboardData.files
  assert.equal(files.length, 1)
  assert.equal(files[0], fileDrop)
  assert.equal(rt.dispatched[0].clipboardData.getData('text/plain'), 'keep')
  assert.equal(decoded, 2)
})

test('synthetic and named images with different pixels remain distinct', async () => {
  const rt = runtime({
    createImageBitmap: async (file) => ({
      width: 1,
      height: 1,
      pixels: file.name === 'image.png'
        ? new Uint8Array([1, 2, 3, 255])
        : new Uint8Array([4, 5, 6, 255]),
      close() {},
    }),
  })
  const first = new FakeFile([pngBytes(1, 1, [1])], 'image.png', { type: 'image/png' })
  const second = new FakeFile([pngBytes(1, 1, [2, 2, 2])], 'real.png', { type: 'image/png' })
  const event = originalPaste(rt.editable, clipboard([first, second]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(rt.dispatched[0].clipboardData.files.length, 2)
})

test('ordinary multi-image paste is inspected once but preserves distinct canonical File objects', async () => {
  const rt = runtime()
  const first = new FakeFile([pngBytes(1, 1, [1])], 'first.png', { type: 'image/png' })
  const second = new FakeFile([pngBytes(1, 1, [2, 2])], 'second.png', { type: 'image/png' })
  const event = originalPaste(rt.editable, clipboard([first, second]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  const files = rt.dispatched[0].clipboardData.files
  assert.equal(files.length, 2)
  assert.equal(files[0], first)
  assert.equal(files[1], second)
})

test('oversized suspicious duplicate candidates fail open without pixel decoding', async () => {
  let decoded = 0
  const rt = runtime({ createImageBitmap: async () => { decoded += 1; throw new Error('must not decode') } })
  const first = new FakeFile([pngBytes(2, 1, [1])], 'image.png', { type: 'image/png' })
  const second = new FakeFile([pngBytes(2, 1, [2])], 'real.png', { type: 'image/png' })
  Object.defineProperty(first, 'size', { value: 17 * 1024 * 1024 })
  Object.defineProperty(second, 'size', { value: 17 * 1024 * 1024 })
  const event = originalPaste(rt.editable, clipboard([first, second]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(rt.dispatched[0].clipboardData.files.length, 2)
  assert.equal(decoded, 0)
})

test('oversized PNG dimensions are rejected before visual duplicate decoding', async () => {
  let decoded = 0
  const rt = runtime({ createImageBitmap: async () => { decoded += 1; throw new Error('must not decode oversized PNG') } })
  const first = new FakeFile([pngBytes(5000, 2000, [1])], 'image.png', { type: 'image/png' })
  const second = new FakeFile([pngBytes(5000, 2000, [2, 2])], 'real.png', { type: 'image/png' })
  const event = originalPaste(rt.editable, clipboard([first, second]))
  rt.paste(event)
  await settleUntil(() => rt.dispatched.length === 1)
  assert.equal(rt.dispatched[0].clipboardData.files.length, 2)
  assert.equal(decoded, 0)
})

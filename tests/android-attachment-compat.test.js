import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createTransientAttachmentCache,
  installAndroidAttachmentCompat,
  isAndroidTermuxRuntime,
  isPermissionBoundaryError,
} from '../lib/android-attachment-compat.js'

function permissionFailure(code = 'EACCES') {
  const cause = new Error('permission denied')
  cause.code = code
  const error = new Error('Unable to persist image attachment.')
  error.code = 'ATTACHMENT_WRITE_FAILED'
  error.cause = cause
  return error
}

test('detects Android and Termux runtimes without affecting normal Linux', () => {
  assert.equal(isAndroidTermuxRuntime({ platform: 'android', env: {} }), true)
  assert.equal(isAndroidTermuxRuntime({ platform: 'linux', env: { TERMUX_VERSION: '0.119' } }), true)
  assert.equal(
    isAndroidTermuxRuntime({ platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } }),
    true,
  )
  assert.equal(isAndroidTermuxRuntime({ platform: 'linux', env: { PREFIX: '/usr' } }), false)
})

test('recognizes nested EACCES and EPERM causes only', () => {
  assert.equal(isPermissionBoundaryError(permissionFailure('EACCES')), true)
  assert.equal(isPermissionBoundaryError(permissionFailure('EPERM')), true)
  const other = new Error('disk full')
  other.code = 'ENOSPC'
  assert.equal(isPermissionBoundaryError(other), false)
})

test('non-Android runtime returns the original context unchanged', () => {
  const ctx = { get() { return undefined } }
  const wrapped = installAndroidAttachmentCompat(ctx, undefined, {
    runtime: { platform: 'linux', env: { PREFIX: '/usr' } },
  })
  assert.equal(wrapped, ctx)
})

test('byte-weighted transient cache evicts oldest entries before memory can grow unbounded', () => {
  const cache = createTransientAttachmentCache({ maxEntries: 64, maxBytes: 5 })
  const a = {
    ref: { attachmentId: 'a' },
    data: new Uint8Array([1, 2, 3, 4]),
  }
  const b = {
    ref: { attachmentId: 'b' },
    data: new Uint8Array([5, 6, 7, 8]),
  }
  assert.equal(cache.set(a), true)
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 4, maxEntries: 64, maxBytes: 5 })
  assert.equal(cache.set(b), true)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), b)
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 4, maxEntries: 64, maxBytes: 5 })
})

test('Android permission failure falls back to a process-local content-addressed image', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  let delegatedReads = 0
  let warnings = 0
  const attachments = {
    async saveImage() {
      throw permissionFailure('EACCES')
    },
    async readImage() {
      delegatedReads += 1
      throw new Error('host read should not be used for transient refs')
    },
  }
  const ctx = {
    get(name) {
      return name === 'attachments' ? attachments : undefined
    },
  }
  const wrapped = installAndroidAttachmentCompat(
    ctx,
    { warn() { warnings += 1 } },
    {
      runtime: { platform: 'android', env: {} },
      probeImage: async () => ({ width: 20, height: 10 }),
    },
  )
  const service = wrapped.get('attachments')
  const ref = await service.saveImage({ data: bytes, mediaType: 'image/png', name: '/tmp/example.png' })

  assert.match(ref.attachmentId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(ref.mediaType, 'image/png')
  assert.equal(ref.bytes, 4)
  assert.equal(ref.width, 20)
  assert.equal(ref.height, 10)
  assert.equal(ref.name, 'example.png')

  const stored = await service.readImage(ref)
  assert.equal(stored.ref, ref)
  assert.equal(stored.data, bytes)
  assert.equal(delegatedReads, 0)
  assert.equal(warnings, 1)
})

test('Android transient fallback enforces total bytes by evicting old refs', async () => {
  let delegatedReads = 0
  const attachments = {
    async saveImage() {
      throw permissionFailure('EPERM')
    },
    async readImage(ref) {
      delegatedReads += 1
      return { ref, data: new Uint8Array([9]) }
    },
  }
  const ctx = { get: (name) => (name === 'attachments' ? attachments : undefined) }
  const wrapped = installAndroidAttachmentCompat(ctx, undefined, {
    runtime: { platform: 'android', env: {} },
    probeImage: async () => ({ width: 1, height: 1 }),
    maxTransientBytes: 5,
    maxTransientSingleBytes: 5,
  })
  const service = wrapped.get('attachments')
  const first = await service.saveImage({ data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png' })
  const second = await service.saveImage({ data: new Uint8Array([5, 6, 7, 8]), mediaType: 'image/png' })

  assert.notEqual(first.attachmentId, second.attachmentId)
  const secondStored = await service.readImage(second)
  assert.deepEqual([...secondStored.data], [5, 6, 7, 8])
  const firstAfterEviction = await service.readImage(first)
  assert.deepEqual([...firstAfterEviction.data], [9])
  assert.equal(delegatedReads, 1, 'evicted refs fall back to the authoritative host store')
})

test('Android transient fallback rejects one oversized image before probing/decoding it', async () => {
  let probeCalls = 0
  const attachments = {
    async saveImage() {
      throw permissionFailure('EACCES')
    },
    async readImage() {
      throw new Error('not reached')
    },
  }
  const ctx = { get: (name) => (name === 'attachments' ? attachments : undefined) }
  const wrapped = installAndroidAttachmentCompat(ctx, undefined, {
    runtime: { platform: 'android', env: {} },
    maxTransientBytes: 8,
    maxTransientSingleBytes: 4,
    probeImage: async () => {
      probeCalls += 1
      return { width: 1, height: 1 }
    },
  })
  const service = wrapped.get('attachments')

  await assert.rejects(
    service.saveImage({ data: new Uint8Array([1, 2, 3, 4, 5]), mediaType: 'image/png' }),
    (error) => error?.code === 'ANDROID_TRANSIENT_ATTACHMENT_TOO_LARGE',
  )
  assert.equal(probeCalls, 0)
})

test('successful host saves and non-permission failures keep native semantics', async () => {
  const expected = {
    attachmentId: 'sha256:' + 'a'.repeat(64),
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  }
  let mode = 'success'
  const attachments = {
    async saveImage() {
      if (mode === 'success') return expected
      const error = new Error('disk full')
      error.code = 'ENOSPC'
      throw error
    },
    async readImage(ref) {
      return { ref, data: new Uint8Array([9]) }
    },
  }
  const ctx = { get: (name) => (name === 'attachments' ? attachments : undefined) }
  const wrapped = installAndroidAttachmentCompat(ctx, undefined, {
    runtime: { platform: 'android', env: {} },
    probeImage: async () => ({ width: 1, height: 1 }),
  })
  const service = wrapped.get('attachments')

  assert.equal(await service.saveImage({ data: new Uint8Array([1]), mediaType: 'image/png' }), expected)
  mode = 'failure'
  await assert.rejects(
    service.saveImage({ data: new Uint8Array([1]), mediaType: 'image/png' }),
    (error) => error?.code === 'ENOSPC',
  )
})

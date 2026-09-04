import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { contextWithGroundingCoordinateFrame } from '../lib/grounding-coordinate-runtime.js'
import {
  createGroundingFrame,
  sourceBoxToGroundingFrame,
} from '../lib/grounding-coordinate-frame.js'

function closeBox(actual, expected, tolerance = 2) {
  for (const key of ['x1', 'y1', 'x2', 'y2']) {
    assert.ok(
      Math.abs(Number(actual[key]) - Number(expected[key])) <= tolerance,
      `${key}: expected ${expected[key]} ±${tolerance}, got ${actual[key]}`,
    )
  }
}

function fakeCore() {
  return {
    isAttachmentIdInput(value) {
      return typeof value === 'string' && /^[a-z0-9]+:[0-9a-f]{32,}$/i.test(value.trim())
    },
    collectEventAttachmentRefs(events) {
      const refs = []
      for (const event of events ?? []) {
        if (Array.isArray(event?.data?.refs)) refs.push(...event.data.refs)
      }
      return refs
    },
    artifactStemOf(_source, suffix) {
      return `fixture-${suffix}`
    },
    async annotateBoxBuffer(bytes) {
      return sharp(bytes, { failOn: 'none' }).png().toBuffer()
    },
    async annotateBoxesBuffer(bytes) {
      return sharp(bytes, { failOn: 'none' }).png().toBuffer()
    },
  }
}

function harness(workspace, { attachmentBytes, attachmentId } = {}) {
  const registered = new Map()
  let fsReads = 0
  let attachmentReads = 0
  const fsService = {
    async resolve(value) {
      return path.isAbsolute(value) ? value : path.resolve(workspace, value)
    },
    async readBytes(target) {
      fsReads += 1
      return readFile(target)
    },
  }
  const attachments = {
    async readImage(ref) {
      attachmentReads += 1
      assert.equal(ref.attachmentId, attachmentId)
      return { ref, data: attachmentBytes }
    },
  }
  const tools = {
    register(def) {
      registered.set(def.name, def)
      return () => registered.delete(def.name)
    },
  }
  const ctx = {
    tools,
    get(name) {
      if (name === 'tools') return tools
      if (name === 'fs') return fsService
      if (name === 'attachments') return attachments
      return undefined
    },
  }
  return {
    ctx,
    registered,
    counts: () => ({ fsReads, attachmentReads }),
  }
}

function execFor(workspace, { events = [], inbox } = {}) {
  return {
    agent: {
      session: { header: { cwd: workspace }, events },
      ...(inbox === undefined ? {} : { inbox }),
    },
  }
}

test('vision_ground sends a real 1000x1000 letterbox raster and remaps a wide-image box to source pixels', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vr-ground-wide-'))
  const sourcePath = path.join(workspace, 'wide.png')
  const width = 1600
  const height = 900
  const sourceBox = { x1: 320, y1: 180, x2: 1280, y2: 720 }
  const sourceBytes = await sharp({
    create: { width, height, channels: 3, background: { r: 240, g: 240, b: 240 } },
  }).png().toBuffer()
  await writeFile(sourcePath, sourceBytes)

  const h = harness(workspace)
  const wrapped = contextWithGroundingCoordinateFrame(h.ctx, {
    core: fakeCore(),
    config: {},
  })
  let delegatedPath
  wrapped.tools.register({
    name: 'vision_ground',
    async execute(args) {
      delegatedPath = args.image
      assert.equal(args.annotate, false)
      const frameBytes = await readFile(args.image)
      const meta = await sharp(frameBytes).metadata()
      assert.equal(meta.width, 1000)
      assert.equal(meta.height, 1000)
      const frame = createGroundingFrame(width, height)
      const inFrame = sourceBoxToGroundingFrame(sourceBox, frame)
      return JSON.stringify({
        x1: Math.round(inFrame.x1),
        y1: Math.round(inFrame.y1),
        x2: Math.round(inFrame.x2),
        y2: Math.round(inFrame.y2),
        width: 1000,
        height: 1000,
      })
    },
  })

  const raw = await h.registered.get('vision_ground').execute(
    { image: sourcePath, target: 'fixture target', annotate: true },
    execFor(workspace),
  )
  const result = JSON.parse(raw)
  assert.equal(result.width, width)
  assert.equal(result.height, height)
  closeBox(result, sourceBox)
  assert.equal(typeof result.annotatedPath, 'string')
  const annotated = await sharp(await readFile(result.annotatedPath)).metadata()
  assert.equal(annotated.width, width)
  assert.equal(annotated.height, height)
  assert.equal(existsSync(delegatedPath), false, 'internal square frame should be removed after delegation')
})

test('vision_detect remaps tall-image inventories, filters padding-only boxes, and renumbers survivors', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vr-detect-tall-'))
  const sourcePath = path.join(workspace, 'tall.png')
  const width = 900
  const height = 1600
  const sourceBoxes = [
    { x1: 90, y1: 160, x2: 360, y2: 480 },
    { x1: 450, y1: 960, x2: 810, y2: 1440 },
  ]
  const sourceBytes = await sharp({
    create: { width, height, channels: 3, background: { r: 250, g: 250, b: 250 } },
  }).png().toBuffer()
  await writeFile(sourcePath, sourceBytes)

  const h = harness(workspace)
  const wrapped = contextWithGroundingCoordinateFrame(h.ctx, {
    core: fakeCore(),
    config: {},
  })
  wrapped.tools.register({
    name: 'vision_detect',
    async execute(args) {
      assert.equal(args.annotate, false)
      const meta = await sharp(await readFile(args.image)).metadata()
      assert.equal(meta.width, 1000)
      assert.equal(meta.height, 1000)
      const frame = createGroundingFrame(width, height)
      const framed = sourceBoxes.map((box) => sourceBoxToGroundingFrame(box, frame))
      return JSON.stringify({
        width: 1000,
        height: 1000,
        elements: [
          { number: 8, label: 'first', box: Object.fromEntries(Object.entries(framed[0]).map(([k, v]) => [k, Math.round(v)])) },
          // Pure left padding in the letterboxed tall frame: must not become a
          // fake source-image element after clamping.
          { number: 9, label: 'padding', box: { x1: 0, y1: 100, x2: 100, y2: 200 } },
          { number: 10, label: 'second', box: Object.fromEntries(Object.entries(framed[1]).map(([k, v]) => [k, Math.round(v)])) },
        ],
      })
    },
  })

  const result = JSON.parse(await h.registered.get('vision_detect').execute(
    { image: sourcePath, target: 'widgets', annotate: true },
    execFor(workspace),
  ))
  assert.equal(result.width, width)
  assert.equal(result.height, height)
  assert.equal(result.elements.length, 2)
  assert.deepEqual(result.elements.map((item) => item.number), [1, 2])
  assert.deepEqual(result.elements.map((item) => item.label), ['first', 'second'])
  closeBox(result.elements[0].box, sourceBoxes[0])
  closeBox(result.elements[1].box, sourceBoxes[1])
  const annotated = await sharp(await readFile(result.annotatedPath)).metadata()
  assert.equal(annotated.width, width)
  assert.equal(annotated.height, height)
})

test('attachment ids are resolved through the canonical SessionVisionIndex before framing', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vr-ground-attachment-'))
  const width = 1200
  const height = 600
  const attachmentId = `sha256:${'a'.repeat(64)}`
  const sourceBox = { x1: 120, y1: 60, x2: 1080, y2: 540 }
  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: 220, g: 220, b: 220 } },
  }).png().toBuffer()
  const h = harness(workspace, { attachmentBytes: bytes, attachmentId })
  let indexLookups = 0
  const wrapped = contextWithGroundingCoordinateFrame(h.ctx, {
    core: fakeCore(),
    config: {},
    sessionVisionIndex: {
      lookupAttachment(_session, id) {
        indexLookups += 1
        assert.equal(id, attachmentId)
        return { attachmentId, mediaType: 'image/png', width, height, bytes: bytes.length }
      },
    },
  })
  wrapped.tools.register({
    name: 'vision_ground',
    async execute(args) {
      const meta = await sharp(await readFile(args.image)).metadata()
      assert.equal(meta.width, 1000)
      assert.equal(meta.height, 1000)
      const inFrame = sourceBoxToGroundingFrame(sourceBox, createGroundingFrame(width, height))
      return JSON.stringify(Object.fromEntries(Object.entries(inFrame).map(([k, v]) => [k, Math.round(v)])))
    },
  })

  const result = JSON.parse(await h.registered.get('vision_ground').execute(
    { image: attachmentId, target: 'attachment target', annotate: false },
    execFor(workspace),
  ))
  closeBox(result, sourceBox)
  assert.equal(indexLookups, 1)
  assert.deepEqual(h.counts(), { fsReads: 0, attachmentReads: 1 })
})

test('DSH text-only sha256 prefix is canonicalized before grounding and never falls through to a path', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vr-ground-short-handle-'))
  const width = 1200
  const height = 600
  const prefix = '2e73d462'
  const attachmentId = `sha256:${prefix}${'a'.repeat(56)}`
  const handle = `sha256:${prefix}`
  const ref = { attachmentId, mediaType: 'image/png', width, height, bytes: 1 }
  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: 230, g: 230, b: 230 } },
  }).png().toBuffer()
  ref.bytes = bytes.length
  const h = harness(workspace, { attachmentBytes: bytes, attachmentId })
  const lookedUp = []
  const wrapped = contextWithGroundingCoordinateFrame(h.ctx, {
    core: fakeCore(),
    config: {},
    sessionVisionIndex: {
      lookupAttachment(_session, id) {
        lookedUp.push(id)
        return id === attachmentId ? ref : undefined
      },
      recordAttachments() {},
    },
  })
  wrapped.tools.register({
    name: 'vision_ground',
    async execute() {
      return JSON.stringify({ x1: 0, y1: 0, x2: 1000, y2: 1000 })
    },
  })

  const result = JSON.parse(await h.registered.get('vision_ground').execute(
    { image: handle, target: 'whole image', annotate: false },
    execFor(workspace, { events: [{ type: 'user/message', data: { refs: [ref] } }] }),
  ))
  assert.equal(result.width, width)
  assert.equal(result.height, height)
  assert.deepEqual(lookedUp, [attachmentId, attachmentId])
  assert.deepEqual(h.counts(), { fsReads: 0, attachmentReads: 1 })
})

test('vision_describe canonicalizes projected handles in attachmentIds and paths but leaves prose untouched', async () => {
  const workspace = process.cwd()
  const prefix = '1234abcd'
  const attachmentId = `sha256:${prefix}${'b'.repeat(56)}`
  const handle = `sha256:${prefix}`
  const ref = { attachmentId, mediaType: 'image/png', width: 1, height: 1, bytes: 1 }
  const h = harness(workspace)
  const wrapped = contextWithGroundingCoordinateFrame(h.ctx, {
    core: fakeCore(),
    config: {},
    sessionVisionIndex: {
      lookupAttachment(_session, id) {
        return id === attachmentId ? ref : undefined
      },
      recordAttachments() {},
    },
  })
  let observed
  wrapped.tools.register({
    name: 'vision_describe',
    execute(args) {
      observed = args
      return 'ok'
    },
  })
  const exec = execFor(workspace, { events: [{ type: 'user/message', data: { refs: [ref] } }] })
  const question = `what does ${handle} mean as text?`
  assert.equal(
    h.registered.get('vision_describe').execute({
      attachmentIds: [handle],
      paths: [handle, 'local.png'],
      question,
    }, exec),
    'ok',
  )
  assert.deepEqual(observed.attachmentIds, [attachmentId])
  assert.deepEqual(observed.paths, [attachmentId, 'local.png'])
  assert.equal(observed.question, question)
})

test('projected handles fail closed on unknown, ambiguous, and cross-session references', () => {
  const workspace = process.cwd()
  const prefix = 'deadbeef'
  const handle = `sha256:${prefix}`
  const first = { attachmentId: `sha256:${prefix}${'1'.repeat(56)}`, mediaType: 'image/png' }
  const second = { attachmentId: `sha256:${prefix}${'2'.repeat(56)}`, mediaType: 'image/png' }
  const h = harness(workspace)
  const wrapped = contextWithGroundingCoordinateFrame(h.ctx, {
    core: fakeCore(),
    config: {},
    sessionVisionIndex: {
      lookupAttachment() {
        throw new Error('lookup must not authorize an unknown prefix by itself')
      },
      recordAttachments() {},
    },
  })
  let delegated = 0
  wrapped.tools.register({
    name: 'vision_materialize',
    execute() {
      delegated += 1
      return 'should-not-run'
    },
  })

  assert.throws(
    () => h.registered.get('vision_materialize').execute(
      { image: handle },
      execFor(workspace),
    ),
    /unknown attachment handle/,
  )
  assert.throws(
    () => h.registered.get('vision_materialize').execute(
      { image: handle },
      execFor(workspace, { events: [{ data: { refs: [first, second] } }] }),
    ),
    /ambiguous attachment handle/,
  )
  const foreignExec = execFor(workspace, { events: [{ data: { refs: [first] } }] })
  const currentExec = execFor(workspace)
  assert.ok(foreignExec.agent.session.events.length > 0)
  assert.throws(
    () => h.registered.get('vision_materialize').execute({ image: handle }, currentExec),
    /unknown attachment handle/,
  )
  assert.equal(delegated, 0)
})

test('pending current-session image refs can authorize the same projected handle without global lookup', () => {
  const workspace = process.cwd()
  const prefix = 'cafebabe'
  const attachmentId = `sha256:${prefix}${'c'.repeat(56)}`
  const handle = `sha256:${prefix}`
  const ref = { attachmentId, mediaType: 'image/png', width: 1, height: 1, bytes: 1 }
  const h = harness(workspace)
  const wrapped = contextWithGroundingCoordinateFrame(h.ctx, {
    core: fakeCore(),
    config: {},
    sessionVisionIndex: {
      lookupAttachment(_session, id) {
        return id === attachmentId ? ref : undefined
      },
      recordAttachments() {},
    },
  })
  let observed
  wrapped.tools.register({
    name: 'vision_pixel_diff',
    execute(args) {
      observed = args
      return 'ok'
    },
  })
  const inbox = {
    nextTurn: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
    nextStep: [],
  }
  assert.equal(
    h.registered.get('vision_pixel_diff').execute(
      { original: handle, rebuilt: 'rebuilt.png' },
      execFor(workspace, { inbox }),
    ),
    'ok',
  )
  assert.equal(observed.original, attachmentId)
  assert.equal(observed.rebuilt, 'rebuilt.png')
})

test('non-grounding tools pass through without execute replacement when no SessionVisionIndex is installed', () => {
  const h = harness(process.cwd())
  const wrapped = contextWithGroundingCoordinateFrame(h.ctx, { core: fakeCore(), config: {} })
  const execute = async () => 'ok'
  wrapped.tools.register({ name: 'vision_crop', execute })
  assert.equal(h.registered.get('vision_crop').execute, execute)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GROUNDING_FRAME_SIZE,
  createGroundingFrame,
  groundingFrameBoxToSource,
  sourceBoxToGroundingFrame,
} from '../lib/grounding-coordinate-frame.js'
import {
  looseGroundingBoxFromText,
  parseGroundingBoxResponse,
  assessGroundingBox,
} from '../lib/grounding-box-recovery.js'

test('wide source is letterboxed vertically and maps back to canonical pixels', () => {
  const frame = createGroundingFrame(2000, 1000)
  assert.deepEqual(frame, {
    frameWidth: 1000,
    frameHeight: 1000,
    sourceWidth: 2000,
    sourceHeight: 1000,
    renderedWidth: 1000,
    renderedHeight: 500,
    left: 0,
    top: 250,
    right: 0,
    bottom: 250,
    scaleX: 0.5,
    scaleY: 0.5,
  })
  assert.deepEqual(
    groundingFrameBoxToSource({ x1: 100, y1: 300, x2: 900, y2: 700 }, frame),
    { x1: 200, y1: 100, x2: 1800, y2: 900 },
  )
})

test('tall source is letterboxed horizontally and maps back to canonical pixels', () => {
  const frame = createGroundingFrame(1000, 2000)
  assert.equal(frame.left, 250)
  assert.equal(frame.top, 0)
  assert.equal(frame.renderedWidth, 500)
  assert.equal(frame.renderedHeight, 1000)
  assert.deepEqual(
    groundingFrameBoxToSource({ x1: 300, y1: 100, x2: 700, y2: 900 }, frame),
    { x1: 100, y1: 200, x2: 900, y2: 1800 },
  )
})

test('square source keeps an identity 1000x1000 frame', () => {
  const frame = createGroundingFrame(GROUNDING_FRAME_SIZE, GROUNDING_FRAME_SIZE)
  assert.equal(frame.left, 0)
  assert.equal(frame.top, 0)
  assert.equal(frame.scaleX, 1)
  assert.equal(frame.scaleY, 1)
  const box = { x1: 123, y1: 234, x2: 789, y2: 876 }
  assert.deepEqual(groundingFrameBoxToSource(box, frame), box)
})

test('round-trip uses exact integer render geometry for odd aspect ratios', () => {
  const frame = createGroundingFrame(1919, 1081)
  const source = { x1: 77, y1: 91, x2: 1703, y2: 1000 }
  const protocol = sourceBoxToGroundingFrame(source, frame)
  assert.deepEqual(groundingFrameBoxToSource(protocol, frame), source)
})

test('boxes entirely inside letterbox padding are rejected after inverse mapping', () => {
  const frame = createGroundingFrame(2000, 1000)
  assert.equal(
    groundingFrameBoxToSource({ x1: 100, y1: 10, x2: 200, y2: 100 }, frame),
    undefined,
  )
})


test('issue #818: the four real near-JSON samples recover only uniquely named integer fields', () => {
  const samples = [
    ['{"x1":643,"y1:758","x2":940,"y2":836"}', [643, 758, 940, 836]],
    ['{"x1": 34, y1:305,"x2": 193, y2:346}', [34, 305, 193, 346]],
    ['{"x1": 324, "y1": 315], "x2": [426, "y2": 342]', [324, 315, 426, 342]],
    ['{"x1":1074,898,"y1":900,"x2":1538,1115,"y2":1115}', [1074, 900, 1538, 1115]],
  ]
  for (const [input, [x1, y1, x2, y2]] of samples) {
    assert.deepEqual(parseGroundingBoxResponse(input), { x1, y1, x2, y2 })
  }
  assert.equal(parseGroundingBoxResponse('{"x1":1,"x1":2,"y1":3,"x2":5,"y2":8}'), undefined)
  assert.deepEqual(parseGroundingBoxResponse('{"x1":3,"y1":4,"x2":19,"y2":25}'), {
    x1: 3, y1: 4, x2: 19, y2: 25,
  })
})

test('issue #818: tolerant recovery rejects ambiguous, unkeyed, negative, decimal, and oversized responses', () => {
  for (const invalid of [
    'box: 643,758,940,836',
    'x1:12,y1:20,x2:20', // missing y2
    'x1:12,y1:20,x2:20,y2:30,x1:13',
    'x1:-12,y1:20,x2:20,y2:30',
    'x1:12.5,y1:20,x2:20,y2:30',
    'x1:12e4,y1:20,x2:20,y2:30',
    'x1:12,y1:20,x2:20,y2:2',
    'x1:12,y1:20,x2:20,y2:30'.repeat(1000),
  ]) {
    assert.equal(looseGroundingBoxFromText(invalid), undefined, invalid.slice(0, 70))
  }
})

test('issue #818: reject padded/out-of-frame boxes instead of clamping them into wrong pixels', () => {
  const f = createGroundingFrame(900, 520)
  const content = {
    x1: f.left, y1: f.top,
    x2: f.left + f.renderedWidth,
    y2: f.top + f.renderedHeight,
  }
  assert.equal(assessGroundingBox({ x1: 45, y1: 0, x2: 180, y2: 36 }, 1000, 1000, content).ok, false)
  assert.equal(assessGroundingBox({ x1: 45, y1: 205, x2: 180, y2: 250 }, 1000, 1000, content).ok, false)
  assert.equal(assessGroundingBox({ x1: 1074, y1: 700, x2: 1538, y2: 900 }, 1000, 1000, content).ok, false)
  assert.equal(assessGroundingBox({ x1: 45, y1: f.top + 10, x2: 180, y2: f.top + 36 }, 1000, 1000, content).ok, true)
  const edge = assessGroundingBox({ x1: 45, y1: f.top - 1, x2: 180, y2: f.top + 36 }, 1000, 1000, content)
  assert.equal(edge.ok, true)
  assert.equal(edge.box.y1, f.top)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GROUNDING_FRAME_SIZE,
  createGroundingFrame,
  groundingFrameBoxToSource,
  sourceBoxToGroundingFrame,
} from '../lib/grounding-coordinate-frame.js'

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

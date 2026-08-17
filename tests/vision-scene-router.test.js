import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routePostBootstrapScene, sceneRouteAgentInstruction } from '../lib/vision-scene-router.js'

test('routes chat screenshots to OCR after bootstrap without a pre-bootstrap mode', () => {
  const route = routePostBootstrapScene({
    visual_kind: 'chat',
    overview: 'A messaging conversation with speaker names and timestamps',
    visible_text: [{ region_id: 'r1', text: '小林 10:24\n收到', uncertain: false }],
  })
  assert.equal(route.scene, 'document.chat')
  assert.equal(route.primaryIntent, 'ocr')
  assert.equal(route.specialist.tool, 'vision_ocr')
  assert.ok(route.confidence >= 0.8)
})

test('routes code and terminal screenshots to code_screenshot capability', () => {
  const route = routePostBootstrapScene({
    visual_kind: 'code',
    overview: 'Terminal traceback beside source code',
    uncertainties: [{ region_id: 'r2', detail: 'small error line is not fully legible' }],
  })
  assert.equal(route.scene, 'document.code')
  assert.equal(route.primaryIntent, 'code_screenshot')
  assert.equal(route.specialist.tool, 'vision_describe')
  assert.equal(route.zoom.recommended, true)
  assert.deepEqual(route.zoom.tools, ['vision_ground', 'vision_crop'])
})

test('routes table-like documents to document capability', () => {
  const route = routePostBootstrapScene({
    visual_kind: 'document',
    overview: 'Invoice table with rows, columns, subtotal and total',
    regions: [{ id: 'r1', role: 'table', content: 'Item Amount Total' }],
  })
  assert.equal(route.scene, 'document.table')
  assert.equal(route.primaryIntent, 'document')
  assert.equal(route.specialist.tool, 'vision_describe')
})

test('routes GUI screenshots to UI detection and recommends zoom for dense UI', () => {
  const route = routePostBootstrapScene({
    visual_kind: 'ui',
    entities: [
      { id: 'e1', type: 'button', label: 'Save' },
      { id: 'e2', type: 'input', label: 'Name' },
    ],
  })
  assert.equal(route.scene, 'ui')
  assert.equal(route.primaryIntent, 'ui')
  assert.equal(route.specialist.tool, 'vision_detect')
  assert.equal(route.zoom.recommended, true)
})

test('general scenes remain VLM-style and inference policy forbids guessing', () => {
  const route = routePostBootstrapScene({ visual_kind: 'general', overview: 'A dog beside a bicycle' })
  assert.equal(route.scene, 'other')
  assert.equal(route.primaryIntent, 'general')
  assert.equal(route.specialist.tool, 'vision_describe')
  assert.match(route.inferencePolicy, /Never guess exact text/i)
  const instruction = sceneRouteAgentInstruction(route)
  assert.match(instruction, /Post-bootstrap scene route: other/)
  assert.match(instruction, /instead of guessing/i)
})


test('spreadsheet content beats an outer application UI shell', () => {
  const route = routePostBootstrapScene({
    visual_kind: 'ui',
    overview: 'WPS spreadsheet application',
    regions: [{ id: 'r1', role: 'spreadsheet grid', content: 'table rows columns Amount Total' }],
    entities: [{ id: 'e1', type: 'button', label: 'Save' }],
  }, { taskText: '把每一行项目和金额整理出来，并核对总计是否正确' })
  assert.equal(route.scene, 'document.table')
  assert.equal(route.primaryIntent, 'document')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inferToolVisionIntent } from '../lib/vision-capability-router.js'

test('shadow-only config is opt-in and does not replace the v1 execution loops', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /capabilityRoutingShadow: z\.boolean\(\)\.default\(false\)/)
  assert.match(source, /capabilityRoutingStrategy: z\.string\(\)\.default\('balanced'\)/)
  assert.match(source, /const shadowVisionRouting = async/)
  assert.match(source, /capability-shadow tool=%s intent=%s strategy=%s changed=%s/)
  assert.match(source, /for \(const pair of usablePairs\)/)
  assert.match(source, /for \(const provider of httpFallbacks\)/)
  assert.doesNotMatch(source, /usablePairs\s*=\s*rankVisionCandidates/)
})

test('bootstrap and shared model-backed tools feed specialist intent into shadow routing', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /__visionToolName: 'vision_bootstrap'/)
  assert.match(source, /__visionIntent: 'structured'/)
  assert.ok((source.match(/await shadowVisionRouting\(/g) ?? []).length >= 2)
})

test('instruction inference catches OCR, grounding and detection helpers', () => {
  assert.equal(inferToolVisionIntent('vision_describe', { question: '请原样转述图中的所有文字' }), 'ocr')
  assert.equal(inferToolVisionIntent('vision_describe', { question: 'Target to locate: send button; return tight bounding box' }), 'grounding')
  assert.equal(inferToolVisionIntent('vision_describe', { question: 'Find every button and return a numbered inventory' }), 'detection')
})

test('settings UI keeps shadow routing in developer settings', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /toggleCapabilityRoutingShadow/)
  assert.match(source, /DEVELOPER_TOGGLE_KEYS = \['stealth', 'capabilityRoutingShadow'\]/)
  assert.match(source, /capabilityRoutingStrategyLabel/)
})

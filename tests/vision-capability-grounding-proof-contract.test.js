import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_BENCHMARK_SUITE_REVISION,
  capabilityBenchmarkFixture,
  scoreCapabilityBenchmarkResult,
} from '../lib/vision-capability-benchmark.js'
import {
  hardenCapabilityBenchmarkFixture,
  verifyAndStripBenchmarkVisualProof,
} from '../lib/vision-capability-benchmark-hardening.js'

test('grounding suite v5 keeps coordinate output compatible with the final visual-proof line', () => {
  assert.equal(CAPABILITY_BENCHMARK_SUITE_REVISION, 5)

  const fixture = capabilityBenchmarkFixture('grounding')
  assert.match(fixture.prompt, /first line/i)
  assert.match(fixture.prompt, /coordinate line/i)
  assert.doesNotMatch(fixture.prompt, /return only/i)
  assert.doesNotMatch(fixture.prompt, /do not add prose/i)

  const hardened = hardenCapabilityBenchmarkFixture(fixture, 'ABC123')
  assert.match(hardened.prompt, /first line/i)
  assert.match(hardened.prompt, /one final line exactly/i)
  assert.match(hardened.prompt, /VR-CODE:<code>/)

  const stripped = verifyAndStripBenchmarkVisualProof(
    '[[672,672,901,813]]\nVR-CODE:ABC123',
    'ABC123',
  )
  assert.equal(stripped, '[[672,672,901,813]]')

  const scored = scoreCapabilityBenchmarkResult(fixture, stripped, 300)
  assert.ok(scored.score > 0.99)
  assert.equal(scored.details.coordinateSpace, 'normalized-1000')
  assert.equal(scored.details.formatValid, true)
})

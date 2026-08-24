import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hardenCapabilityBenchmarkFixture,
  verifyAndStripBenchmarkVisualProof,
} from '../lib/vision-capability-benchmark-hardening.js'

test('visual-proof failure is not misclassified as unsupported image capability', () => {
  assert.throws(
    () => verifyAndStripBenchmarkVisualProof('task answer without proof', 'A1B2C3D4'),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED'
      && error?.benchmarkClass === 'visual-proof',
  )
})

test('JSON-only fixtures carry visual proof inside JSON instead of contradicting the output contract', () => {
  const fixture = hardenCapabilityBenchmarkFixture({
    id: 'json-only',
    intent: 'document',
    svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    prompt: 'Return ONLY JSON with title and rows.',
    expected: { title: 'x' },
  }, 'A1B2C3D4')
  assert.equal(fixture.visualProofMode, 'json-field')
  assert.match(fixture.prompt, /"_vr_code"/)
  assert.doesNotMatch(fixture.prompt, /one final line exactly/i)
  const stripped = verifyAndStripBenchmarkVisualProof(
    '{"title":"Order Summary","rows":[],"_vr_code":"A1B2C3D4"}',
    'A1B2C3D4',
  )
  assert.deepEqual(JSON.parse(stripped), { title: 'Order Summary', rows: [] })
})

test('JSON visual proof still rejects a wrong or missing image-derived code', () => {
  for (const output of [
    '{"title":"Order Summary","_vr_code":"WRONG99"}',
    '{"title":"Order Summary"}',
  ]) {
    assert.throws(
      () => verifyAndStripBenchmarkVisualProof(output, 'A1B2C3D4'),
      (error) => error?.code === 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED'
        && error?.benchmarkClass === 'visual-proof',
    )
  }
})

test('visual proof accepts the exact standalone challenge line at any output position and strips only that line', () => {
  const expected = 'A1B2C3D4'
  assert.equal(
    verifyAndStripBenchmarkVisualProof('VR-CODE:A1B2C3D4\nRouter Bench 7Q2\nInvoice A-1948', expected),
    'Router Bench 7Q2\nInvoice A-1948',
  )
  assert.equal(
    verifyAndStripBenchmarkVisualProof('Router Bench 7Q2\nVR-CODE:A1B2C3D4\nInvoice A-1948', expected),
    'Router Bench 7Q2\nInvoice A-1948',
  )
  assert.equal(
    verifyAndStripBenchmarkVisualProof('Router Bench 7Q2\nInvoice A-1948\nVR-CODE:A1B2C3D4', expected),
    'Router Bench 7Q2\nInvoice A-1948',
  )
})

test('visual proof still rejects wrong, embedded, or missing challenge material', () => {
  for (const output of [
    'Router Bench 7Q2\nVR-CODE:WRONG99',
    'Router Bench 7Q2 VR-CODE:A1B2C3D4',
    '{"proof":"VR-CODE:A1B2C3D4"}',
    'Router Bench 7Q2',
  ]) {
    assert.throws(
      () => verifyAndStripBenchmarkVisualProof(output, 'A1B2C3D4'),
      (error) => error?.code === 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED',
    )
  }
})

test('visual proof failure diagnostics expose booleans only and never the random challenge or response text', () => {
  const expected = 'A1B2C3D4'
  const cases = [
    {
      output: '',
      diagnostic: { responseEmpty: true, prefixSeen: false, expectedCodeSeen: false, proofLikeLineSeen: false },
    },
    {
      output: 'Router Bench 7Q2',
      diagnostic: { responseEmpty: false, prefixSeen: false, expectedCodeSeen: false, proofLikeLineSeen: false },
    },
    {
      output: 'A1B2C3D4\nRouter Bench 7Q2',
      diagnostic: { responseEmpty: false, prefixSeen: false, expectedCodeSeen: true, proofLikeLineSeen: false },
    },
    {
      output: 'VR-CODE：A1B2C3D4\nRouter Bench 7Q2',
      diagnostic: { responseEmpty: false, prefixSeen: true, expectedCodeSeen: true, proofLikeLineSeen: true },
    },
  ]
  for (const entry of cases) {
    assert.throws(
      () => verifyAndStripBenchmarkVisualProof(entry.output, expected),
      (error) => {
        assert.equal(error?.code, 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED')
        assert.deepEqual(error?.proofDiagnostic, entry.diagnostic)
        assert.match(error?.message ?? '', /vr-proof responseEmpty=[01] prefixSeen=[01] expectedCodeSeen=[01] proofLikeLineSeen=[01]/)
        assert.doesNotMatch(error?.message ?? '', /A1B2C3D4|Router Bench/)
        return true
      },
    )
  }
})

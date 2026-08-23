import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectProviderEvidence } from '../lib/v2-acceptance-cli.js'
import { verifyAndStripBenchmarkVisualProof } from '../lib/vision-capability-benchmark-hardening.js'

test('visual-proof failure is not misclassified as unsupported image capability', () => {
  assert.throws(
    () => verifyAndStripBenchmarkVisualProof('task answer without proof', 'A1B2C3D4'),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED'
      && error?.benchmarkClass === 'visual-proof',
  )
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

test('J0b proof failure identifies the exact Quick fixture from terminal progress without raw model output', () => {
  const key = 'zhipu-glm/glm-4.6v'
  const candidate = {
    key,
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    fingerprint: 'ep2_0123456789abcdef0123456789abcdef',
  }
  const beforeSnapshot = {
    suiteRevision: 5,
    candidates: [candidate],
    jobs: [],
  }
  const afterSnapshot = {
    suiteRevision: 5,
    candidates: [candidate],
    jobs: [{
      id: 'bench-proof-failure',
      key,
      mode: 'quick',
      state: 'failed',
      completed: 2,
      total: 3,
      finishedAt: 12_000,
      errorClass: 'visual-proof',
      errorCode: 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED',
    }],
  }
  const providerReport = {
    ok: false,
    candidate: { key, provider: 'zhipu-glm', model: 'glm-4.6v' },
    cases: [{
      id: 'B-live',
      status: 'fail',
      details: {
        mode: 'quick',
        errorClass: 'visual-proof',
        errorCode: 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED',
      },
    }],
  }

  const report = inspectProviderEvidence({
    beforeSnapshot,
    afterSnapshot,
    providerReport,
    key,
    mode: 'quick',
    startedAt: 10_000,
  })
  assert.equal(report.ok, true)
  const diagnostic = report.cases.find((entry) => entry.id === 'J0B-failure-fixture')
  assert.equal(diagnostic?.status, 'pass')
  assert.deepEqual(diagnostic?.details, {
    identified: true,
    failedFixture: 'ocr-zh-chat-v2',
    failedIntent: 'ocr',
    completed: 2,
    total: 3,
  })
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostic.details, 'rawResponse'), false)
})

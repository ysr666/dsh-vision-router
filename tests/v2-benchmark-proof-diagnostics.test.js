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

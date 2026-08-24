import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCapabilityBenchmarkFailure } from '../lib/vision-capability-benchmark-service.js'

test('visual proof failure is not image rejection', () => {
  const error = Object.assign(new Error('generated image was not proven'), {
    code: 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED',
  })
  assert.equal(classifyCapabilityBenchmarkFailure(error), 'visual-proof')
})

test('explicit image-input rejection is classified as unsupported image', () => {
  assert.equal(classifyCapabilityBenchmarkFailure(Object.assign(new Error('invalid request'), {
    code: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
  })), 'unsupported-image')
  assert.equal(classifyCapabilityBenchmarkFailure(new Error('model does not support image input')), 'unsupported-image')
})

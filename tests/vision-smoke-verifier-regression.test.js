import test from 'node:test'
import assert from 'node:assert/strict'

import { verifyVisionSmokeOutput } from '../lib/vision-backend-smoke-test.js'

test('exact vision verifier accepts one unambiguous 731 answer without reasoning-number pollution', () => {
  assert.equal(verifyVisionSmokeOutput('731'), true)
  assert.equal(verifyVisionSmokeOutput('The number is 731.'), true)
  assert.equal(verifyVisionSmokeOutput('The 3-digit number is 731.'), true)
  assert.equal(verifyVisionSmokeOutput('confidence 99%, answer 731'), true)
  assert.equal(verifyVisionSmokeOutput('７３１'), true)
  assert.equal(verifyVisionSmokeOutput('731 ... 731'), true)
})

test('exact vision verifier rejects conflicting or embedded three-digit candidates', () => {
  assert.equal(verifyVisionSmokeOutput('732'), false)
  assert.equal(verifyVisionSmokeOutput('1731'), false)
  assert.equal(verifyVisionSmokeOutput('7312'), false)
  assert.equal(verifyVisionSmokeOutput('123 or 731'), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

function requireSource(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

// Long-screenshot OCR: when the first vision answer exceeds 12k chars it is
// judged a hallucination and retried once with a stricter prompt. If that
// retry comes back ok-but-blank, the chunk text must be cleared — keeping
// the first answer would publish the rejected hallucination as engine-
// verified (`used = 'vision'`), and downstream longOcrEvidence treats
// non-empty text as valid evidence.
test('long OCR hallucination retry clears text on an ok-but-blank retry', () => {
  const source = requireSource('../index.js')
  // The fixed assignment replaced the conditional keep of the first answer.
  assert.equal(source.includes('text = retry.text.trim()'), true)
  assert.equal(source.includes("if (retryText !== '') text = retryText"), false)
})

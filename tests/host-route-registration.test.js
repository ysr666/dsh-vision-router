import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('all Vision Router host endpoints share one webServer injection', () => {
  // DSH 0.1.0-rc.6 + the local-vision stabilizer only retained the first of
  // repeated wrapped webServer injections. Keep the four host endpoints in
  // one injection fiber so route registration is atomic across rc.6 and later.
  assert.equal((source.match(/ctx\.inject\(\['webServer'\]/g) || []).length, 1)
  const injection = source.indexOf("ctx.inject(['webServer']")
  const boundary = source.indexOf('// Expose the namespace to the web configuration boundary.')
  assert.ok(injection >= 0)
  assert.ok(boundary > injection)
  for (const route of [
    '/_dsh/vision-router/test-connection',
    '/_dsh/vision-router/update-check',
    '/_dsh/vision-router/self-update',
    '/_dsh/vision-router/model-capabilities',
  ]) {
    const position = source.indexOf(route)
    assert.ok(position > injection && position < boundary, `${route} must be registered in the shared injection`)
  }
})

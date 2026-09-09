import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const MAX_SOURCE_BYTES = 262_144

test('runtime composition files stay below the Store single-file review bound', async () => {
  for (const relative of ['../index.js', '../lib/core-primitives.js', '../lib/sharp-runtime.js', '../lib/client.js']) {
    const info = await stat(new URL(relative, import.meta.url))
    assert.ok(info.size <= MAX_SOURCE_BYTES, relative + ' exceeds ' + MAX_SOURCE_BYTES + ' bytes: ' + info.size)
  }
})

test('index keeps Config and apply while helper seams are modularized', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /export const Config = z\.object\(/)
  assert.match(source, /export function apply\(ctx, config = \{\}, runtime = \{\}\)/)
  assert.match(source, /from '\.\/lib\/core-primitives\.js'/)
  assert.match(source, /from '\.\/lib\/sharp-runtime\.js'/)
})

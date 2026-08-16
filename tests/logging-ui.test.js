import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('settings card exposes a one-click logs-folder action', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("openLogFolder: '打开日志文件夹'"), true)
  assert.equal(source.includes("openLogFolder: 'Open logs folder'"), true)
  assert.equal(source.includes("fetch('/_dsh/vision-router/logs'"), true)
  assert.equal(source.includes("method: 'POST'"), true)
})

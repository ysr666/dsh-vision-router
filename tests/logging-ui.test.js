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

test('log-folder failures include a machine-readable error code', () => {
  const serverSource = readFileSync(new URL('../lib/file-logger.js', import.meta.url), 'utf8')
  assert.equal(serverSource.includes("code: error && error.code !== undefined ? String(error.code) : undefined"), true)
})

test('settings save failures are forwarded to the bounded server diagnostic route', () => {
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const serverSource = readFileSync(new URL('../lib/file-logger.js', import.meta.url), 'utf8')
  assert.equal(clientSource.includes("fetch('/_dsh/vision-router/settings-save-diagnostics'"), true)
  assert.equal(serverSource.includes("const SETTINGS_SAVE_DIAGNOSTICS_PATH = '/_dsh/vision-router/settings-save-diagnostics'"), true)
  assert.equal(serverSource.includes("'vision-router: settings save failed field=%s operation=%s reason=%s detail=%s'"), true)
})

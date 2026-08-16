import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createFileLogSink,
  openLogDirectory,
  resolveVisionRouterLogPaths,
  sanitizeLogText,
} from '../lib/file-logger.js'

test('resolveVisionRouterLogPaths keeps diagnostics under DSH_HOME', () => {
  const root = path.join(path.sep, 'tmp', 'custom-dsh-home')
  const paths = resolveVisionRouterLogPaths(root)
  assert.equal(paths.directory, path.join(root, 'logs', 'vision-router'))
  assert.equal(paths.file, path.join(paths.directory, 'vision-router.log'))
  assert.equal(paths.backup, path.join(paths.directory, 'vision-router.1.log'))
})

test('sanitizeLogText redacts common credential shapes', () => {
  const input = [
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'key=sk-proj-abcdefghijklmnopqrstuvwxyz',
    'https://example.test/?api_key=super-secret-value&x=1',
  ].join(' | ')
  const output = sanitizeLogText(input)
  assert.equal(output.includes('abcdefghijklmnopqrstuvwxyz'), false)
  assert.equal(output.includes('super-secret-value'), false)
  assert.match(output, /\[REDACTED/)
})

test('file log sink writes formatted diagnostics and rotates bounded logs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-log-'))
  const file = path.join(root, 'vision-router.log')
  const backup = path.join(root, 'vision-router.1.log')
  try {
    const sink = createFileLogSink({ file, backup, maxBytes: 120 })
    await sink.write('info', ['vision-router: first %s', 'message'])
    await sink.write('warn', ['vision-router: secret Bearer abcdefghijklmnopqrstuvwxyz'])
    await sink.write('error', ['vision-router: final message that forces bounded rotation'])
    await sink.flush()

    const current = await readFile(file, 'utf8')
    const previous = await readFile(backup, 'utf8')
    assert.match(current, /\[ERROR\].*final message/)
    assert.equal((current + previous).includes('abcdefghijklmnopqrstuvwxyz'), false)
    assert.match(previous, /vision-router:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('openLogDirectory uses the platform file manager with an argument array', async () => {
  const calls = []
  const exec = async (...args) => calls.push(args)
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-open-'))
  try {
    await openLogDirectory(root, { platform: 'darwin', exec })
    await openLogDirectory(root, { platform: 'win32', exec })
    await openLogDirectory(root, { platform: 'linux', exec })
    assert.deepEqual(calls.map(([command, args]) => [command, args]), [
      ['open', [root]],
      ['explorer.exe', [root]],
      ['xdg-open', [root]],
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

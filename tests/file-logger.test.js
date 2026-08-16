import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  createFileLogSink,
  installVisionRouterFileLogging,
  normalizeSettingsSaveDiagnostics,
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

test('settings-save diagnostics are bounded, single-line, and redacted', () => {
  const oversized = Array.from({ length: 20 }, (_value, index) => ({
    field: `field-${index}-` + 'x'.repeat(100),
    operation: 'set',
    reason: 'readback-mismatch',
    detail: 'y'.repeat(500),
  }))
  const diagnostics = normalizeSettingsSaveDiagnostics({
    failures: [
      {
        field: 'extraVisionModels\nforged',
        operation: 'set',
        reason: 'readback-mismatch',
        detail: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz\u0000\u001b\u0085\u2028second line',
      },
      null,
      { field: '', operation: 'unset', reason: 'write-error', detail: 'ignored' },
      ...oversized,
    ],
  })
  assert.deepEqual(diagnostics.slice(0, 1).map(({ field, operation, reason }) => ({ field, operation, reason })), [{
    field: 'extraVisionModels forged',
    operation: 'set',
    reason: 'readback-mismatch',
  }])
  assert.equal(diagnostics[0].detail.includes('abcdefghijklmnopqrstuvwxyz'), false)
  assert.doesNotMatch(diagnostics[0].detail, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
  assert.equal(diagnostics.length, 14)
  assert.equal(diagnostics.every(({ field, detail }) => field.length <= 80 && detail.length <= 400), true)

  const exactlyBounded = normalizeSettingsSaveDiagnostics({ failures: oversized })
  assert.equal(exactlyBounded.length, 16)
  assert.equal(exactlyBounded.every(({ field, detail }) => field.length === 80 && detail.length === 400), true)
})

test('settings-save diagnostic route enforces request boundaries and writes the plugin log', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-client-log-'))
  const routes = new Map()
  const hostLogs = []
  const ctx = {
    logger: {
      info(...args) { hostLogs.push(['info', ...args]) },
      warn(...args) { hostLogs.push(['warn', ...args]) },
    },
    inject(_services, install) {
      install({
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
        effect(effect) { return effect() },
      })
    },
  }
  const response = () => ({
    status: undefined,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) {
      this.status = status
      Object.assign(this.headers, headers)
    },
    end(body) { this.body = String(body ?? '') },
  })
  const request = (method, body = '', headers = {}) => {
    const req = Readable.from(body === '' ? [] : [body])
    req.method = method
    req.headers = headers
    return req
  }

  try {
    const installed = installVisionRouterFileLogging(ctx, { dshHome: root })
    const handler = routes.get('/_dsh/vision-router/settings-save-diagnostics')
    assert.equal(typeof handler, 'function')

    let res = response()
    await handler(request('GET'), res)
    assert.equal(res.status, 405)

    res = response()
    await handler(request('POST', '{}', {
      host: 'localhost:3000',
      origin: 'https://attacker.test',
      'sec-fetch-site': 'cross-site',
    }), res)
    assert.equal(res.status, 403)

    res = response()
    await handler(request('POST', 'x'.repeat(17 * 1024)), res)
    assert.equal(res.status, 413)

    res = response()
    await handler(request('POST', '{'), res)
    assert.equal(res.status, 400)

    res = response()
    await handler(request('POST', JSON.stringify({ failures: [{
      field: 'providers',
      operation: 'set',
      reason: 'readback-mismatch',
      detail: 'Bearer abcdefghijklmnopqrstuvwxyz',
    }] }), {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
    }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, count: 1 })

    await installed.sink.flush()
    const log = await readFile(installed.file, 'utf8')
    assert.match(log, /settings save failed field=providers operation=set reason=readback-mismatch/)
    assert.equal(log.includes('abcdefghijklmnopqrstuvwxyz'), false)
    assert.equal(JSON.stringify(hostLogs).includes('abcdefghijklmnopqrstuvwxyz'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createFileLogSink,
  installVisionRouterFileLogging,
} from '../lib/file-logger.js'

test('settings card exposes a one-click logs-folder action', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("openLogFolder: '打开日志文件夹'"), true)
  assert.equal(source.includes("openLogFolder: 'Open logs folder'"), true)
  assert.equal(source.includes("fetch('/_dsh/vision-router/logs'"), true)
  assert.equal(source.includes("method: 'POST'"), true)
})

test('settings UX keeps beginner guidance while using user-facing labels', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("quickStartTitle: '聊天和看图分别设置'"), true)
  assert.equal(source.includes("quickStartGuide: '重新查看新手引导'"), true)
  assert.equal(source.includes("onboardingStep1Title: '1 · 选择聊天模型'"), true)
  assert.equal(source.includes("onboardingStep2Title: '2 · 选择识图模型'"), true)
  assert.equal(source.includes("onboardingStep3Title: '3 · 设置备用模型'"), true)
  assert.equal(source.includes("chainLabel: '识图模型'"), true)
  assert.equal(source.includes("toggleRouting: '整轮交给视觉模型'"), true)
  assert.equal(source.includes("toggleStructuredVisionBootstrap: '结构化预识别（1+x，实验）'"), true)
  assert.equal(source.includes("toggleRewriteImages: '保护纯文字模型'"), true)
})

test('settings UX keeps engineering controls behind advanced groups', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("groupPerformance: '性能'"), true)
  assert.equal(source.includes("groupCompatibility: '兼容性'"), true)
  assert.equal(source.includes("groupNetwork: '网络'"), true)
  assert.equal(source.includes("groupDeveloper: '开发者设置'"), true)
  assert.equal(source.includes("className: 'vr-savebar'"), true)
  assert.equal(source.includes('width:max-content;max-width:100%'), true)
  assert.equal(source.includes('margin:0 -8px'), false)
  assert.equal(source.includes('backdrop-filter:blur(10px)'), false)
  assert.equal(source.includes("const TOGGLE_KEYS = ['autoWrapProviders', 'tool', 'structuredVisionBootstrap', 'routing']"), true)
  assert.equal(source.includes("const PERFORMANCE_TOGGLE_KEYS = ['downscale', 'cache']"), true)
  assert.equal(source.includes("const COMPATIBILITY_TOGGLE_KEYS = ['reverseRouting', 'rewriteImages', 'freeFallback']"), true)
  assert.equal(source.includes("const DEVELOPER_TOGGLE_KEYS = ['stealth']"), true)
})

test('settings UX puts model setup before advanced and diagnostics', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const renderStart = source.indexOf("return h('li', { className: 'vr-card'")
  assert.notEqual(renderStart, -1)
  const render = source.slice(renderStart)
  const quickStart = render.indexOf("t('quickStartTitle')")
  const primaryToggles = render.indexOf('TOGGLE_KEYS.map((key) => toggleField(key))')
  const visionChain = render.indexOf('chainEditor()')
  const testConnection = render.indexOf("t('testConnection')")
  const advanced = render.indexOf("t('advanced')")
  const developerControls = render.indexOf('DEVELOPER_TOGGLE_KEYS.map((key) => toggleField(key))')
  const diagnostics = render.indexOf("t('groupDiagnostics')")
  assert.equal(
    [quickStart, primaryToggles, visionChain, testConnection, advanced, developerControls, diagnostics].every((index) => index >= 0),
    true,
  )
  assert.equal(quickStart < primaryToggles, true)
  assert.equal(primaryToggles < visionChain, true)
  assert.equal(visionChain < testConnection, true)
  assert.equal(testConnection < advanced, true)
  assert.equal(advanced < developerControls, true)
  assert.equal(developerControls < diagnostics, true)
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

test('diagnostics sink bounds the in-memory backlog under a stalled filesystem writer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-log-pressure-'))
  const file = path.join(root, 'vision-router.log')
  const backup = path.join(root, 'vision-router.1.log')
  let first = true
  let releaseWrite
  let markStarted
  const blocked = new Promise((resolve) => { releaseWrite = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  const fsOps = {
    mkdir,
    rename,
    rm,
    stat,
    async appendFile(...args) {
      if (first) {
        first = false
        markStarted()
        await blocked
      }
      return appendFile(...args)
    },
  }
  try {
    const sink = createFileLogSink({
      file,
      backup,
      maxPendingEntries: 2,
      maxPendingBytes: 512,
      maxLineBytes: 256,
      fsOps,
    })
    void sink.write('info', ['first'])
    await started
    for (let i = 0; i < 20; i += 1) void sink.write('debug', [`queued-${i}-` + 'x'.repeat(80)])

    const underPressure = sink.stats()
    assert.ok(underPressure.pendingEntries <= 2)
    assert.ok(underPressure.pendingBytes <= 512)
    assert.ok(underPressure.dropped > 0)

    releaseWrite()
    await sink.flush()
    const log = await readFile(file, 'utf8')
    assert.match(log, /diagnostics backpressure dropped \d+ log message/)
    assert.equal(sink.stats().pendingEntries, 0)
    assert.equal(sink.stats().pendingBytes, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remote log metadata does not disclose host absolute paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-log-remote-'))
  let route
  const child = {
    webServer: {
      register(spec) {
        if (spec.path === '/_dsh/vision-router/logs') route = spec
        return () => {}
      },
    },
    effect(factory) { return factory() },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    inject(_deps, callback) { callback(child) },
    effect(factory) { return factory() },
  }
  const response = () => ({
    status: undefined,
    body: '',
    setHeader() {},
    writeHead(status) { this.status = status },
    end(body) { this.body = String(body ?? '') },
  })
  try {
    const installed = installVisionRouterFileLogging(ctx, { dshHome: root })
    assert.ok(route)

    let res = response()
    await route.handler(
      { method: 'GET', socket: { remoteAddress: '192.168.1.44' }, headers: {} },
      res,
    )
    const remote = JSON.parse(res.body)
    assert.equal(remote.ok, true)
    assert.equal(remote.local, false)
    assert.equal(remote.canOpen, false)
    assert.equal(remote.directory, undefined)
    assert.equal(remote.file, undefined)

    res = response()
    await route.handler(
      { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} },
      res,
    )
    const local = JSON.parse(res.body)
    assert.equal(local.local, true)
    assert.equal(local.directory, installed.directory)
    assert.equal(local.file, installed.file)
    await installed.sink.flush()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

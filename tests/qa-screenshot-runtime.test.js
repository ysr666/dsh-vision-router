import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { createSecureHtmlScreenshotExecute } from '../lib/adversarial-hardening.js'
import {
  captureDesktopPng,
  createDesktopScreenshotTool,
} from '../lib/desktop-screenshot-tool.js'
import { runWithVisionTurnBudget } from '../lib/turn-budget-context.js'
import {
  buildPerMonitorWindowsScreenshotScript,
  captureWindowsDesktop,
  createWindowsCaptureTempDir,
  isAsciiWindowsPath,
} from '../lib/windows-desktop-capture.js'

function screenshotHarness({ hangGoto = false } = {}) {
  const resolveCalls = []
  const sourceTarget = { targetKey: '/workspace/page.html', displayPath: '/workspace/page.html' }
  const workspaceTarget = { targetKey: '/workspace', displayPath: '/workspace' }
  let closeCalls = 0
  let artifactWrites = 0
  let rejectGoto

  const fs = {
    async resolve(value, options) {
      resolveCalls.push([value, options])
      if (value === '/workspace') return workspaceTarget
      if (value === 'page.html' && options?.cwd === '/workspace') return sourceTarget
      return { targetKey: '/default/page.html', displayPath: '/default/page.html' }
    },
    contains(parent, child) {
      return parent === workspaceTarget && child === sourceTarget
    },
  }

  const page = {
    async setViewport() {},
    async setOfflineMode() {},
    async setRequestInterception() {},
    on() {},
    async goto() {
      if (!hangGoto) return
      return new Promise((_resolve, reject) => { rejectGoto = reject })
    },
    async screenshot() { return Buffer.from('png') },
  }
  const browser = {
    async newPage() { return page },
    async close() {
      closeCalls += 1
      if (rejectGoto) {
        const reject = rejectGoto
        rejectGoto = undefined
        reject(new Error('browser closed'))
      }
    },
  }
  const launcher = { async launch() { return browser } }
  const ctx = { get(name) { return name === 'fs' ? fs : undefined } }
  const core = {
    toRealPath(_fs, target) { return target.targetKey },
    chromiumCandidates() { return ['/chrome'] },
    artifactStemOf() { return 'shot' },
  }
  const execute = createSecureHtmlScreenshotExecute(ctx, core, { artifactsDir: '.artifacts' }, {
    importPuppeteer: async () => launcher,
    existsSync: () => true,
    realpathSync: (value) => value,
    async mkdir() {},
    async writeFile() { artifactWrites += 1 },
  })

  return {
    execute,
    resolveCalls,
    get closeCalls() { return closeCalls },
    get artifactWrites() { return artifactWrites },
  }
}

test('secure screenshot renders the same session-cwd target that passed containment', async () => {
  const harness = screenshotHarness()
  const result = JSON.parse(await harness.execute({ source: 'page.html' }, {
    agent: { session: { header: { cwd: '/workspace' } } },
  }))

  assert.equal(result.path, path.resolve('/workspace/.artifacts/shot.png'))
  const sourceResolutions = harness.resolveCalls.filter(([value]) => value === 'page.html')
  assert.equal(sourceResolutions.length, 1, 'renderer must not resolve the source string a second time')
  assert.equal(sourceResolutions[0][1].cwd, '/workspace')
})

test('aborting an active secure screenshot closes Chrome and prevents artifact publication', async () => {
  const harness = screenshotHarness({ hangGoto: true })
  const controller = new AbortController()
  const pending = harness.execute({ source: 'page.html' }, {
    signal: controller.signal,
    agent: { session: { header: { cwd: '/workspace' } } },
  })

  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(
    pending,
    (error) => error?.code === 'ABORT_ERR',
  )
  assert.equal(harness.closeCalls, 1)
  assert.equal(harness.artifactWrites, 0)
})

test('desktop screenshot merges ambient and exec cancellation before OS capture', async () => {
  const ambient = new AbortController()
  const exec = new AbortController()
  exec.abort(new Error('desktop tool cancelled'))
  let captures = 0
  let artifactWrites = 0
  const tool = createDesktopScreenshotTool({
    current: () => ({ desktopScreenshot: true }),
    timeoutMs: () => 120000,
    async captureDesktop() {
      captures += 1
      return 'test'
    },
    async saveArtifact() {
      artifactWrites += 1
      return '/workspace/screenshot.png'
    },
    stringOutput: { type: 'string' },
    instantLocalStyle: () => 'structured',
  })

  await assert.rejects(
    runWithVisionTurnBudget(
      { signal: ambient.signal, deadlineAt: Date.now() + 120000 },
      () => tool.execute({}, { signal: exec.signal }),
    ),
    /desktop tool cancelled/,
  )
  assert.equal(captures, 0, 'a pre-aborted exec signal must not be hidden by a live ambient signal')
  assert.equal(artifactWrites, 0)
})

test('desktop screenshot aborts an in-flight capture and never publishes an artifact', async () => {
  const controller = new AbortController()
  let started
  const captureStarted = new Promise((resolve) => { started = resolve })
  let artifactWrites = 0
  const tool = createDesktopScreenshotTool({
    current: () => ({ desktopScreenshot: true }),
    timeoutMs: () => 120000,
    async captureDesktop(_target, _timeoutMs, signal) {
      started()
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return 'test'
    },
    async saveArtifact() {
      artifactWrites += 1
      return '/workspace/screenshot.png'
    },
    stringOutput: { type: 'string' },
    instantLocalStyle: () => 'plain',
  })

  const pending = tool.execute({}, { signal: controller.signal })
  await captureStarted
  controller.abort(new Error('capture cancelled'))
  await assert.rejects(pending, /capture cancelled/)
  assert.equal(artifactWrites, 0)
})

test('desktop screenshot cancellation during identify prevents artifact publication', async () => {
  const controller = new AbortController()
  let releaseStarted
  const identifyStarted = new Promise((resolve) => { releaseStarted = resolve })
  let artifactWrites = 0
  let requestSignal
  const tool = createDesktopScreenshotTool({
    current: () => ({
      desktopScreenshot: true,
      localOllama: {
        enabled: true,
        baseURL: 'http://127.0.0.1:11434/v1',
        model: 'test-vl',
        format: 'openai',
      },
    }),
    timeoutMs: () => 120000,
    async captureDesktop(target) {
      await writeFile(target, Buffer.from('png'))
      return 'test'
    },
    async saveArtifact() {
      artifactWrites += 1
      return '/workspace/screenshot.png'
    },
    stringOutput: { type: 'string' },
    instantLocalStyle: () => 'plain',
    providerTransport: {
      async fetch(_input, init) {
        requestSignal = init.signal
        releaseStarted()
        return new Promise((resolve, reject) => {
          const abort = () => reject(init.signal.reason)
          if (init.signal?.aborted) abort()
          else init.signal?.addEventListener('abort', abort, { once: true })
        })
      },
    },
  })

  const pending = tool.execute({ identify: true }, { signal: controller.signal })
  await identifyStarted
  controller.abort(new Error('identify cancelled'))
  await assert.rejects(pending, /identify cancelled/)
  assert.equal(requestSignal?.aborted, true)
  assert.equal(artifactWrites, 0, 'identify cancellation must happen before artifact publication')
})

test('platform desktop capture forwards cancellation to macOS and Linux child processes', async () => {
  const mac = new AbortController()
  let releaseMac
  const macStarted = new Promise((resolve) => { releaseMac = resolve })
  let macOptions
  const macPending = captureDesktopPng('/tmp/mac.png', 120000, mac.signal, {
    platform: 'darwin',
    async execFileAsync(file, args, options) {
      assert.equal(file, 'screencapture')
      assert.deepEqual(args, ['-x', '-m', '/tmp/mac.png'])
      macOptions = options
      releaseMac()
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    },
  })
  await macStarted
  mac.abort(new Error('mac capture cancelled'))
  await assert.rejects(macPending, /mac capture cancelled/)
  assert.equal(macOptions.signal, mac.signal)

  const linux = new AbortController()
  const calls = []
  await captureDesktopPng('/tmp/linux.png', 120000, linux.signal, {
    platform: 'linux',
    async execFileAsync(file, _args, options) {
      calls.push({ file, signal: options.signal })
      if (file === 'import') throw new Error('import unavailable')
      return { stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(calls.map((call) => call.file), ['import', 'scrot'])
  assert.ok(calls.every((call) => call.signal === linux.signal))
})

test('Windows desktop capture enters per-monitor v2 on the exact capture thread and restores it', () => {
  const script = buildPerMonitorWindowsScreenshotScript("C:\\shot's\\screen.png")
  const captureAt = script.indexOf('public static void Capture(string outputPath)')
  const enterAt = script.indexOf('IntPtr previous = EnterPerMonitorContext();', captureAt)
  const boundsAt = script.indexOf('Rectangle bounds = SystemInformation.VirtualScreen', enterAt)
  const copyAt = script.indexOf('graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size)', boundsAt)
  const restoreAt = script.indexOf('RestoreContext(previous);', copyAt)
  const pmv2At = script.indexOf('TrySetContext(PerMonitorV2)')
  const pmv1At = script.indexOf('TrySetContext(PerMonitorV1)', pmv2At)

  assert.ok(captureAt >= 0 && enterAt > captureAt && boundsAt > enterAt && copyAt > boundsAt && restoreAt > copyAt)
  assert.ok(pmv2At >= 0 && pmv1At > pmv2At, 'PMv1 is fallback only after PMv2 fails')
  assert.match(script, /PerMonitorV2 = new IntPtr\(-4\)/)
  assert.match(script, /PerMonitorV1 = new IntPtr\(-3\)/)
  assert.match(script, /finally/)
  assert.match(script, /bounds\.X, bounds\.Y/)
  assert.match(script, /refusing to return a potentially misaligned screenshot/)
  assert.doesNotMatch(script, /SetProcessDPIAware|SetProcessDpiAwarenessContext/)
  assert.match(script, /C:\\shot''s\\screen\.png/)
})

test('production Windows screenshot implementation owns PMv2 capture outside mature Core', async () => {
  const [core, screenshot, execCompat] = await Promise.all([
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/desktop-screenshot-tool.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/tesseract-exec-compat.js', import.meta.url), 'utf8'),
  ])

  assert.match(core, /import \{ createDesktopScreenshotTool \} from '\.\/lib\/desktop-screenshot-tool\.js'/)
  assert.match(core, /deepToolDefs\.push\(createDesktopScreenshotTool\(\{/ )
  assert.doesNotMatch(core, /captureWindowsDesktop|screencapture|ImageMagick import/)
  assert.match(screenshot, /import \{ captureWindowsDesktop \} from '\.\/windows-desktop-capture\.js'/)
  assert.match(screenshot, /const captureWindows = options\.captureWindowsDesktop \?\? captureWindowsDesktop/)
  assert.match(screenshot, /await captureWindows\(target, \{ timeoutMs, signal \}\)/)
  assert.doesNotMatch(screenshot, /\$b=\[System\.Windows\.Forms\.SystemInformation\]::VirtualScreen/)
  assert.doesNotMatch(screenshot, /\$g\.CopyFromScreen\(\$b\.X,\$b\.Y,0,0,\$bmp\.Size\)/)
  assert.doesNotMatch(execCompat, /rewriteWindowsScreenshotExecArgs/)
  assert.doesNotMatch(execCompat, /Windows DPI capture shims/)
})

test('Windows capture isolates CodeDom TEMP/TMP to a writable ASCII directory', async () => {
  const calls = []
  const made = []
  const removed = []
  const controller = new AbortController()
  const env = {
    TEMP: 'C:\\Users\\张三\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\张三\\AppData\\Local\\Temp',
    SystemRoot: 'C:\\Windows',
    KEEP_ME: 'yes',
  }
  const original = { ...env }

  await captureWindowsDesktop('C:\\Users\\张三\\AppData\\Local\\Temp\\screen.png', {
    env,
    tmpRoot: env.TEMP,
    timeoutMs: 4321,
    signal: controller.signal,
    async mkdtemp(prefix) {
      made.push(prefix)
      return `${prefix}ABC123`
    },
    async rm(dir, options) {
      removed.push({ dir, options })
    },
    async execFileAsync(file, args, options) {
      calls.push({ file, args, options })
      return { stdout: '', stderr: '' }
    },
  })

  assert.deepEqual(env, original, 'capture must never mutate process-style environment input')
  assert.equal(made.length, 1)
  assert.equal(made[0], 'C:\\Windows\\Temp\\dsh-vision-router-capture-')
  assert.equal(isAsciiWindowsPath(made[0]), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'powershell.exe')
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-STA', '-Command'])
  assert.match(calls[0].args[4], /PerMonitorV2/)
  assert.match(calls[0].args[4], /DshVisionDesktopCapture/)
  assert.match(calls[0].args[4], /C:\\Users\\张三\\AppData\\Local\\Temp\\screen\.png/)
  assert.equal(calls[0].options.timeout, 4321)
  assert.equal(calls[0].options.signal, controller.signal)
  assert.equal(calls[0].options.env.KEEP_ME, 'yes')
  assert.equal(calls[0].options.env.TEMP, 'C:\\Windows\\Temp\\dsh-vision-router-capture-ABC123')
  assert.equal(calls[0].options.env.TMP, calls[0].options.env.TEMP)
  assert.equal(calls[0].options.cwd, calls[0].options.env.TEMP)
  assert.equal(isAsciiWindowsPath(calls[0].options.env.TEMP), true)
  assert.equal(removed.length, 1)
  assert.equal(removed[0].dir, calls[0].options.env.TEMP)
  assert.equal(removed[0].options.recursive, true)
  assert.equal(removed[0].options.force, true)
})

test('Windows capture fails closed and never falls back to the legacy logical-coordinate script', async () => {
  const calls = []
  const removed = []
  await assert.rejects(
    captureWindowsDesktop('C:\\tmp\\screen.png', {
      env: { TEMP: 'C:\\Temp', SystemRoot: 'C:\\Windows' },
      tmpRoot: 'C:\\Temp',
      async mkdtemp(prefix) { return `${prefix}ABC123` },
      async rm(dir) { removed.push(dir) },
      async execFileAsync(file, args, options) {
        calls.push({ file, args, options })
        throw new Error('Add-Type failed')
      },
    }),
    (error) => error?.code === 'WINDOWS_DPI_CAPTURE_FAILED' && /Add-Type failed/.test(error.message),
  )

  assert.equal(calls.length, 1, 'a failed PMv2 capture must not trigger a second legacy attempt')
  assert.match(calls[0].args[4], /DshVisionDesktopCapture/)
  assert.doesNotMatch(calls[0].args[4], /\$b=\[System\.Windows\.Forms\.SystemInformation\]::VirtualScreen/)
  assert.equal(removed.length, 1)
})

test('Windows capture refuses to run when no writable ASCII CodeDom temp root exists', async () => {
  let executions = 0
  await assert.rejects(
    captureWindowsDesktop('C:\\tmp\\screen.png', {
      env: {
        TEMP: 'C:\\Users\\张三\\Temp',
        TMP: 'C:\\Users\\张三\\Temp',
        SystemRoot: 'C:\\Windows',
      },
      tmpRoot: 'C:\\Users\\张三\\Temp',
      async mkdtemp() { throw new Error('access denied') },
      async execFileAsync() { executions += 1 },
    }),
    (error) => error?.code === 'WINDOWS_CAPTURE_TEMP_UNAVAILABLE',
  )
  assert.equal(executions, 0)
})

test('Windows PowerShell compiles the helper with isolated ASCII TEMP/TMP and can enter/restore PM context', {
  skip: process.platform !== 'win32',
}, async () => {
  const scratch = await createWindowsCaptureTempDir()
  try {
    const script = buildPerMonitorWindowsScreenshotScript('C:\\unused\\dpi-context-probe.png').replace(
      /\[DshVisionDesktopCapture\]::Capture\([^\r\n]+\)\s*$/,
      '[DshVisionDesktopCapture]::ValidateDpiContext()',
    )
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      // Hosted Windows images occasionally cold-start Add-Type far slower than
      // the ~5s warm run. Keep this probe below product screenshot deadlines but
      // high enough that CI load is not mistaken for a DPI implementation bug.
      timeout: 60000,
      windowsHide: true,
      cwd: scratch,
      env: { ...process.env, TEMP: scratch, TMP: scratch },
    })
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

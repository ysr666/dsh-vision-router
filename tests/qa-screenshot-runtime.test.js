import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { createSecureHtmlScreenshotExecute } from '../lib/adversarial-hardening.js'
import {
  buildPerMonitorWindowsScreenshotScript,
  isLegacyWindowsScreenshotScript,
  rewriteWindowsScreenshotExecArgs,
} from '../lib/windows-screenshot-dpi-compat.js'
import { installVisionRouterExecFileCompat } from '../lib/tesseract-exec-compat.js'

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

function legacyDesktopScreenshotScript(outputPath) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)',
    `$bmp.Save('${String(outputPath).replace(/'/g, "''")}')`,
    '$g.Dispose();$bmp.Dispose()',
  ].join('; ')
}

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

test('the compatibility matcher stays pinned to the legacy screenshot command emitted by core', async () => {
  const core = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const assemblyAt = core.indexOf("'Add-Type -AssemblyName System.Windows.Forms,System.Drawing'")
  const boundsAt = core.indexOf("'$b=[System.Windows.Forms.SystemInformation]::VirtualScreen'", assemblyAt)
  const graphicsAt = core.indexOf("'$g=[System.Drawing.Graphics]::FromImage($bmp)'", boundsAt)
  const copyAt = core.indexOf("'$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)'", graphicsAt)
  const saveOffset = core.slice(copyAt).search(
    /`\$bmp\.Save\('\$\{tmp\.replace\(\/'\/g,\s*\\?"''\\?"\)\}'\)`/,
  )
  const saveAt = saveOffset < 0 ? -1 : copyAt + saveOffset

  assert.ok(
    assemblyAt >= 0 && boundsAt > assemblyAt && graphicsAt > boundsAt && copyAt > graphicsAt && saveAt > copyAt,
    'if core changes the legacy Windows capture command, update the exact compatibility matcher in the same change',
  )
  assert.equal(isLegacyWindowsScreenshotScript(legacyDesktopScreenshotScript('C:\\tmp\\shot.png')), true)
})

test('only the exact legacy Windows desktop screenshot command is rewritten', () => {
  const original = ['-NoProfile', '-STA', '-Command', legacyDesktopScreenshotScript('C:\\tmp\\shot.png')]
  const rewritten = rewriteWindowsScreenshotExecArgs('powershell.exe', original, { platform: 'win32' })
  assert.notEqual(rewritten, original)
  assert.match(rewritten[3], /DshVisionDesktopCapture/)

  assert.equal(rewriteWindowsScreenshotExecArgs('powershell.exe', original, { platform: 'linux' }), original)
  assert.equal(rewriteWindowsScreenshotExecArgs('cmd.exe', original, { platform: 'win32' }), original)
  const unrelated = ['-NoProfile', '-Command', 'Write-Output hello']
  assert.equal(rewriteWindowsScreenshotExecArgs('powershell.exe', unrelated, { platform: 'win32' }), unrelated)
})

test('the shared execFile seam rewrites desktop screenshot calls without disturbing unrelated calls', async () => {
  const calls = []
  const originalCustom = async (file, args, options) => {
    calls.push({ file, args, options })
    return { stdout: 'ok', stderr: '' }
  }
  const lockedExecFile = function lockedExecFile(_file, _args, _options, callback) {
    callback?.(null, 'callback-ok', '')
    return { pid: 1 }
  }
  Object.defineProperty(lockedExecFile, promisify.custom, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: originalCustom,
  })
  const fakeModule = { execFile: lockedExecFile }
  const dispose = installVisionRouterExecFileCompat(undefined, {
    childProcessModule: fakeModule,
    platform: 'win32',
  })

  try {
    await promisify(fakeModule.execFile)(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', legacyDesktopScreenshotScript("C:\\tmp\\O'Brien.png")],
      { timeout: 1000 },
    )
    await promisify(fakeModule.execFile)('node', ['--version'], {})
  } finally {
    dispose()
  }

  assert.equal(calls.length, 2)
  assert.match(calls[0].args[3], /PerMonitorV2/)
  assert.match(calls[0].args[3], /O''Brien\.png/)
  assert.deepEqual(calls[1].args, ['--version'])
  assert.equal(fakeModule.execFile, lockedExecFile)
})

test('Windows PowerShell compiles the helper and can enter and restore a per-monitor DPI context', {
  skip: process.platform !== 'win32',
}, async () => {
  const script = buildPerMonitorWindowsScreenshotScript('C:\\unused\\dpi-context-probe.png').replace(
    /\[DshVisionDesktopCapture\]::Capture\([^\r\n]+\)\s*$/,
    '[DshVisionDesktopCapture]::ValidateDpiContext()',
  )
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    // Hosted Windows images occasionally cold-start Add-Type far slower than
    // the ~5s warm run. Keep this probe below product screenshot deadlines but
    // high enough that CI load is not mistaken for a DPI implementation bug.
    timeout: 60000,
    windowsHide: true,
  })
})

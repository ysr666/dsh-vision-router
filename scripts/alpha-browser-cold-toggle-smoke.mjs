import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || join(here, '..'))
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')

const dshRequire = createRequire(join(dshRoot, 'package.json'))
const webRequire = createRequire(join(dshRoot, 'apps/web/package.json'))
const tsxLoader = pathToFileURL(dshRequire.resolve('tsx')).href
const cli = join(dshRoot, 'apps/cli/src/bin.ts')

function setOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return
  appendFileSync(output, `${name}=${String(value).replace(/[\r\n]+/g, ' ')}\n`)
}

function waitForReadyLine(child) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`dsh web not ready in 90s; output:\n${output}`))
    }, 90_000)
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(output)
      if (match?.[1]) {
        clearTimeout(timer)
        resolveReady(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited early (code ${code}); output:\n${output}`))
    })
  })
}

function installCurrentPlugin(env) {
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoader, cli, 'plugin', '--profile', 'web', 'add', `file:${dvrRoot}`],
    {
      cwd: dshRoot,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  )
  if (result.status !== 0) {
    throw new Error([
      `failed to install current dsh-vision-router checkout (exit ${result.status})`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
}

function classifyBrowserLaunch(message) {
  if (/executable.*(?:doesn['’]?t exist|not found)|ENOENT/i.test(message)) return 'browser-executable-missing'
  if (/error while loading shared libraries|cannot open shared object file/i.test(message)) return 'browser-missing-library'
  if (/sandbox|No usable sandbox|SUID sandbox/i.test(message)) return 'browser-sandbox'
  if (/browser.*(?:closed|crash)|Target page, context or browser has been closed/i.test(message)) return 'browser-process-crash'
  return 'browser-launch-other'
}

const root = mkdtempSync(join(tmpdir(), 'dvr-alpha-browser-smoke-'))
const env = {
  ...process.env,
  DSH_HOME: join(root, '.dsh'),
  DSH_AGENTS_HOME: join(root, '.agents'),
  DEEPSEEK_API_KEY: 'keyless-dvr-browser-smoke-no-call',
  TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.json'),
}

let stage = 'resolve-playwright'
let child
let browser
let diagnostics = []
let failureKind = 'harness-or-host'
let detail = 'none'
let failed = false

try {
  const { chromium } = await import(pathToFileURL(webRequire.resolve('playwright')).href)

  stage = 'plugin-install'
  installCurrentPlugin(env)

  stage = 'host-start'
  child = spawn(
    process.execPath,
    ['--import', tsxLoader, cli, 'web', '--no-open', '--port', '0'],
    {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const readyUrl = await waitForReadyLine(child)

  stage = 'browser-launch'
  const browserExecutable = chromium.executablePath()
  detail = existsSync(browserExecutable) ? 'executable-present' : 'executable-missing'
  if (!existsSync(browserExecutable)) {
    failureKind = 'browser-executable-missing'
    throw new Error(`Playwright Chromium executable does not exist: ${browserExecutable}`)
  }
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()

  page.on('pageerror', (error) => {
    diagnostics.push(`pageerror: ${error.message}`)
  })
  page.on('console', (message) => {
    const text = message.text()
    if (/remote\.session|without inject/i.test(text)) {
      diagnostics.push(`console ${message.type()}: ${text}`)
    }
  })

  stage = 'open-page'
  await page.goto(readyUrl)

  stage = 'new-session'
  const newSession = page.getByRole('button', { name: 'New session', exact: true }).first()
  await newSession.waitFor({ timeout: 30_000 })
  await newSession.click()

  stage = 'initial-toggle'
  const toggle = page.locator('[data-vision-router-mode-toggle="true"]')
  await toggle.waitFor({ state: 'visible', timeout: 30_000 })

  // A hard refresh recreates the browser-side ModelDirectoryResolver and its
  // cache. Do not open the stock model picker before waiting for the Vision
  // Router toggle: its slot injection must be able to perform the first cold
  // directoryFor(sessionId) call itself.
  stage = 'cold-reload'
  diagnostics = []
  await page.reload({ waitUntil: 'domcontentloaded' })

  stage = 'cold-toggle'
  await page.locator('[data-vision-router-mode-toggle="true"]').waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  await page.waitForTimeout(500)

  stage = 'diagnostics'
  const injectionErrors = diagnostics.filter((line) =>
    /cannot get property ["']remote\.session["'] without inject/i.test(line),
  )
  if (injectionErrors.length > 0) {
    failureKind = 'product-injection-regression'
    throw new Error(`cold Vision toggle hit the Cordis injection regression:\n${injectionErrors.join('\n')}`)
  }
  if (diagnostics.some((line) => line.startsWith('pageerror:'))) {
    failureKind = 'browser-pageerror'
    throw new Error(`browser pageerror during cold Vision toggle smoke:\n${diagnostics.join('\n')}`)
  }

  stage = 'complete'
  detail = 'passed'
  console.log(JSON.stringify({
    ok: true,
    dsh: process.env.DSH_EXPECTED_VERSION || 'unknown',
    dvr: 'current-checkout',
    toggleVisibleAfterColdReload: true,
  }))
} catch (error) {
  failed = true
  const message = error instanceof Error ? error.message : String(error)
  if (/cannot get property ["']remote\.session["'] without inject/i.test(message)) {
    failureKind = 'product-injection-regression'
  } else if (/pageerror:/i.test(message)) {
    failureKind = 'browser-pageerror'
  } else if (stage === 'browser-launch') {
    failureKind = classifyBrowserLaunch(message)
  }
  detail = `${detail}; ${message}`
  console.error(JSON.stringify({
    ok: false,
    stage,
    kind: failureKind,
    detail,
    diagnostics,
  }))
} finally {
  await browser?.close()
  if (child && child.exitCode === null) {
    const closed = new Promise((resolveClose) => child.once('close', resolveClose))
    child.kill('SIGTERM')
    await closed
  }
  rmSync(root, { recursive: true, force: true })
}

setOutput('status', failed ? 'fail' : 'pass')
setOutput('stage', stage)
setOutput('kind', failed ? failureKind : 'none')
setOutput('detail', detail)

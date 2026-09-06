import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

async function captureFailureState({ page, error, stage, kind, detail, diagnostics }) {
  const diagnosticPath = process.env.SMOKE_DIAGNOSTIC_PATH
  const screenshotPath = process.env.SMOKE_SCREENSHOT_PATH
  const captureErrors = []
  let pageState

  if (page) {
    try {
      pageState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        lang: document.documentElement.lang || null,
        readyState: document.readyState,
        buttons: Array.from(document.querySelectorAll('button')).slice(0, 50).map((button, index) => ({
          index,
          text: (button.innerText || '').trim().slice(0, 200),
          ariaLabel: button.getAttribute('aria-label'),
          title: button.getAttribute('title'),
          disabled: button.disabled,
          visible: Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
          outerHTML: button.outerHTML.slice(0, 800),
        })),
        inputs: Array.from(document.querySelectorAll('input, textarea')).slice(0, 30).map((input, index) => ({
          index,
          tag: input.tagName.toLowerCase(),
          value: 'value' in input ? String(input.value).slice(0, 500) : null,
          placeholder: input.getAttribute('placeholder'),
          ariaLabel: input.getAttribute('aria-label'),
          disabled: 'disabled' in input ? Boolean(input.disabled) : false,
          visible: Boolean(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
        })),
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).slice(0, 10).map((dialog, index) => ({
          index,
          text: (dialog.textContent || '').trim().slice(0, 2_000),
          ariaLabel: dialog.getAttribute('aria-label'),
          ariaLabelledBy: dialog.getAttribute('aria-labelledby'),
        })),
        bodyText: (document.body?.innerText || '').slice(0, 12_000),
      }))
    } catch (captureError) {
      captureErrors.push(`page-state: ${captureError instanceof Error ? captureError.message : String(captureError)}`)
    }

    if (screenshotPath) {
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true })
      } catch (captureError) {
        captureErrors.push(`screenshot: ${captureError instanceof Error ? captureError.message : String(captureError)}`)
      }
    }
  }

  const payload = {
    stage,
    kind,
    detail,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 8_000) : undefined,
    },
    diagnostics,
    page: pageState,
    captureErrors,
  }

  if (diagnosticPath) {
    try {
      writeFileSync(diagnosticPath, `${JSON.stringify(payload, null, 2)}\n`)
    } catch (captureError) {
      console.error(`failed to write smoke diagnostic: ${captureError instanceof Error ? captureError.message : String(captureError)}`)
    }
  }
  return payload
}

async function dismissFirstRunOverlays(page) {
  // A fresh DSH_HOME intentionally exercises first-run UI. Dismiss the Vision
  // Router onboarding through its real secondary action instead of force-clicking
  // through the backdrop: the smoke must preserve browser pointer semantics.
  const vrOnboarding = page.locator('.vr-onboarding-backdrop')
  try {
    await vrOnboarding.waitFor({ state: 'visible', timeout: 5_000 })
  } catch (_) {}
  if (await vrOnboarding.isVisible()) {
    await vrOnboarding.locator('.vr-onboarding-secondary').click()
    await vrOnboarding.waitFor({ state: 'hidden', timeout: 15_000 })
  }

  // Exact alpha.4 also shows its versioned internal-testing notice on a fresh
  // profile. The Playwright context is pinned to en-US, so use the exact owner
  // copy from that pinned DSH source and wait for the persisted acknowledgement
  // to close the modal before touching the sidebar.
  const welcome = page.getByRole('dialog', { name: 'Internal Testing Notice', exact: true })
  try {
    await welcome.waitFor({ state: 'visible', timeout: 5_000 })
  } catch (_) {}
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Continue', exact: true }).click()
    await welcome.waitFor({ state: 'hidden', timeout: 30_000 })
  }
}

async function adoptRealWorkspace(page, workspacePath) {
  // With zero registered Workspaces, exact alpha.4 consumes the hero's
  // "Choose workspace" request directly into the occupied directory-flow
  // instead of rendering a one-item "Add workspace…" menu. On headless Linux
  // directory-picker-auto resolves to the in-app browse backend, so this is a
  // real Host-backed workspace mutation without an OS chooser or RPC shortcut.
  const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace', exact: true })
  await chooseWorkspace.waitFor({ state: 'visible', timeout: 30_000 })
  await chooseWorkspace.click()

  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.waitFor({ state: 'visible', timeout: 30_000 })

  const editPath = picker.getByRole('button', { name: 'Edit path', exact: true })
  await editPath.waitFor({ state: 'visible', timeout: 30_000 })
  await editPath.click()

  const pathInput = picker.getByRole('textbox', { name: 'Edit path', exact: true })
  await pathInput.waitFor({ state: 'visible', timeout: 10_000 })
  await pathInput.fill(workspacePath)
  await pathInput.press('Enter')
  // Successful submitted navigation closes the path editor. Waiting for that
  // edge proves the Host resolved the exact path before Open can adopt it.
  await pathInput.waitFor({ state: 'hidden', timeout: 30_000 })

  const open = picker.getByRole('button', { name: 'Open', exact: true })
  // Open is disabled while navigation/loading/draft state is pending, so its
  // ordinary click actionability wait prevents accidentally adopting the old
  // home-directory target.
  await open.click({ timeout: 30_000 })
  await picker.waitFor({ state: 'hidden', timeout: 30_000 })
}

const root = mkdtempSync(join(tmpdir(), 'dvr-alpha-browser-smoke-'))
const workspacePath = join(root, 'workspace')
mkdirSync(workspacePath)
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
let page
let diagnostics = []
let failureKind = 'harness-or-host'
let detail = 'none'
let failed = false

try {
  // Resolve and load Playwright from the exact DSH web workspace package.
  // createRequire preserves the package's CommonJS/conditional-export shape;
  // importing its resolved entry URL can expose only `default` under Node 22,
  // leaving a named `chromium` destructure undefined.
  const playwright = webRequire('playwright')
  const chromium = playwright?.chromium
  if (
    !chromium ||
    typeof chromium.executablePath !== 'function' ||
    typeof chromium.launch !== 'function'
  ) {
    throw new Error('Playwright chromium API is unavailable from @deepseek-ai/dsh-web-frontend')
  }

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
  page = await context.newPage()

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

  stage = 'first-run-overlays'
  await dismissFirstRunOverlays(page)

  stage = 'new-session'
  const newSession = page.getByRole('button', { name: 'New session', exact: true }).first()
  await newSession.waitFor({ timeout: 30_000 })
  await newSession.click()

  stage = 'workspace-picker'
  await adoptRealWorkspace(page, workspacePath)

  stage = 'workspace-adopt'
  // The hero's workspace-blocked placeholder is the exact alpha.4 signal that
  // the Session Intent still lacks a target. Its replacement proves the real
  // Workspace has been adopted before we attribute a missing toggle to DVR.
  await page.getByPlaceholder('Describe what you want to build... / commands, @ files or sessions', {
    exact: true,
  }).waitFor({ state: 'visible', timeout: 30_000 })

  stage = 'session-scope'
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
    workspaceAdopted: true,
    sessionScopedComposerVisible: true,
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
  const failureState = await captureFailureState({
    page,
    error,
    stage,
    kind: failureKind,
    detail,
    diagnostics,
  })
  console.error(JSON.stringify({
    ok: false,
    ...failureState,
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

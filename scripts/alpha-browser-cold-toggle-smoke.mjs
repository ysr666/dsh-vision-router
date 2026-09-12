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
  const vrOnboarding = page.locator('.vr-onboarding-backdrop')
  try {
    await vrOnboarding.waitFor({ state: 'visible', timeout: 5_000 })
  } catch (_) {}
  if (await vrOnboarding.isVisible()) {
    await vrOnboarding.locator('.vr-onboarding-secondary').click()
    await vrOnboarding.waitFor({ state: 'hidden', timeout: 15_000 })
  }

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
  // Exact alpha.4 consumes the zero-workspace hero request directly into its
  // only directory flow. Headless Linux resolves the auto picker to the
  // in-app browse backend, so this remains a real Host-backed UI mutation.
  const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace', exact: true })
  await chooseWorkspace.waitFor({ state: 'visible', timeout: 30_000 })
  await chooseWorkspace.click()

  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.waitFor({ state: 'visible', timeout: 30_000 })
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()

  const pathInput = picker.getByRole('textbox', { name: 'Edit path', exact: true })
  await pathInput.waitFor({ state: 'visible', timeout: 10_000 })
  await pathInput.fill(workspacePath)
  await pathInput.press('Enter')
  // Successful submitted navigation closes the editor only after the Host has
  // resolved the requested path.
  await pathInput.waitFor({ state: 'hidden', timeout: 30_000 })

  // Open stays disabled while navigation/draft state is pending. Ordinary
  // Playwright actionability therefore prevents adopting the stale home path.
  await picker.getByRole('button', { name: 'Open', exact: true }).click({ timeout: 30_000 })
  await picker.waitFor({ state: 'hidden', timeout: 30_000 })
}

async function selectedWorkspaceName(page) {
  const selector = page.getByRole('button', { name: 'Choose workspace', exact: true })
  await selector.waitFor({ state: 'visible', timeout: 30_000 })
  return { selector, name: (await selector.innerText()).trim() }
}

async function assertVisionToggleSettledWithPair(toggle, phase) {
  const deadline = Date.now() + 10_000
  let state
  while (Date.now() < deadline) {
    state = await toggle.evaluate((element) => ({
      disabled: Boolean(element.disabled),
      title: element.getAttribute('title') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
    }))
    const detail = `${state.title}
${state.ariaLabel}`
    if (/No matching.*Auto Vision|没有对应.*自动识图/i.test(detail)) {
      const error = new Error(`${phase} Vision toggle has no matching Vision Router twin: ${detail.trim()}`)
      error.code = 'VISION_TWIN_UNAVAILABLE'
      throw error
    }
    if (!/Loading model information|正在读取模型信息/i.test(detail)) return state
    await toggle.page().waitForTimeout(250)
  }
  const error = new Error(`${phase} Vision toggle did not settle its model directory in 10s`)
  error.code = 'VISION_TWIN_DIRECTORY_TIMEOUT'
  throw error
}

async function ensureExistingWorkspaceSelected(page, expectedName) {
  let current = await selectedWorkspaceName(page)
  if (current.name === expectedName) return

  await current.selector.click()
  const item = page.getByRole('menuitem', { name: expectedName, exact: true })
  await item.waitFor({ state: 'visible', timeout: 30_000 })
  await item.click()

  current = await selectedWorkspaceName(page)
  if (current.name !== expectedName) {
    throw new Error(`workspace selection did not project ${JSON.stringify(expectedName)} (got ${JSON.stringify(current.name)})`)
  }
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
  const playwright = webRequire('playwright')
  const chromium = playwright?.chromium
  if (!chromium || typeof chromium.executablePath !== 'function' || typeof chromium.launch !== 'function') {
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

  // Only the real Workspace-to-Session transition onward belongs to #387's
  // cold model-directory seam.
  diagnostics = []
  stage = 'workspace-picker'
  await adoptRealWorkspace(page, workspacePath)

  stage = 'workspace-adopt'
  // Prove the Host mutation landed through an alpha.4-owned projection instead
  // of coupling this smoke to the composer's editor implementation.
  await ensureExistingWorkspaceSelected(page, 'workspace')

  // Acceptance edge: exact alpha.4 InputBar renders conversation.input.right
  // before conversation.input.model. DVR registers the Vision toggle in the
  // right slot; the stock model seat is the next consumer of the same
  // per-session ModelDirectory. This first fresh Session Intent is a baseline
  // that proves the real browser path is healthy before the required reload.
  stage = 'session-scope'
  const toggle = page.locator('[data-vision-router-mode-toggle="true"]')
  await toggle.waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(750)
  const firstToggleState = await assertVisionToggleSettledWithPair(toggle, 'first session')

  let injectionErrors = diagnostics.filter((line) =>
    /cannot get property ["']remote\.session["'] without inject/i.test(line),
  )
  if (injectionErrors.length > 0) {
    failureKind = 'product-injection-regression'
    throw new Error(`first cold Vision toggle hit the Cordis injection regression:\n${injectionErrors.join('\n')}`)
  }
  if (diagnostics.some((line) => line.startsWith('pageerror:'))) {
    failureKind = 'browser-pageerror'
    throw new Error(`browser pageerror during first cold Vision toggle smoke:\n${diagnostics.join('\n')}`)
  }

  // #387 explicitly requires a real Host retest after page refresh. An unsent
  // Session Intent is intentionally page-local, so do not expect that draft
  // intent to survive reload. Reload the browser (cold ModelDirectoryResolver),
  // then create a NEW Session Intent against the persisted real Workspace.
  stage = 'cold-reload'
  diagnostics = []
  await page.reload({ waitUntil: 'domcontentloaded' })

  stage = 'cold-overlays'
  await dismissFirstRunOverlays(page)

  stage = 'cold-session-intent'
  const coldNewSession = page.getByRole('button', { name: 'New session', exact: true }).first()
  await coldNewSession.waitFor({ state: 'visible', timeout: 30_000 })
  await coldNewSession.click()

  stage = 'cold-workspace'
  await ensureExistingWorkspaceSelected(page, 'workspace')

  // Do not open the stock model picker. The Vision slot must be the first
  // consumer that can cold-resolve this session-scoped model directory.
  stage = 'cold-toggle'
  const coldToggle = page.locator('[data-vision-router-mode-toggle="true"]')
  await coldToggle.waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  await page.waitForTimeout(750)
  const coldToggleState = await assertVisionToggleSettledWithPair(coldToggle, 'refreshed session')

  stage = 'diagnostics'
  injectionErrors = diagnostics.filter((line) =>
    /cannot get property ["']remote\.session["'] without inject/i.test(line),
  )
  if (injectionErrors.length > 0) {
    failureKind = 'product-injection-regression'
    throw new Error(`refreshed cold Vision toggle hit the Cordis injection regression:\n${injectionErrors.join('\n')}`)
  }
  if (diagnostics.some((line) => line.startsWith('pageerror:'))) {
    failureKind = 'browser-pageerror'
    throw new Error(`browser pageerror during refreshed cold Vision toggle smoke:\n${diagnostics.join('\n')}`)
  }

  stage = 'complete'
  detail = 'passed'
  console.log(JSON.stringify({
    ok: true,
    dsh: process.env.DSH_EXPECTED_VERSION || 'unknown',
    dvr: 'current-checkout',
    workspaceAdoptedThroughRealUi: true,
    firstSessionIntentVisionToggleVisible: true,
    refreshedSessionIntentVisionToggleVisible: true,
    firstSessionVisionToggleState: firstToggleState,
    refreshedSessionVisionToggleState: coldToggleState,
    nativeModelPickerOpened: false,
    modelRequestSent: false,
  }))
} catch (error) {
  failed = true
  const message = error instanceof Error ? error.message : String(error)
  if (error && (error.code === 'VISION_TWIN_UNAVAILABLE' || error.code === 'VISION_TWIN_DIRECTORY_TIMEOUT')) {
    failureKind = 'vision-twin-unavailable'
  } else if (/cannot get property ["']remote\.session["'] without inject/i.test(message)) {
    failureKind = 'product-injection-regression'
  } else if (/pageerror:/i.test(message)) {
    failureKind = 'browser-pageerror'
  } else if (stage === 'browser-launch') {
    failureKind = classifyBrowserLaunch(message)
  }
  detail = `${detail}; ${message}`
  const failureState = await captureFailureState({ page, error, stage, kind: failureKind, detail, diagnostics })
  console.error(JSON.stringify({ ok: false, ...failureState }))
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

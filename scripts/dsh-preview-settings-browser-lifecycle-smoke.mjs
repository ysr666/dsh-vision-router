import assert from 'node:assert/strict'
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

function installCurrentPlugin(env) {
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoader, cli, 'plugin', '--profile', 'web', 'add', `file:${dvrRoot}`],
    { cwd: dshRoot, env, encoding: 'utf8', stdio: 'pipe' },
  )
  if (result.status !== 0) {
    throw new Error([
      `failed to install current dsh-vision-router checkout (exit ${result.status})`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
}

function waitForReadyLine(child) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`dsh web not ready in 90s; output:\n${output}`)), 90_000)
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

async function dismissFirstRunOverlays(page) {
  const vrOnboarding = page.locator('.vr-onboarding-backdrop')
  try { await vrOnboarding.waitFor({ state: 'visible', timeout: 5_000 }) } catch (_) {}
  if (await vrOnboarding.isVisible()) {
    await vrOnboarding.locator('.vr-onboarding-secondary').click()
    await vrOnboarding.waitFor({ state: 'hidden', timeout: 15_000 })
  }

  const notice = page.getByRole('dialog', { name: 'Internal Testing Notice', exact: true })
  try { await notice.waitFor({ state: 'visible', timeout: 5_000 }) } catch (_) {}
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: 'Continue', exact: true }).click()
    await notice.waitFor({ state: 'hidden', timeout: 30_000 })
  }
}

async function openVisionRouterSettings(page) {
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  await settings.waitFor({ state: 'visible', timeout: 30_000 })
  await settings.click()

  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ state: 'visible', timeout: 15_000 })

  const nav = dialog.getByRole('button', { name: 'Vision Router', exact: true })
  await nav.waitFor({ state: 'visible', timeout: 15_000 })
  assert.equal(await nav.count(), 1, 'Settings must expose exactly one first-class Vision Router section')
  await nav.click()

  const root = dialog.locator('[data-vr-settings-ia="1"]')
  await root.waitFor({ state: 'visible', timeout: 15_000 })
  assert.equal(await root.count(), 1, 'Vision Router Settings 2.0 must mount exactly once')
  assert.equal(await root.getAttribute('data-vr-dirty'), '0')
  assert.equal(await root.getAttribute('data-vr-invalid'), '0')
  return { dialog, root }
}

async function openStrategyCard(root) {
  const card = root.locator('li.vr-ia-plugin-card').filter({ hasText: 'Vision strategy' }).first()
  await card.waitFor({ state: 'visible', timeout: 15_000 })
  const header = card.locator('button.vr-ia-plugin-card-header')
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await card.locator('.vr-ia-plugin-card-body').waitFor({ state: 'visible', timeout: 10_000 })
  return card
}

async function strategyControls(card) {
  const structuredRow = card.locator('.vr-field').filter({ hasText: 'Structured pre-scan (1+x, experimental)' }).first()
  await structuredRow.waitFor({ state: 'visible', timeout: 10_000 })
  const structured = structuredRow.locator('input[type="checkbox"]').first()
  await structured.waitFor({ state: 'attached', timeout: 10_000 })

  return {
    structured,
    depth: async () => {
      const field = card.locator('.vr-field').filter({ hasText: 'Vision depth' }).first()
      await field.waitFor({ state: 'visible', timeout: 10_000 })
      const select = field.locator('select').first()
      await select.waitFor({ state: 'visible', timeout: 10_000 })
      return select
    },
  }
}

async function captureFailure(page, stage, error, diagnostics) {
  const payload = {
    stage,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 8_000) } : String(error),
    diagnostics,
  }
  if (page) {
    try {
      payload.page = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || '').slice(0, 16_000),
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((dialog) => ({
          ariaLabel: dialog.getAttribute('aria-label'),
          text: (dialog.textContent || '').slice(0, 8_000),
        })),
      }))
    } catch (_) {}
    if (process.env.SMOKE_SCREENSHOT_PATH) {
      try { await page.screenshot({ path: process.env.SMOKE_SCREENSHOT_PATH, fullPage: true }) } catch (_) {}
    }
  }
  if (process.env.SMOKE_DIAGNOSTIC_PATH) {
    try { writeFileSync(process.env.SMOKE_DIAGNOSTIC_PATH, `${JSON.stringify(payload, null, 2)}\n`) } catch (_) {}
  }
}

const rootDir = mkdtempSync(join(tmpdir(), 'dvr-settings-browser-smoke-'))
const workspacePath = join(rootDir, 'workspace')
mkdirSync(workspacePath)
const env = {
  ...process.env,
  DSH_HOME: join(rootDir, '.dsh'),
  DSH_AGENTS_HOME: join(rootDir, '.agents'),
  DEEPSEEK_API_KEY: 'keyless-dvr-settings-smoke-no-call',
  TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.json'),
}

let child
let browser
let page
let stage = 'resolve-playwright'
const diagnostics = []

try {
  const playwright = webRequire('playwright')
  const chromium = playwright?.chromium
  if (!chromium || typeof chromium.launch !== 'function' || typeof chromium.executablePath !== 'function') {
    throw new Error('Playwright chromium API is unavailable from @deepseek-ai/dsh-web-frontend')
  }
  if (!existsSync(chromium.executablePath())) {
    throw new Error(`Playwright Chromium executable does not exist: ${chromium.executablePath()}`)
  }

  stage = 'plugin-install'
  installCurrentPlugin(env)

  stage = 'host-start'
  child = spawn(
    process.execPath,
    ['--import', tsxLoader, cli, 'web', '--no-open', '--port', '0'],
    { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const readyUrl = await waitForReadyLine(child)

  stage = 'browser-launch'
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US' })
  page = await context.newPage()
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console error: ${message.text()}`)
  })

  stage = 'open-page'
  await page.goto(readyUrl, { waitUntil: 'domcontentloaded' })
  await dismissFirstRunOverlays(page)

  stage = 'settings-mount'
  let { dialog, root } = await openVisionRouterSettings(page)

  stage = 'settings-edit'
  let strategy = await openStrategyCard(root)
  let controls = await strategyControls(strategy)
  assert.equal(await controls.structured.isChecked(), false, 'structured pre-scan must start at the default false value')
  await controls.structured.click()
  const depth = await controls.depth()
  assert.equal(await depth.inputValue(), 'standard', 'vision depth must start at the default standard value')
  await depth.selectOption('fast')
  assert.equal(await root.getAttribute('data-vr-dirty'), '1', 'editing Settings must mark the IA dirty')

  stage = 'settings-save'
  const save = strategy.locator('button.vr-ia-save')
  await save.waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(await save.isEnabled(), true, 'strategy save must be enabled for a valid dirty edit')
  await save.click()
  await page.waitForFunction(() => {
    const mounted = document.querySelector('[data-vr-settings-ia="1"]')
    return mounted?.getAttribute('data-vr-dirty') === '0'
  }, undefined, { timeout: 15_000 })
  assert.equal(await strategy.locator('button.vr-ia-plugin-card-header').getAttribute('aria-expanded'), 'false')

  stage = 'settings-reload'
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissFirstRunOverlays(page)

  stage = 'settings-readback'
  ;({ dialog, root } = await openVisionRouterSettings(page))
  strategy = await openStrategyCard(root)
  controls = await strategyControls(strategy)
  assert.equal(await controls.structured.isChecked(), true, 'structured pre-scan must persist through a real Host/browser reload')
  const reloadedDepth = await controls.depth()
  assert.equal(await reloadedDepth.inputValue(), 'fast', 'vision depth must persist through a real Host/browser reload')
  assert.equal(await root.getAttribute('data-vr-dirty'), '0')
  assert.equal(await root.getAttribute('data-vr-invalid'), '0')

  const pageErrors = diagnostics.filter((line) => line.startsWith('pageerror:'))
  assert.deepEqual(pageErrors, [], `Settings lifecycle emitted browser page errors:\n${pageErrors.join('\n')}`)

  console.log(JSON.stringify({
    ok: true,
    dsh: process.env.DSH_EXPECTED_VERSION || 'unknown',
    settingsSection: 'vision-router',
    structuredVisionBootstrap: true,
    visionDepth: 'fast',
    reloaded: true,
  }))
  setOutput('status', 'pass')
} catch (error) {
  setOutput('status', 'fail')
  setOutput('stage', stage)
  setOutput('detail', error instanceof Error ? error.message : String(error))
  await captureFailure(page, stage, error, diagnostics)
  throw error
} finally {
  try { await browser?.close() } catch (_) {}
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM') } catch (_) {}
    await new Promise((resolveDone) => {
      const timer = setTimeout(resolveDone, 5_000)
      child.once('exit', () => { clearTimeout(timer); resolveDone() })
    })
  }
  rmSync(rootDir, { recursive: true, force: true })
}

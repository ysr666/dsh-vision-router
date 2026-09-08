import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

function waitForReadyLine(child) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`dsh web not ready in 90s; output:\n${output}`)), 90_000)
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(output)
      if (!match?.[1]) return
      clearTimeout(timer)
      resolveReady(match[1])
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

async function dismissFirstRunOverlays(page) {
  const vrOnboarding = page.locator('.vr-onboarding-backdrop')
  try { await vrOnboarding.waitFor({ state: 'visible', timeout: 5_000 }) } catch {}
  if (await vrOnboarding.isVisible()) {
    await vrOnboarding.locator('.vr-onboarding-secondary').click()
    await vrOnboarding.waitFor({ state: 'hidden', timeout: 15_000 })
  }

  const welcome = page.getByRole('dialog', { name: 'Internal Testing Notice', exact: true })
  try { await welcome.waitFor({ state: 'visible', timeout: 5_000 }) } catch {}
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Continue', exact: true }).click()
    await welcome.waitFor({ state: 'hidden', timeout: 30_000 })
  }
}

async function adoptRealWorkspace(page, workspacePath) {
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
  await pathInput.waitFor({ state: 'hidden', timeout: 30_000 })
  await picker.getByRole('button', { name: 'Open', exact: true }).click({ timeout: 30_000 })
  await picker.waitFor({ state: 'hidden', timeout: 30_000 })
}

async function dispatchMixedPaste(page) {
  await page.evaluate(() => {
    const target = document.querySelector('[data-composer-input]')
    if (!(target instanceof HTMLElement)) throw new Error('composer input not found')

    const fromBase64 = (value) => {
      const raw = atob(value)
      const bytes = new Uint8Array(raw.length)
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
      return bytes
    }

    // Valid 1x1 PNG bytes deliberately mislabeled as JPEG. Router must sniff
    // and retype this file, which forces its async synthetic paste replay path.
    const png = fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    const image = new File([png], 'mixed.jpg', { type: 'image/jpeg', lastModified: 7 })
    const pdf = new File([
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    ], 'mixed.pdf', { type: 'application/pdf', lastModified: 8 })
    // Empty MIME is intentional: latest DSH generic-file intake must preserve
    // ordinary files even when the browser provides no useful media type.
    const unknown = new File(['generic-file-with-empty-mime'], 'mystery.fixture', {
      type: '',
      lastModified: 9,
    })

    const transfer = new DataTransfer()
    transfer.items.add(image)
    transfer.items.add(pdf)
    transfer.items.add(unknown)
    transfer.setData('text/plain', 'mixed paste text survives')
    target.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
      composed: true,
    }))
  })
}

const root = mkdtempSync(join(tmpdir(), 'dvr-alpha-mixed-paste-'))
const workspacePath = join(root, 'workspace')
mkdirSync(workspacePath)
const env = {
  ...process.env,
  DSH_HOME: join(root, '.dsh'),
  DSH_AGENTS_HOME: join(root, '.agents'),
  DEEPSEEK_API_KEY: 'keyless-dvr-mixed-paste-no-call',
  TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.json'),
}

let child
let browser
let page
const pageErrors = []

try {
  const playwright = webRequire('playwright')
  const chromium = playwright?.chromium
  if (!chromium || typeof chromium.executablePath !== 'function' || typeof chromium.launch !== 'function') {
    throw new Error('Playwright chromium API is unavailable from @deepseek-ai/dsh-web-frontend')
  }

  installCurrentPlugin(env)
  child = spawn(
    process.execPath,
    ['--import', tsxLoader, cli, 'web', '--no-open', '--port', '0'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const readyUrl = await waitForReadyLine(child)

  const browserExecutable = chromium.executablePath()
  if (!existsSync(browserExecutable)) throw new Error(`Playwright Chromium executable does not exist: ${browserExecutable}`)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.goto(readyUrl)
  await dismissFirstRunOverlays(page)
  const newSession = page.getByRole('button', { name: 'New session', exact: true }).first()
  await newSession.waitFor({ state: 'visible', timeout: 30_000 })
  await newSession.click()
  await adoptRealWorkspace(page, workspacePath)

  const composer = page.locator('[data-composer-input]').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await dispatchMixedPaste(page)

  await page.waitForFunction(() => {
    const input = document.querySelector('[data-composer-input]')
    return input?.textContent?.includes('mixed paste text survives') === true
  }, undefined, { timeout: 30_000 })

  const image = page.locator('img[alt="mixed.png"]')
  const pdf = page.locator('[title="mixed.pdf"]')
  const unknown = page.locator('[title="mystery.fixture"]')
  await image.waitFor({ state: 'visible', timeout: 30_000 })
  await pdf.waitFor({ state: 'visible', timeout: 30_000 })
  await unknown.waitFor({ state: 'visible', timeout: 30_000 })

  assert.equal(await image.count(), 1, 'Router replay must produce exactly one normalized image draft')
  assert.equal(await pdf.count(), 1, 'Router replay must preserve exactly one PDF draft')
  assert.equal(await unknown.count(), 1, 'Router replay must preserve exactly one empty-MIME generic file draft')

  // Generic files upload in the background in 0.1.3. A ready card shows its
  // extension/size; the uploading card shows localized upload status instead.
  await page.waitForFunction(() => {
    const ready = (title, extension) => {
      const card = document.querySelector(`[title="${title}"]`)
      const text = card?.textContent ?? ''
      return text.includes(extension) && !/uploading|上传/i.test(text)
    }
    return ready('mixed.pdf', 'PDF') && ready('mystery.fixture', 'FIXTURE')
  }, undefined, { timeout: 30_000 })

  assert.deepEqual(pageErrors, [], `mixed attachment paste emitted browser pageerrors: ${pageErrors.join(' | ')}`)
  console.log(JSON.stringify({
    ok: true,
    dsh: process.env.DSH_EXPECTED_VERSION || 'unknown',
    normalizedImage: 'mixed.png',
    genericFiles: ['mixed.pdf', 'mystery.fixture'],
    textPreserved: true,
    duplicateDrafts: false,
    genericUploadsReachedReady: true,
  }))
} finally {
  try { await browser?.close() } catch {}
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise(resolveExit => {
      const timer = setTimeout(resolveExit, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  rmSync(root, { recursive: true, force: true })
}

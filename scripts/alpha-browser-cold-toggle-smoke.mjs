import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
const { chromium } = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const cli = join(dshRoot, 'apps/cli/src/bin.ts')

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

const root = mkdtempSync(join(tmpdir(), 'dvr-alpha-browser-smoke-'))
const env = {
  ...process.env,
  DSH_HOME: join(root, '.dsh'),
  DSH_AGENTS_HOME: join(root, '.agents'),
  DEEPSEEK_API_KEY: 'keyless-dvr-browser-smoke-no-call',
  TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.json'),
}

let child
let browser
try {
  installCurrentPlugin(env)
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
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  const diagnostics = []

  page.on('pageerror', (error) => {
    diagnostics.push(`pageerror: ${error.message}`)
  })
  page.on('console', (message) => {
    const text = message.text()
    if (/remote\.session|without inject/i.test(text)) {
      diagnostics.push(`console ${message.type()}: ${text}`)
    }
  })

  await page.goto(readyUrl)
  const newSession = page.getByRole('button', { name: 'New session', exact: true }).first()
  await newSession.waitFor({ timeout: 30_000 })
  await newSession.click()

  const toggle = page.locator('[data-vision-router-mode-toggle="true"]')
  await toggle.waitFor({ state: 'visible', timeout: 30_000 })

  // A hard refresh recreates the browser-side ModelDirectoryResolver and its
  // cache. Do not open the stock model picker before waiting for the Vision
  // Router toggle: its slot injection must be able to perform the first cold
  // directoryFor(sessionId) call itself.
  diagnostics.length = 0
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-vision-router-mode-toggle="true"]').waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  await page.waitForTimeout(500)

  const injectionErrors = diagnostics.filter((line) =>
    /cannot get property ["']remote\.session["'] without inject/i.test(line),
  )
  if (injectionErrors.length > 0) {
    throw new Error(`cold Vision toggle hit the Cordis injection regression:\n${injectionErrors.join('\n')}`)
  }
  if (diagnostics.some((line) => line.startsWith('pageerror:'))) {
    throw new Error(`browser pageerror during cold Vision toggle smoke:\n${diagnostics.join('\n')}`)
  }

  console.log(JSON.stringify({
    ok: true,
    dsh: process.env.DSH_EXPECTED_VERSION || 'unknown',
    dvr: 'current-checkout',
    toggleVisibleAfterColdReload: true,
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

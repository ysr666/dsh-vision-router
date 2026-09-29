import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || join(here, '..'))
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const dshVersion = readJson(join(dshRoot, 'apps/desktop/package.json')).version
const expectedVersion = process.env.DSH_EXPECTED_VERSION
if (expectedVersion && dshVersion !== expectedVersion) {
  throw new Error(`expected DSH ${expectedVersion}, found ${dshVersion}`)
}

const importDsh = (path) => import(pathToFileURL(join(dshRoot, path)).href)
const { prepareDevelopmentProject } = await importDsh('apps/desktop/scripts/development-project.ts')
const { prepareDevelopmentApp } = await importDsh('apps/desktop/scripts/development-app.ts')
const { DesktopProjectManager } = await importDsh('apps/desktop/src/project-manager.ts')
const { resolveDesktopPaths } = await importDsh('apps/desktop/src/paths.ts')
const { DESKTOP_HOST_PROTOCOL_VERSION } = await importDsh('apps/desktop/src/host-protocol.ts')

const desktopRequire = createRequire(join(dshRoot, 'apps/desktop/package.json'))
const webRequire = createRequire(join(dshRoot, 'apps/web/package.json'))
const electron = desktopRequire('electron')
const { chromium } = webRequire('playwright')
const target = process.platform === 'win32'
  ? 'win-x64'
  : process.platform === 'darwin' && process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'

async function freePort() {
  return await new Promise((accept, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      server.close((error) => error ? reject(error) : accept(port))
    })
  })
}


function sendSse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function listenHttp(handler) {
  const server = createHttpServer((req, res) => { Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(error?.stack || error) }))
  }) })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('mock HTTP server has no TCP address')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server) {
  if (!server) return
  await new Promise((resolveClose) => server.close(() => resolveClose()))
}

async function waitForCdp(port, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs
  let lastError
  while (Date.now() < deadline) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`) }
    catch (error) { lastError = error; await new Promise((accept) => setTimeout(accept, 250)) }
  }
  throw lastError ?? new Error(`Desktop CDP did not start on port ${port}`)
}

async function waitForAppPage(browser, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('dsh-app://app/'))
    if (page) return page
    await new Promise((accept) => setTimeout(accept, 250))
  }
  throw new Error('Desktop never opened dsh-app://app/')
}

async function dismissVisionOnboarding(page) {
  const onboarding = page.locator('.vr-onboarding-backdrop')
  try { await onboarding.waitFor({ state: 'visible', timeout: 5_000 }) } catch {}
  if (!await onboarding.isVisible()) return
  await onboarding.locator('.vr-onboarding-secondary').click()
  await onboarding.waitFor({ state: 'hidden', timeout: 10_000 })
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }
  try { child.kill('SIGTERM') } catch {}
  await new Promise((accept) => setTimeout(accept, 500))
  if (child.exitCode === null) try { child.kill('SIGKILL') } catch {}
}

const root = mkdtempSync(join(tmpdir(), 'dvr-017-desktop-renderer-'))
const home = join(root, 'home')
const project = join(root, 'project')
const documentsDirectory = join(root, 'documents')
const workspace = join(documentsDirectory, 'deepseek-harness', 'default-workspace')
const userData = join(root, 'user-data')
const runtimeRoot = join(root, 'runtime')
const primaryRuntime = join(runtimeRoot, 'primary-runtime')
const diagnosticPath = process.env.SMOKE_DIAGNOSTIC_PATH
const screenshotPath = process.env.SMOKE_SCREENSHOT_PATH
let child
let browser
let page
let textServer
let visionServer
const textEvidence = { requests: 0, toolCalls: 0, attachmentId: undefined, sawVisionResult: false }
const visionEvidence = { requests: 0, sawImage: false }
const rendererErrors = []

try {
  mkdirSync(home)
  mkdirSync(userData)

  textServer = await listenHttp(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end(); return
    }
    const body = await readJsonBody(req)
    textEvidence.requests += 1
    const serialized = JSON.stringify(body)
    if (serialized.includes('DESKTOP_VISUAL_E2E_OK')) {
      textEvidence.sawVisionResult = true
      sendSse(res, [
        { choices: [{ delta: { content: 'DESKTOP_VISION_E2E_OK' } }] },
        { choices: [{ finish_reason: 'stop', delta: {} }] },
      ])
      return
    }
    const attachment =
      /\[attached image:\s*([^\]]+)\]/i.exec(serialized)?.[1]
      ?? /\bsha256:[a-f0-9]{64}\b/i.exec(serialized)?.[0]
    const toolNames = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name).filter(Boolean) : []
    if (!attachment || !toolNames.includes('vision_describe')) {
      sendSse(res, [
        { choices: [{ delta: { content: `DESKTOP_E2E_MISSING_VISION_TOOL:${toolNames.join(',')}` } }] },
        { choices: [{ finish_reason: 'stop', delta: {} }] },
      ])
      return
    }
    textEvidence.toolCalls += 1
    textEvidence.attachmentId = attachment
    const args = JSON.stringify({ attachmentIds: [attachment], question: 'Describe this test image and report the visible content.' })
    sendSse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'desktop-e2e-vision-call', type: 'function', function: { name: 'vision_describe' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
    ])
  })

  visionServer = await listenHttp(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end(); return
    }
    const body = await readJsonBody(req)
    visionEvidence.requests += 1
    const serialized = JSON.stringify(body)
    visionEvidence.sawImage = /data:image\//i.test(serialized) || /image_url/i.test(serialized)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'DESKTOP_VISUAL_E2E_OK' } }] }))
  })

  const pnpmVersion = readJson(join(dshRoot, 'apps/desktop/node_modules/pnpm/package.json')).version
  const electronNode = execFileSync(electron, ['-p', 'process.versions.node'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim()

  prepareDevelopmentProject({
    projectDir: project,
    cliDir: join(dshRoot, 'apps/cli'),
    hostDir: join(dshRoot, 'apps/desktop-host'),
    dependencyDir: join(dshRoot, 'node_modules/.pnpm/node_modules'),
    release: {
      schemaVersion: 1,
      version: dshVersion,
      pnpmVersion,
      nodeVersion: electronNode,
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    },
    target,
  })

  cpSync(join(dshRoot, 'packages/skill/skill-office/assets'), join(runtimeRoot, 'office-skills'), { recursive: true })
  const nodeDir = join(primaryRuntime, 'dependencies/node/bin')
  mkdirSync(nodeDir, { recursive: true })
  cpSync(process.execPath, join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'))

  const paths = resolveDesktopPaths(home)
  const manager = new DesktopProjectManager(paths, { dsh: project })
  await manager.applyRelease()

  const manifestPath = join(paths.profile, 'package.json')
  const manifest = readJson(manifestPath)
  manifest.dependencies['dsh-vision-router'] = `file:${dvrRoot}`
  if (!manifest.dsh.profile.bundles.includes('dsh-vision-router')) manifest.dsh.profile.bundles.push('dsh-vision-router')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  // Exercise the exact public configuration surfaces: a local OpenAI-compatible
  // text route drives the real Agent loop, while DVR's vision-http route drives
  // the real image tool. Neither side can accidentally pass by reaching the network.
  writeFileSync(join(paths.profile, 'cordis.patch.yml'), [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: ${JSON.stringify(documentsDirectory)}`,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      desktop-e2e:',
    '        displayName: Desktop E2E',
    '        api: openai-completions',
    '        apiKeyEnv: DVR_DESKTOP_E2E_API_KEY',
    `        baseURL: ${textServer.url}/v1`,
    '        models:',
    '          - id: desktop-text',
    '            input: [text]',
    '            contextWindow: 32768',
    '            maxTokens: 2048',
    '- id: agent-default-model',
    '  config:',
    '    provider: desktop-e2e',
    '    model: desktop-text',
    '- id: vision-router',
    '  config:',
    '    provider: vision-http',
    '    model: desktop-vision',
    '    httpProviders:',
    '      - name: desktop-e2e',
    `        baseURL: ${visionServer.url}/v1`,
    '        model: desktop-vision',
    '',
  ].join('\n'))

  const pnpmEntry = join(dshRoot, 'apps/desktop/node_modules/pnpm/bin/pnpm.mjs')
  const install = spawnSync(process.execPath, [pnpmEntry, 'install', '--dir', paths.profile, '--ignore-scripts'], {
    env: process.env, encoding: 'utf8', stdio: 'pipe',
  })
  if (install.status !== 0) {
    throw new Error(`Desktop profile install failed (${String(install.status)})\n${install.stdout}\n${install.stderr}`)
  }

  const rendererPort = await freePort()
  const mainPort = await freePort()
  const hostPort = await freePort()
  const environment = {
    ...process.env,
    DSH_HOME: home,
    DSH_DESKTOP_DEV_APP: '1',
    DSH_DESKTOP_DSH_DIR: project,
    DSH_DESKTOP_PNPM_ENTRY: pnpmEntry,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: primaryRuntime,
    DSH_DESKTOP_HOST_INSPECT_PORT: String(hostPort),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    DSH_TELEMETRY_MODE: 'DISABLED',
    // The public pi-ai custom-provider contract requires a credential. Generate
    // an ephemeral per-run value instead of storing any test secret in source.
    DVR_DESKTOP_E2E_API_KEY: randomUUID(),
    ELECTRON_ENABLE_LOGGING: '1',
  }

  let executable = electron
  let args = [`--inspect=127.0.0.1:${mainPort}`, `--remote-debugging-port=${rendererPort}`,
    `--user-data-dir=${userData}`, join(dshRoot, 'apps/desktop')]
  if (process.platform === 'darwin') {
    executable = prepareDevelopmentApp({
      electron,
      appRoot: join(dshRoot, 'apps/desktop'),
      directory: join(root, 'development-app'),
      home,
      userData,
      mainPort,
      rendererPort,
      hostPort,
      openDevtools: '0',
    })
    args = []
  }

  child = spawn(executable, args, {
    cwd: join(dshRoot, 'apps/desktop'), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => process.stdout.write(`[desktop] ${chunk}`))
  child.stderr?.on('data', (chunk) => process.stderr.write(`[desktop] ${chunk}`))

  browser = await waitForCdp(rendererPort)
  page = await waitForAppPage(browser)
  page.on('pageerror', (error) => rendererErrors.push(String(error?.stack || error)))
  const boot = await page.evaluate(async () => await window.dshDesktopBoot.ready())
  const markers = boot.injections.filter((row) => row?.kind === 'script' && typeof row.text === 'string')
    .map((row) => (row.text.match(/data-vision-router-[a-z0-9-]+(?::structured)?/i) || [])[0])
    .filter(Boolean)
  for (const required of [
    'data-vision-router-settings-017-compat:structured',
    'data-vision-router-presentation-boundary',
    'data-vision-router-settings-factory-lifecycle',
  ]) {
    if (!markers.includes(required)) throw new Error(`Desktop boot is missing ${required}`)
  }

  // Pin the Host-owned default workspace inside this test's temporary world.
  // Desktop prefers the native OS directory picker over the browser fallback,
  // so driving a DOM dialog here would test the wrong surface on fresh profiles.
  // The workspace-controller owns first-use creation; wait for the Session slot
  // below to prove that initialization completed before exercising Vision mode.
  await dismissVisionOnboarding(page)

  const toggle = page.locator('[data-vision-router-mode-toggle="true"]')
  await toggle.waitFor({ state: 'visible', timeout: 30_000 })
  if (!existsSync(workspace)) throw new Error(`Desktop did not initialize the pinned default workspace: ${workspace}`)

  const initialPressed = await toggle.getAttribute('aria-pressed')
  await toggle.click()
  await page.waitForFunction(() => document.querySelector('[data-vision-router-mode-toggle="true"]')?.getAttribute('aria-pressed') === 'true')
  await toggle.click()
  await page.waitForFunction((initial) => document.querySelector('[data-vision-router-mode-toggle="true"]')?.getAttribute('aria-pressed') === initial, initialPressed)

  const accountMenu = page.getByRole('button', { name: /账号菜单|Account menu/i })
  await accountMenu.click()
  await page.getByRole('menuitem', { name: /设置|Settings/i }).click()
  await page.getByText('Vision Router', { exact: true }).last().click()
  await page.waitForTimeout(250)
  let settingsText = await page.locator('body').innerText()
  if (/远程设置未启用|Remote settings (?:are )?disabled/i.test(settingsText)) {
    throw new Error('official dsh-app://app entered the remote-settings permission gate')
  }

  const strategyCard = page.locator('.vr-ia-plugin-card').filter({ hasText: /识图策略|Vision strategy/i })
  await strategyCard.locator('.vr-ia-plugin-card-header').click()
  const depthToggle = strategyCard.locator('[data-vr-depth-cap-toggle="1"]')
  await depthToggle.waitFor({ state: 'visible', timeout: 5000 })
  const originalChecked = await depthToggle.isChecked()
  await depthToggle.click()
  const expectedChecked = !originalChecked
  const save = strategyCard.locator('.vr-ia-save')
  await save.click()
  await strategyCard.locator('.vr-ia-plugin-card-header').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.vr-ia-plugin-card')]
      .find((node) => /识图策略|Vision strategy/i.test(node.textContent || ''))
    return card?.querySelector('.vr-ia-plugin-card-header')?.getAttribute('aria-expanded') === 'false'
  })

  await page.getByRole('button', { name: /关闭|Close/i }).first().click()
  await accountMenu.click()
  await page.getByRole('menuitem', { name: /设置|Settings/i }).click()
  await page.getByText('Vision Router', { exact: true }).last().click()
  await page.waitForTimeout(250)
  settingsText = await page.locator('body').innerText()
  if (/远程设置未启用|Remote settings (?:are )?disabled/i.test(settingsText)) {
    throw new Error('Desktop Settings regressed to remote permission warning after reopen')
  }
  const reopenedCard = page.locator('.vr-ia-plugin-card').filter({ hasText: /识图策略|Vision strategy/i })
  await reopenedCard.locator('.vr-ia-plugin-card-header').click()
  const reopenedToggle = reopenedCard.locator('[data-vr-depth-cap-toggle="1"]')
  await reopenedToggle.waitFor({ state: 'visible', timeout: 5000 })
  if (await reopenedToggle.isChecked() !== expectedChecked) throw new Error('Desktop Settings save did not survive reopen')

  // Restore the fixture's original value and require the same durable save path.
  await reopenedToggle.click()
  await reopenedCard.locator('.vr-ia-save').click()
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.vr-ia-plugin-card')]
      .find((node) => /识图策略|Vision strategy/i.test(node.textContent || ''))
    return card?.querySelector('.vr-ia-plugin-card-header')?.getAttribute('aria-expanded') === 'false'
  })
  // Re-open once more to verify the restoration survived the same save path.
  await reopenedCard.locator('.vr-ia-plugin-card-header').click()
  const restoredToggle = reopenedCard.locator('[data-vr-depth-cap-toggle="1"]')
  await restoredToggle.waitFor({ state: 'visible', timeout: 5000 })
  if (await restoredToggle.isChecked() !== originalChecked) throw new Error('Desktop Settings restore did not survive save readback')
  await page.getByRole('button', { name: /关闭|Close/i }).first().click()

  // A true product smoke ends at the rendered answer, not at an injected DOM node.
  // Reuse the exact live Session whose composer and Vision slot were exercised
  // above. Do not couple the smoke to a version-specific “new session” chrome.
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  const fileInput = page.locator('[data-composer-card] input[type="file"]').first()
  await fileInput.setInputFiles({
    name: 'desktop-e2e.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  })
  await page.locator('img[alt="desktop-e2e.png"]').waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill('Inspect the attached image with the vision tool, then answer with the observed result.')
  const functionalToggle = page.locator('[data-vision-router-mode-toggle="true"]')
  await functionalToggle.waitFor({ state: 'visible', timeout: 30_000 })
  if (await functionalToggle.getAttribute('aria-pressed') !== 'true') await functionalToggle.click()
  await page.waitForFunction(() => document.querySelector('[data-vision-router-mode-toggle="true"]')?.getAttribute('aria-pressed') === 'true')
  // The primary action changes its accessible name when a running turn can be
  // queued or steered. Waiting for actionability also waits out attachment upload.
  const send = page.getByRole('button', {
    name: /^(?:Send message|Queue message|Steer message|发送消息|排队发送|插话发送)$/i,
  }).last()
  await send.waitFor({ state: 'visible', timeout: 30_000 })
  await send.click({ timeout: 30_000 })
  await page.getByText('DESKTOP_VISION_E2E_OK', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  if (textEvidence.toolCalls < 1 || !textEvidence.attachmentId || !textEvidence.sawVisionResult) {
    throw new Error(`Desktop text model did not complete the real vision tool loop: ${JSON.stringify(textEvidence)}`)
  }
  if (visionEvidence.requests < 1 || !visionEvidence.sawImage) {
    throw new Error(`Desktop vision backend did not receive canonical image content: ${JSON.stringify(visionEvidence)}`)
  }

  if (rendererErrors.length > 0) throw new Error(`Desktop renderer errors:\n${rendererErrors.join('\n---\n')}`)
  const result = {
    ok: true,
    dsh: dshVersion,
    platform: process.platform,
    arch: process.arch,
    electronNode,
    structuredMarkers: markers.length,
    toggle: { initial: initialPressed, exercised: true, restored: true },
    settings: { remoteWarning: false, saved: expectedChecked, reloadReadback: expectedChecked, restored: originalChecked },
    functionalVisionTurn: { textEvidence, visionEvidence, rendered: 'DESKTOP_VISION_E2E_OK' },
  }
  console.log(JSON.stringify(result))
  if (diagnosticPath) writeFileSync(diagnosticPath, `${JSON.stringify(result, undefined, 2)}\n`)
} catch (error) {
  if (page && screenshotPath) {
    try { await page.screenshot({ path: screenshotPath, fullPage: true }) } catch {}
  }
  const failureState = page ? await page.evaluate(() => ({
    bodyText: (document.body?.innerText || '').slice(-12000),
    composer: document.querySelector('[data-composer-card]')?.textContent || '',
    composerButtons: [...document.querySelectorAll('[data-composer-card] button')].map((button) => ({
      label: button.getAttribute('aria-label') || '', disabled: Boolean(button.disabled), hidden: Boolean(button.hidden),
    })),
    url: location.href,
  })).catch(() => undefined) : undefined
  const failure = { ok: false, error: String(error?.stack || error), rendererErrors, textEvidence, visionEvidence, failureState }
  console.error(JSON.stringify(failure, undefined, 2))
  if (diagnosticPath) {
    try { writeFileSync(diagnosticPath, `${JSON.stringify(failure, undefined, 2)}\n`) } catch {}
  }
  throw error
} finally {
  try { await browser?.close() } catch {}
  await stopProcess(child)
  await closeServer(textServer?.server)
  await closeServer(visionServer?.server)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); break }
    catch { await new Promise((accept) => setTimeout(accept, 250)) }
  }
}

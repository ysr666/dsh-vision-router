import assert from 'node:assert/strict'
import { installDesktopVisionToggleAudit, installDesktopModelSelectionTrace } from './dsh-desktop-toggle-stability.mjs'
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

function inspectRuntimePackage(projectRoot, packageName) {
  const runtimeRequire = createRequire(join(projectRoot, 'package.json'))
  const packageJsonPath = join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json')
  let manifest
  let resolved
  let resolveError
  try { manifest = readJson(packageJsonPath) } catch (error) { resolveError = String(error?.stack || error) }
  try { resolved = runtimeRequire.resolve(packageName) } catch (error) { resolveError = String(error?.stack || error) }
  const main = typeof manifest?.main === 'string' ? manifest.main : 'index.js'
  const mainPath = join(projectRoot, 'node_modules', ...packageName.split('/'), main)
  return {
    packageName,
    packageJsonPath,
    packageJsonExists: existsSync(packageJsonPath),
    version: manifest?.version ?? null,
    main,
    mainPath,
    mainExists: existsSync(mainPath),
    resolved: resolved ?? null,
    resolveError: resolveError ?? null,
  }
}

const CORE_PROBE_SERVICE_NAMES = [
  'storage', 'storageDomain', 'sessionPersistence', 'workspaceRegistry',
  'workspaceController', 'sessionController', 'sessions', 'sessionQuery',
  'agents', 'llm', 'typert', 'webServer',
]

function fixedServiceState(value) {
  if (value?.active === true) return 'active'
  if (value?.present === true) return 'present-inactive'
  return 'missing'
}

function fixedFiberState(value) {
  for (const state of ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']) {
    if (value === state) return state
  }
  return 'UNKNOWN'
}

function fileSafeCoreProbe(probe) {
  const services = Object.fromEntries(CORE_PROBE_SERVICE_NAMES.map((name) => [
    name, fixedServiceState(probe?.services?.[name]),
  ]))
  const fiberStates = Object.fromEntries(
    ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING', 'UNKNOWN'].map((state) => [state, 0]),
  )
  if (Array.isArray(probe?.fibers)) {
    for (const fiber of probe.fibers) fiberStates[fixedFiberState(fiber?.state)] += 1
  }
  return {
    available: probe !== undefined && probe !== null && probe?.probeError === undefined,
    services,
    fiberStates,
  }
}

function fileSafeRuntimePackageEvidence(evidence) {
  const summarize = (value) => ({
    packageJsonExists: value?.packageJsonExists === true,
    mainExists: value?.mainExists === true,
    resolved: typeof value?.resolved === 'string',
    resolveFailed: typeof value?.resolveError === 'string',
  })
  return { source: summarize(evidence?.source), developmentProject: summarize(evidence?.developmentProject) }
}

function fileSafeFailureState(state) {
  if (!state) return { captured: false }
  const body = typeof state.bodyText === 'string' ? state.bodyText : ''
  const buttons = Array.isArray(state.composerButtons) ? state.composerButtons : []
  return {
    captured: true,
    desktopOrigin: typeof state.url === 'string' && state.url.startsWith('dsh-app://app/'),
    workspacePrompt: /Choose (?:a )?workspace|选择(?:一个)?工作区/i.test(body),
    composerButtonCount: buttons.length,
    enabledComposerAction: buttons.some((button) => button?.disabled === false && button?.hidden !== true),
  }
}

function fileSafeTurnEvidence(textEvidence, visionEvidence) {
  return {
    text: {
      requests: Number.isSafeInteger(textEvidence?.requests) ? textEvidence.requests : 0,
      toolCalls: Number.isSafeInteger(textEvidence?.toolCalls) ? textEvidence.toolCalls : 0,
      attachmentResolved: typeof textEvidence?.attachmentId === 'string',
      sawVisionResult: textEvidence?.sawVisionResult === true,
    },
    vision: {
      requests: Number.isSafeInteger(visionEvidence?.requests) ? visionEvidence.requests : 0,
      sawImage: visionEvidence?.sawImage === true,
    },
  }
}

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

function writeHostCoreProbeFixture(directory) {
  const name = 'dvr-desktop-core-probe'
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2)}\n`)
  writeFileSync(join(directory, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${name}`,
    `      name: ${name}`,
    '',
  ].join('\n'))
  writeFileSync(join(directory, 'index.js'), String.raw`const STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
const SERVICE_NAMES = [
  'storage', 'storageDomain', 'sessionPersistence', 'workspaceRegistry',
  'workspaceController', 'sessionController', 'sessions', 'sessionQuery',
  'agents', 'llm', 'typert', 'webServer',
]

function serviceState(ctx, name) {
  let active
  let present
  try { active = ctx.get(name) } catch {}
  try { present = ctx.get(name, false) } catch {}
  return {
    active: active !== undefined,
    present: present !== undefined,
    constructor: (active ?? present)?.constructor?.name ?? null,
  }
}

function fiberError(fiber) {
  const error = fiber?._error
  if (error === undefined || error === null) return null
  return String(error?.stack || error).slice(0, 12000)
}

function modelSelectionSummary(value) {
  if (!value || typeof value !== 'object') return null
  return {
    provider: typeof value.provider === 'string' ? value.provider.slice(0, 120) : null,
    model: typeof value.model === 'string' ? value.model.slice(0, 120) : null,
    reasoningEffort: typeof value.reasoningEffort === 'string'
      ? value.reasoningEffort.slice(0, 80) : null,
  }
}

function collectDvrSources(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectDvrSources(item, out)
    return out
  }
  if (value === null || typeof value !== 'object') return out
  const source = value.source
  if (
    source !== null &&
    typeof source === 'object' &&
    (source.kind === 'plugin:dsh-vision-router' || source.plugin === 'dsh-vision-router')
  ) {
    out.push(source)
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key !== 'source') collectDvrSources(nested, out)
  }
  return out
}

function collectDvrMessages(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectDvrMessages(item, out)
    return out
  }
  if (value === null || typeof value !== 'object') return out
  if (
    typeof value.id === 'string' &&
    value.id.startsWith('vision-router-') &&
    typeof value.role === 'string' &&
    Array.isArray(value.content)
  ) {
    out.push({
      id: value.id,
      role: value.role,
      source: value.source ?? null,
    })
  }
  for (const nested of Object.values(value)) collectDvrMessages(nested, out)
  return out
}

export function apply(ctx) {
  // Issue #684: experiment-only Host pre-commit scheduling gate. Never
  // register this endpoint or wrap llm outside an ephemeral test process.
  if (process.env.DVR_E2E_684_RACE === '1') {
    ctx.inject(['webServer', 'llm'], (scope) => {
      const llm = scope.llm
      const previousOwnMethod = Object.getOwnPropertyDescriptor(llm, 'resolveCallConfig')
      const original = llm.resolveCallConfig
      if (typeof original !== 'function') throw new Error('Host race: resolveCallConfig unavailable')
      const race = { armed: false, entered: false, enteredCount: 0, release: null }
      llm.resolveCallConfig = function(...args) {
        const selection = args[0]
        if (race.armed && selection?.provider === 'desktop-e2e' && selection?.model === 'desktop-text') {
          race.armed = false
          race.entered = true
          race.enteredCount += 1
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              race.release = null
              race.entered = false
              reject(new Error('issue-684 experimental Host gate timed out'))
            }, 20000)
            race.release = () => {
              clearTimeout(timeout)
              race.release = null
              race.entered = false
              resolve()
            }
          }).then(() => original.apply(this, args))
        }
        return original.apply(this, args)
      }
      scope.effect(() => () => {
        if (race.release) race.release()
        if (previousOwnMethod) Object.defineProperty(llm, 'resolveCallConfig', previousOwnMethod)
        else delete llm.resolveCallConfig
      }, 'issue-684: restore Host model resolver')
      scope.effect(() => scope.webServer.register({
        kind: 'exact',
        path: '/dvr-e2e-684-race',
        handler(request, response) {
          const correctToken = process.env.DVR_E2E_684_RACE_TOKEN
          if (request.method !== 'POST' ||
              !correctToken ||
              request.headers['x-dvr-e2e-684-token'] !== correctToken) {
            response.writeHead(404)
            response.end()
            return
          }
          const action = new URL(request.url || '/', 'http://127.0.0.1').searchParams.get('action')
          let status = 200
          if (action === 'arm') {
            if (race.armed || race.release) status = 409
            else { race.armed = true; race.entered = false }
          } else if (action === 'release') {
            if (!race.release) status = 409
            else race.release()
          } else if (action !== 'state') status = 400
          response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify({
            armed: race.armed,
            entered: race.entered,
            enteredCount: race.enteredCount,
            canRelease: typeof race.release === 'function',
          }))
        },
      }), 'issue-684: authenticated Host-only experimental gate')
    })
  }
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dvr-e2e-core-status',
      async handler(_request, response) {
        const services = Object.fromEntries(SERVICE_NAMES.map((name) => [name, serviceState(scope, name)]))
        const fibers = []
        for (const runtime of scope.registry.values()) {
          for (const fiber of runtime.fibers) {
            const state = STATES[fiber.state] ?? String(fiber.state)
            const name = runtime.name ?? fiber.runtime?.name ?? fiber.runtime?.callback?.name ?? '<anonymous>'
            if (state === 'ACTIVE' && !/storage|session|workspace/i.test(name)) continue
            fibers.push({
              name,
              uid: fiber.uid,
              state,
              inject: Object.keys(fiber.inject ?? {}),
              store: Object.keys(fiber.store ?? {}),
              error: fiberError(fiber),
            })
          }
        }
        const loaderEntries = []
        try {
          for (const entry of scope.loader.entries()) {
            if (!/session-persistence|workspace-controller|session-controller|(?:^|:)workspace$/i.test(entry.id)
              && !/session-persistence|workspace-controller|session-controller|dsh-workspace$/i.test(entry.options?.name ?? '')) continue
            loaderEntries.push({
              id: entry.id,
              name: entry.options?.name ?? null,
              disabled: entry.disabled,
              hasFiber: Boolean(entry.fiber),
              fiberState: entry.fiber ? (STATES[entry.fiber.state] ?? String(entry.fiber.state)) : null,
              initializing: Boolean(entry._initTask),
            })
          }
        } catch (error) {
          loaderEntries.push({ inspectError: String(error?.stack || error).slice(0, 12000) })
        }
        let persistenceImport
        try {
          const imported = await scope.loader.import('@deepseek-ai/dsh-session-persistence-jsonl')
          persistenceImport = {
            ok: true,
            keys: Object.keys(imported ?? {}).slice(0, 40),
          }
        } catch (error) {
          persistenceImport = { ok: false, error: String(error?.stack || error).slice(0, 12000) }
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ services, fibers, loaderEntries, persistenceImport }))
      },
    }), 'desktop-e2e: core service diagnostics')
  })
  ctx.inject(['webServer', 'sessions'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dvr-e2e-session-sources',
      handler(_request, response) {
        const payload = scope.sessions.list().map((session) => {
          const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
          return {
            id: session.header?.id ?? null,
            version: session.header?.version ?? null,
            sources: collectDvrSources(events),
            messages: collectDvrMessages(events),
          }
        })
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ sessions: payload }))
      },
    }), 'desktop-e2e: Session source diagnostics')
    // Separate test-only Host event probe: snapshots the accepted model
    // selection events without session IDs, prompts, tokens or credentials.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dvr-e2e-model-selections',
      handler(_request, response) {
        let projections
        let defaultSelection
        try { projections = scope.get('sessionProjections') } catch {}
        try { defaultSelection = modelSelectionSummary(scope.get('agentDefaultModel')?.currentSelection()) } catch {}
        // Keep even the Host response bounded before transferring it to the browser.
        const sessions = scope.sessions.list().slice(-8).map((session) => {
          const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
          const selections = events.filter((event) => event?.type === 'model/selection')
            .map((event) => modelSelectionSummary(event.data))
          let projected
          try {
            const state = projections?.stateOf(session, 'modelSelection')
            if (state) projected = {
              // This is the authoritative selection consumed by ModelDirectory.syncInputs().
              next: modelSelectionSummary(state.pending ?? state.lastUsed),
              pending: modelSelectionSummary(state.pending),
              lastUsed: modelSelectionSummary(state.lastUsed),
            }
          } catch {}
          return { count: selections.length, latest: selections.slice(-8), projected: projected ?? null }
        }).filter((session) => session.count > 0)
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ sessions, defaultSelection: defaultSelection ?? null }))
      },
    }), 'desktop-e2e: accepted model selection evidence')
  })
}
`)
  return { name, directory }
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

async function exerciseVisionOnboardingSettingsPath(page) {
  const onboarding = page.locator('.vr-onboarding-backdrop')
  await onboarding.waitFor({ state: 'visible', timeout: 15_000 })
  await onboarding.locator('.vr-onboarding-primary').click()
  await onboarding.waitFor({ state: 'hidden', timeout: 10_000 })

  const prompt = page.locator('.vr-guide-prompt')
  await prompt.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('.vr-guide-prompt')?.dataset.vrStep === 'step1')
  await prompt.locator('.vr-btn-save').click()
  await page.waitForFunction(() => {
    const guide = document.querySelector('.vr-guide-prompt')
    return guide?.dataset.vrStep === 'step2' && guide?.dataset.vrPhase === 'launcher'
  })

  // Desktop replaces the direct Settings gear with the account-owned launcher
  // (avatar/More menu). Drive the guide itself so this E2E fails if its “Next”
  // action cannot traverse launcher -> Settings menu -> Settings panel.
  await prompt.locator('.vr-btn-save').click()
  await page.waitForFunction(() => {
    const phase = document.querySelector('.vr-guide-prompt')?.dataset.vrPhase
    return phase === 'menu' || phase === 'nav'
  })
  let phase = await prompt.getAttribute('data-vr-phase')
  if (phase === 'menu') {
    await page.getByRole('menuitem', { name: /设置|Settings/i }).first().waitFor({ state: 'visible', timeout: 10_000 })
    await prompt.locator('.vr-btn-save').click()
    await page.waitForFunction(() => document.querySelector('.vr-guide-prompt')?.dataset.vrPhase === 'nav')
    phase = 'nav'
  }
  if (phase !== 'nav') throw new Error(`Vision onboarding did not reach Settings navigation (phase=${phase})`)

  await page.getByText('Vision Router', { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 })
  await prompt.locator('.vr-btn-save').click()
  await page.locator('[data-vr-guide-target="vision-backend"]').waitFor({ state: 'visible', timeout: 10_000 })
  const done = page.locator('.vr-guide-callout .vr-btn-save')
  await done.waitFor({ state: 'visible', timeout: 10_000 })
  await done.click()
  await page.locator('.vr-guide-callout').waitFor({ state: 'hidden', timeout: 10_000 })
  await page.getByRole('button', { name: /关闭|Close/i }).first().click()
}

async function exchangeHostCookie(authenticatedUrl) {
  const response = await fetch(authenticatedUrl, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || !setCookie) {
    throw new Error(`Desktop Host authentication exchange failed (${response.status})`)
  }
  return setCookie.split(';', 1)[0]
}

async function readHostCoreProbe(authenticatedUrl) {
  const target = new URL(authenticatedUrl)
  const cookie = await exchangeHostCookie(authenticatedUrl)
  target.pathname = '/dvr-e2e-core-status'
  target.search = ''
  const response = await fetch(target, { headers: { cookie }, redirect: 'manual' })
  const body = await response.json()
  if (!response.ok) throw new Error(`Desktop Host core probe failed (${response.status}): ${JSON.stringify(body)}`)
  return body
}

async function readHostSessionSources(authenticatedUrl) {
  const target = new URL(authenticatedUrl)
  const cookie = await exchangeHostCookie(authenticatedUrl)
  target.pathname = '/dvr-e2e-session-sources'
  target.search = ''
  const response = await fetch(target, { headers: { cookie }, redirect: 'manual' })
  const text = await response.text()
  if (!response.ok || text.length === 0) {
    throw new Error(`Desktop Host Session source probe failed (${response.status}): ${text || '<empty body>'}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(
      `Desktop Host Session source probe returned invalid JSON (${response.status}): ${text.slice(0, 4000)}`,
      { cause: error },
    )
  }
}

async function readHostModelSelections(authenticatedUrl) {
  const target = new URL(authenticatedUrl)
  const cookie = await exchangeHostCookie(authenticatedUrl)
  target.pathname = '/dvr-e2e-model-selections'
  target.search = ''
  const response = await fetch(target, { headers: { cookie }, redirect: 'manual' })
  if (!response.ok) throw new Error(`model selection probe returned HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload?.sessions)) throw new Error('model selection probe returned an invalid shape')
  return {
    sessions: payload.sessions.slice(0, 8),
    defaultSelection: payload.defaultSelection ?? null,
  }
}


async function control684HostRace(authenticatedUrl, token, action) {
  const target = new URL(authenticatedUrl)
  const cookie = await exchangeHostCookie(authenticatedUrl)
  target.pathname = '/dvr-e2e-684-race'
  target.search = '?action=' + encodeURIComponent(action)
  const response = await fetch(target, {
    method: 'POST',
    headers: { cookie, 'x-dvr-e2e-684-token': token },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body === null) {
    throw new Error('Host race control ' + action + ' failed: HTTP ' + response.status)
  }
  return body
}

async function waitFor684HostGate(authenticatedUrl, token) {
  const deadline = Date.now() + 15000
  let last
  while (Date.now() < deadline) {
    last = await control684HostRace(authenticatedUrl, token, 'state')
    if (last.entered && last.canRelease) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Second OFF request never reached real Host resolveCallConfig gate: ' + JSON.stringify(last))
}

async function experiment684DirectoryAction(page, mode) {
  return await page.evaluate(async (mode) => {
    const button = document.querySelector('[data-vision-router-mode-toggle="true"]')
    const key = button && Object.getOwnPropertyNames(button).find((name) => name.startsWith('__reactFiber$'))
    let fiber = key && button[key]
    let directory
    for (let i = 0; fiber && i < 64; i++, fiber = fiber.return) {
      if (fiber.memoizedProps?.directory?.store?.getSnapshot && fiber.memoizedProps.directory.catalog) {
        directory = fiber.memoizedProps.directory
        break
      }
    }
    if (!directory) throw new Error('Experiment requires a real Host-owned ModelDirectory')
    if (mode === 'catalog') directory.catalog.refresh()
    else if (mode === 'reset') {
      directory.catalog.resetGeneration()
      directory.resetConnected()
    } else throw new Error('Unknown experiment mode')
    // This resolves through the genuine DSH remote.session.modelCatalog() path.
    const deadline = performance.now() + 12000
    while (performance.now() < deadline) {
      const snapshot = directory.catalog.store.getSnapshot()
      if (snapshot.status === 'ready') return {
        catalog: snapshot.status,
        directoryStatus: directory.store.getSnapshot().status,
        directoryProvider: directory.store.getSnapshot().current?.provider ?? null,
      }
      await new Promise((accept) => setTimeout(accept, 80))
    }
    throw new Error('Host modelCatalog hydration did not settle after ' + mode)
  }, mode)
}


async function install684PostCommitAckGate(page) {
  await page.evaluate(() => {
    const button = document.querySelector('[data-vision-router-mode-toggle="true"]')
    const key = button && Object.getOwnPropertyNames(button).find((k) => k.startsWith('__reactFiber$'))
    let fiber = key && button[key]
    let directory
    for (let i = 0; fiber && i < 64; i++, fiber = fiber.return) {
      if (typeof fiber.memoizedProps?.directory?.select === 'function') {
        directory = fiber.memoizedProps.directory
        break
      }
    }
    if (!directory) throw new Error('Client postcommit experiment: ModelDirectory unavailable')
    const owned = Object.getOwnPropertyDescriptor(directory, 'select')
    const original = directory.select
    const gate = { entered: false, accepted: false, release: null }
    directory.select = async function(...args) {
      const result = await original.apply(this, args)
      if (args[0]?.provider === 'desktop-e2e' && args[0]?.model === 'desktop-text') {
        gate.entered = true
        gate.accepted = result?.ok === true
        if (gate.accepted) {
          await new Promise((resolve) => { gate.release = resolve })
          gate.release = null
        }
      }
      return result
    }
    gate.restore = () => {
      if (gate.release) gate.release()
      if (owned) Object.defineProperty(directory, 'select', owned)
      else delete directory.select
    }
    window.__dvr684PostCommitAckGate = gate
  })
}

// Test-only, read-only snapshot of the directory attached to this React toggle.
// The React DOM fiber is not a Host API. If unavailable, report an explicit
// diagnostic gap; never make a model selection or infer success from this probe.
async function readClientModelDirectory(page) {
  return await page.evaluate(() => {
    const button = document.querySelector('[data-vision-router-mode-toggle="true"]')
    if (!button) return { available: false, reason: 'toggle-missing' }
    const fiberKey = Object.getOwnPropertyNames(button).find((key) => key.startsWith('__reactFiber$'))
    if (!fiberKey) return { available: false, reason: 'react-fiber-unavailable' }
    const selection = (value) => !value || typeof value !== 'object' ? null : {
      provider: typeof value.provider === 'string' ? value.provider.slice(0, 120) : null,
      model: typeof value.model === 'string' ? value.model.slice(0, 120) : null,
      reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort.slice(0, 80) : null,
    }
    let fiber = button[fiberKey]
    for (let depth = 0; fiber && depth < 64; depth++, fiber = fiber.return) {
      const directory = fiber.memoizedProps?.directory
      if (typeof directory?.store?.getSnapshot !== 'function') continue
      const state = directory.store.getSnapshot()
      return {
        available: true,
        status: ['idle', 'loading', 'ready', 'selecting', 'error'].includes(state?.status)
          ? state.status : 'unknown',
        current: selection(state?.current),
        pending: selection(state?.pending),
        routable: typeof state?.routable === 'boolean' ? state.routable : null,
        groupCount: Array.isArray(state?.groups) ? Math.min(state.groups.length, 256) : null,
        hasError: typeof state?.error === 'string' && state.error.length > 0,
      }
    }
    return { available: false, reason: 'directory-fiber-unavailable' }
  })
}

async function callHostRemote(authenticatedUrl, method, args = {}, deadlineMs = 20_000) {
  const target = new URL(authenticatedUrl)
  const cookie = await exchangeHostCookie(authenticatedUrl)
  target.pathname = `/api/${method}`
  target.search = ''
  const deadline = Date.now() + deadlineMs
  let lastFailure
  while (Date.now() < deadline) {
    const rpcId = `desktop-e2e-${randomUUID()}`
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      })
      const body = await response.json()
      if (response.ok && body?.type === 'server-response' && body?.rpcId === rpcId && body?.result?.ok === true) {
        return body.result.value
      }
      lastFailure = new Error(`Host Remote ${method} rejected: HTTP ${response.status} ${JSON.stringify(body)}`)
    } catch (error) {
      lastFailure = error
    }
    await new Promise((accept) => setTimeout(accept, 250))
  }
  throw lastFailure ?? new Error(`Host Remote ${method} did not become available`)
}

async function waitForVisionToggle(page, authenticatedUrl) {
  const toggle = page.locator('[data-vision-router-mode-toggle="true"]')
  try {
    await toggle.waitFor({ state: 'visible', timeout: 15_000 })
    return toggle
  } catch (error) {
    const bodyText = await page.locator('body').innerText().catch(() => '')
    const workspaceTriggerVisible = await page.getByRole('button', { name: /Choose workspace|选择工作区/i })
      .first().isVisible().catch(() => false)
    const defaultWorkspaceFailed = workspaceTriggerVisible
      || /Choose a workspace to start|选择(?:一个)?工作区.*开始/i.test(bodyText)
    if (!defaultWorkspaceFailed) throw error

    lastCoreProbe = await readHostCoreProbe(authenticatedUrl).catch((probeError) => ({
      probeError: String(probeError?.stack || probeError),
    }))
    if (lastCoreProbe?.services?.workspaceController?.active !== true
      || lastCoreProbe?.services?.sessionController?.active !== true) {
      console.error(`[desktop-e2e] Host core probe: ${JSON.stringify(lastCoreProbe)}`)
      throw new Error('Desktop Host core control plane is unavailable')
    }

    // DSH deliberately does not retry a failed first-use initializeDefault() in
    // the same navigation. Once the Host control plane is healthy, recover through
    // DSH's authenticated public Workspace Remote instead of automating the
    // OS-native directory picker (which is an upstream Desktop surface, not a DVR one).
    await callHostRemote(authenticatedUrl, 'workspace/initializeDefault')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.evaluate(async () => await window.dshDesktopBoot.ready())
    await toggle.waitFor({ state: 'visible', timeout: 30_000 })
    return toggle
  }
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

const raceMode = process.env.DVR_684_RACE_MODE ?? ''
if (raceMode && !['catalog', 'reset', 'postcommit-reset'].includes(raceMode)) {
  throw new Error('Unknown #684 real Host race mode: ' + raceMode)
}
const raceToken = raceMode ? randomUUID() : ''
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
let resolveAuthenticatedHostUrl
let rejectAuthenticatedHostUrl
const authenticatedHostUrlPromise = new Promise((resolve, reject) => {
  resolveAuthenticatedHostUrl = resolve
  rejectAuthenticatedHostUrl = reject
})
let desktopOutputBuffer = ''
let lastCoreProbe
let runtimePackageEvidence
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

  const persistencePackage = '@deepseek-ai/dsh-session-persistence-jsonl'
  runtimePackageEvidence = {
    source: inspectRuntimePackage(dshRoot, persistencePackage),
    developmentProject: inspectRuntimePackage(project, persistencePackage),
  }
  if (!runtimePackageEvidence.developmentProject.packageJsonExists
    || !runtimePackageEvidence.developmentProject.mainExists
    || !runtimePackageEvidence.developmentProject.resolved) {
    throw new Error(`Desktop development runtime is missing ${persistencePackage}: ${JSON.stringify(runtimePackageEvidence)}`)
  }

  cpSync(join(dshRoot, 'packages/skill/skill-office/assets'), join(runtimeRoot, 'office-skills'), { recursive: true })
  const nodeDir = join(primaryRuntime, 'dependencies/node/bin')
  mkdirSync(nodeDir, { recursive: true })
  cpSync(process.execPath, join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'))

  const paths = resolveDesktopPaths(home)
  const manager = new DesktopProjectManager(paths, { dsh: project })
  await manager.applyRelease()

  const coreProbeFixture = writeHostCoreProbeFixture(join(root, 'core-probe-fixture'))
  const manifestPath = join(paths.profile, 'package.json')
  const manifest = readJson(manifestPath)
  manifest.dependencies['dsh-vision-router'] = `file:${dvrRoot}`
  manifest.dependencies[coreProbeFixture.name] = `file:${coreProbeFixture.directory}`
  if (!manifest.dsh.profile.bundles.includes('dsh-vision-router')) manifest.dsh.profile.bundles.push('dsh-vision-router')
  manifest.dsh.profile.bundles.push(coreProbeFixture.name)
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
    DVR_E2E_684_RACE: raceMode ? '1' : '0',
    DVR_E2E_684_RACE_TOKEN: raceToken,
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
  const observeDesktopOutput = (chunk, target) => {
    const text = String(chunk)
    target.write(`[desktop] ${text}`)
    desktopOutputBuffer = (desktopOutputBuffer + text).slice(-16_384)
    const match = /dsh web:\s*(https?:\/\/[^\s]+)/i.exec(desktopOutputBuffer)
    if (match) resolveAuthenticatedHostUrl(match[1])
  }
  child.stdout?.on('data', (chunk) => observeDesktopOutput(chunk, process.stdout))
  child.stderr?.on('data', (chunk) => observeDesktopOutput(chunk, process.stderr))
  child.once('exit', (code, signal) => {
    rejectAuthenticatedHostUrl(new Error(`Desktop exited before Host URL became available (${String(code ?? signal)})`))
  })

  browser = await waitForCdp(rendererPort)
  page = await waitForAppPage(browser)
  page.on('pageerror', (error) => rendererErrors.push(String(error?.stack || error)))
  const boot = await page.evaluate(async () => await window.dshDesktopBoot.ready())
  const authenticatedHostUrl = await Promise.race([
    authenticatedHostUrlPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Desktop Host URL was not reported')), 30_000)),
  ])
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
  const toggle = await waitForVisionToggle(page, authenticatedHostUrl)
  if (!existsSync(workspace)) throw new Error(`Desktop did not initialize the pinned default workspace: ${workspace}`)
  await exerciseVisionOnboardingSettingsPath(page)

  const initialPressed = await toggle.getAttribute('aria-pressed')
  if (initialPressed !== 'true' && initialPressed !== 'false') {
    throw new Error(`Vision toggle began without an authoritative pressed state: ${String(initialPressed)}`)
  }
  const toggledPressed = initialPressed === 'true' ? 'false' : 'true'
  const inspectToggleState = async () => await page.evaluate(() => {
    const node = document.querySelector('[data-vision-router-mode-toggle="true"]')
    if (!node) return { present: false }
    return {
      present: true,
      pressed: node.getAttribute('aria-pressed'),
      busy: node.getAttribute('aria-busy'),
      disabled: node.disabled === true,
      label: node.getAttribute('aria-label'),
      title: node.title,
    }
  })
  // Observe every relevant mutation, not only the state at two timestamps.
  await page.evaluate(installDesktopVisionToggleAudit)
  const waitForSettledVisionState = async (expected, direction) => {
    const deadline = Date.now() + 30_000
    try {
      // A real continuous UI-ready window: MutationObserver invalidates any
      // interval interrupted by busy/loading, disabling or node replacement.
      // Preserve the one original 30s deadline and exactly two user clicks.
      await page.waitForFunction((target) =>
        window.__dvrDesktopToggleAudit?.stableFor(target, 300) === true,
        expected,
        { timeout: Math.max(1, deadline - Date.now()) })
    } catch (error) {
      const observed = await inspectToggleState().catch(() => ({ unavailable: true }))
      const buttonHistory = await page.evaluate(() =>
        window.__dvrDesktopToggleAudit?.history?.slice(-48) ?? [],
      ).catch(() => [])
      const stability = await page.evaluate(() =>
        window.__dvrDesktopToggleAudit?.stabilitySummary() ?? null,
      ).catch(() => null)
      // A missing second model/selection event means that the OFF click was
      // not accepted by the Host. Two accepted events with the UI still ON
      // point to a client projection or later Host reset instead. Keep the
      // probe read-only and protect the original timeout as the root error.
      const hostSelections = await readHostModelSelections(authenticatedHostUrl)
        .catch((failure) => ({ unavailable: String(failure?.message ?? failure).slice(0, 200) }))
      const clientDirectory = await readClientModelDirectory(page)
        .catch(() => ({ available: false, reason: 'browser-evaluate-failed' }))
      const clientTransitions = await page.evaluate(() => ({
        available: window.__dvrDesktopModelTrace?.available === true,
        changed: window.__dvrDesktopModelTrace?.directoryChanged?.() ?? null,
        history: window.__dvrDesktopModelTrace?.history?.slice(-64) ?? [],
      })).catch(() => ({ available: false, history: [] }))
      throw new Error(
        `Desktop Vision toggle did not settle (${direction}, expected=${expected}, observed=${JSON.stringify(observed)}, buttonHistory=${JSON.stringify(buttonHistory)}, stability=${JSON.stringify(stability)}, hostSelections=${JSON.stringify(hostSelections)}, clientDirectory=${JSON.stringify(clientDirectory)}, clientTransitions=${JSON.stringify(clientTransitions)})`,
        { cause: error },
      )
    }
  }
  // Do not start an adversarial double-toggle during the Host's initial
  // model-catalog hydration. The initial state must be stably actionable too.
  await waitForSettledVisionState(initialPressed, 'initial ready baseline')
  await page.evaluate(installDesktopModelSelectionTrace)
  const traceReady = await page.evaluate(() => window.__dvrDesktopModelTrace?.available === true)
  assert.equal(traceReady, true, 'Desktop selection transition trace was not attached to Host ModelDirectory')
  await page.evaluate(() => window.__dvrDesktopToggleAudit?.record('first click'))
  await toggle.click()
  if (raceMode) {
    // Only the isolated lab restores the original fast click cadence.
    // No additional user clicks or retries occur in either execution path.
    await page.waitForFunction((pressed) => {
      const button = document.querySelector('[data-vision-router-mode-toggle="true"]')
      return button?.getAttribute('aria-pressed') === pressed
        && button.getAttribute('aria-busy') !== 'true' && !button.disabled
    }, toggledPressed, { timeout: 30000 })
    assert.equal(initialPressed, 'false', 'The OFF-return lab requires a fresh OFF baseline')
    const first = await readHostModelSelections(authenticatedHostUrl)
    assert.ok(first.sessions.some((session) => session.latest.some(
      (event) => event?.provider === 'desktop-e2e-vision')),
      'Initial ON must be durably committed before arming the real Host race')
    if (raceMode === 'postcommit-reset') await install684PostCommitAckGate(page)
    else await control684HostRace(authenticatedHostUrl, raceToken, 'arm')
    await page.evaluate(() => window.__dvrDesktopToggleAudit?.record('experiment return click'))
  } else {
    await waitForSettledVisionState(toggledPressed, 'first transition')
    await page.evaluate(() => window.__dvrDesktopToggleAudit?.record('return click'))
  }
  // Exactly two click sites in the file: this shared return and initial ON.
  await toggle.click()
  if (raceMode) {
    if (raceMode === 'postcommit-reset') {
      await page.waitForFunction(() =>
        window.__dvr684PostCommitAckGate?.entered === true, null, { timeout: 15000 })
      const accepted = await page.evaluate(() => window.__dvr684PostCommitAckGate?.accepted === true)
      assert.equal(accepted, true, 'Real Host OFF selection was rejected before client acknowledgement gate')
      const hostCommitted = await readHostModelSelections(authenticatedHostUrl)
      assert.ok(hostCommitted.sessions.some((session) =>
        session.latest.slice(-1).some((event) => event?.provider === 'desktop-e2e')),
        'The Host must have durably accepted OFF before client acknowledgement is held')
      console.log('[issue-684-host-race] ' + JSON.stringify({
        mode: raceMode, stage: 'host-committed-client-ack-held',
        directory: await readClientModelDirectory(page), hostSelections: hostCommitted,
      }))
      try {
        const injected = await experiment684DirectoryAction(page, 'reset')
        console.log('[issue-684-host-race] ' + JSON.stringify({ mode: raceMode, stage: 'injected', injected }))
      } finally {
        await page.evaluate(() => window.__dvr684PostCommitAckGate?.release?.())
      }
    } else {
      const gate = await waitFor684HostGate(authenticatedHostUrl, raceToken)
      const blocked = await readHostModelSelections(authenticatedHostUrl)
      assert.ok(blocked.sessions.every((session) =>
        !session.latest.slice(-1).some((event) => event?.provider === 'desktop-e2e')),
        'The return selection committed BEFORE its controlled Host pre-commit gate')
      console.log('[issue-684-host-race] ' + JSON.stringify({
        mode: raceMode, stage: 'blocked', gate, directory: await readClientModelDirectory(page),
        hostSelections: blocked,
      }))
      try {
        const injected = await experiment684DirectoryAction(page, raceMode)
        console.log('[issue-684-host-race] ' + JSON.stringify({ mode: raceMode, stage: 'injected', injected }))
      } finally {
        await control684HostRace(authenticatedHostUrl, raceToken, 'release')
      }
    }
    await waitForSettledVisionState(initialPressed, 'return transition')
    if (raceMode === 'postcommit-reset') {
      await page.evaluate(() => window.__dvr684PostCommitAckGate?.restore?.())
    }
    console.log('[issue-684-host-race] ' + JSON.stringify({
      mode: raceMode, stage: 'settled', directory: await readClientModelDirectory(page),
      hostSelections: await readHostModelSelections(authenticatedHostUrl),
      transitions: await page.evaluate(() => window.__dvrDesktopModelTrace?.history?.slice(-32) ?? []),
    }))
  } else {
    await waitForSettledVisionState(initialPressed, 'return transition')
  }
  // Positive control for the diagnostic itself: this real Desktop session
  // must have committed both opposite selections to the Host event log.
  // Otherwise the timeout-only forensic probe could silently report no events
  // even when the UI transitions, making a later failure uninterpretable.
  const selectionProbe = await readHostModelSelections(authenticatedHostUrl)
  const expectedProviders = initialPressed === 'true'
    ? ['desktop-e2e', 'desktop-e2e-vision']
    : ['desktop-e2e-vision', 'desktop-e2e']
  const committedSession = selectionProbe.sessions.find((session) => {
    const latest = session.latest
    if (!Array.isArray(latest) || latest.length < 2) return false
    const lastTwo = latest.slice(-2)
    return lastTwo.every((event, index) =>
      event?.provider === expectedProviders[index] && event.model === 'desktop-text')
  })
  assert.ok(committedSession,
    `Desktop Host selection forensic probe missed the accepted two-way toggle: ${JSON.stringify(selectionProbe)}`)
  // alpha.2 exposes the raw state (pending/lastUsed) here, not the wire's
  // computed next. Positive-control our derived next against the settled mode.
  if (dshVersion === '0.2.1-alpha.2') {
    assert.equal(committedSession.projected?.next?.provider,
      initialPressed === 'true' ? 'desktop-e2e-vision' : 'desktop-e2e',
      `Host model-selection projection next disagrees with settled toggle: ${JSON.stringify(committedSession.projected)}`)
    assert.equal(committedSession.projected?.next?.model, 'desktop-text')
  }
  // Verify that the optional browser probe actually resolves a successful
  // authoritative directory; a fiber-shaped but wrong component is not proof.
  const clientDirectory = await readClientModelDirectory(page)
  assert.equal(clientDirectory.available, true,
    `Desktop browser directory probe unavailable: ${JSON.stringify(clientDirectory)}`)
  assert.equal(clientDirectory.current?.provider, initialPressed === 'true'
    ? 'desktop-e2e-vision' : 'desktop-e2e')
  assert.equal(clientDirectory.current?.model, 'desktop-text')
  // Positive-control the trace against the real two-way Desktop transition.
  const clientTransitions = await page.evaluate(() =>
    window.__dvrDesktopModelTrace?.history?.slice(-64) ?? [])
  assert.ok(expectedProviders.every((provider) => clientTransitions.some((row) =>
    row.current?.provider === provider && row.current.model === 'desktop-text')),
    `Desktop selection transition trace did not observe both models: ${JSON.stringify(clientTransitions)}`)

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

  const sessionSourceProbe = await readHostSessionSources(authenticatedHostUrl)
  const v4Sessions = (sessionSourceProbe.sessions ?? []).filter((session) => session.version === 4)
  assert.ok(v4Sessions.length > 0, 'Desktop E2E must exercise at least one Session format v4 conversation')
  const dvrSources = v4Sessions.flatMap((session) => session.sources ?? [])
  assert.ok(
    dvrSources.some((source) => source?.kind === 'plugin:dsh-vision-router'),
    `real Session v4 log must contain a producer-owned DVR source: ${JSON.stringify(sessionSourceProbe)}`,
  )
  assert.equal(
    dvrSources.some((source) => source?.kind === 'plugin' && source?.plugin === 'dsh-vision-router'),
    false,
    `real Session v4 log must never persist DVR's legacy shared plugin source: ${JSON.stringify(sessionSourceProbe)}`,
  )
  const dvrMessages = v4Sessions.flatMap((session) => session.messages ?? [])
  assert.ok(
    dvrMessages.length > 0,
    `real Session v4 log must expose at least one DVR-authored durable message by id: ${JSON.stringify(sessionSourceProbe)}`,
  )
  for (const message of dvrMessages) {
    assert.equal(
      message.source?.kind,
      'plugin:dsh-vision-router',
      `every DVR-authored Session v4 message must carry the producer-owned source: ${JSON.stringify(message)}`,
    )
    assert.equal(
      message.source?.plugin,
      undefined,
      `DVR-authored Session v4 messages must not retain the legacy plugin field: ${JSON.stringify(message)}`,
    )
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
    onboarding: { settingsPath: true },
    settings: { remoteWarning: false, saved: expectedChecked, reloadReadback: expectedChecked, restored: originalChecked },
    functionalVisionTurn: { textEvidence, visionEvidence, rendered: 'DESKTOP_VISION_E2E_OK' },
  }
  console.log(JSON.stringify(result))
  if (diagnosticPath) {
    const fileResult = {
      ok: true,
      dsh: dshVersion,
      platform: process.platform,
      arch: process.arch,
      structuredMarkers: markers.length,
      toggle: result.toggle,
      settings: result.settings,
      functionalVisionTurn: { ...fileSafeTurnEvidence(textEvidence, visionEvidence), rendered: 'DESKTOP_VISION_E2E_OK' },
    }
    writeFileSync(diagnosticPath, `${JSON.stringify(fileResult, undefined, 2)}\n`)
  }
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
  const failure = {
    ok: false,
    error: String(error?.stack || error),
    rendererErrors,
    textEvidence,
    visionEvidence,
    coreProbe: lastCoreProbe,
    runtimePackageEvidence,
    failureState,
  }
  console.error(JSON.stringify(failure, undefined, 2))
  if (diagnosticPath) {
    const fileFailure = {
      ok: false,
      failureKind: lastCoreProbe !== undefined
        && (lastCoreProbe?.services?.workspaceController?.active !== true
          || lastCoreProbe?.services?.sessionController?.active !== true)
        ? 'host-control-plane-unavailable'
        : 'desktop-e2e-failed',
      rendererErrorCount: rendererErrors.length,
      functionalVisionTurn: fileSafeTurnEvidence(textEvidence, visionEvidence),
      coreProbe: fileSafeCoreProbe(lastCoreProbe),
      runtimePackageEvidence: fileSafeRuntimePackageEvidence(runtimePackageEvidence),
      failureState: fileSafeFailureState(failureState),
    }
    try { writeFileSync(diagnosticPath, `${JSON.stringify(fileFailure, undefined, 2)}\n`) } catch {}
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

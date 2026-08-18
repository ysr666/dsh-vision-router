import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createSecureHtmlScreenshotExecute,
  fullPageHeightOf,
  HtmlScreenshotGovernor,
  htmlRequestAllowed,
  installAdversarialHardening,
  normalizeArtifactsDir,
  sameOriginRequest,
  wakePageForFullCaptureBounded,
} from '../lib/adversarial-hardening.js'
import { installLocalVisionStabilizer } from '../lib/local-vision-stabilizer.js'

test('normalizeArtifactsDir keeps artifacts inside the workspace', () => {
  assert.equal(normalizeArtifactsDir('.dsh-vision-router/artifacts'), path.normalize('.dsh-vision-router/artifacts'))
  assert.equal(normalizeArtifactsDir('screenshots/out'), path.normalize('screenshots/out'))
  assert.equal(normalizeArtifactsDir('../escape'), '.dsh-vision-router/artifacts')
  assert.equal(normalizeArtifactsDir('safe/../../escape'), '.dsh-vision-router/artifacts')
  assert.equal(normalizeArtifactsDir('/tmp/escape'), '.dsh-vision-router/artifacts')
  assert.equal(normalizeArtifactsDir('C:\\escape'), '.dsh-vision-router/artifacts')
})

test('sameOriginRequest rejects cross-site browser requests while allowing same-origin and non-browser calls', () => {
  assert.equal(sameOriginRequest({ headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } }), true)
  assert.equal(sameOriginRequest({ headers: { host: '127.0.0.1:3000', origin: 'https://evil.example' } }), false)
  assert.equal(sameOriginRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(sameOriginRequest({ headers: {} }), true)
})

test('htmlRequestAllowed permits only local-root/data/blob/about resources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-hardening-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'vision-hardening-outside-'))
  try {
    const insideFile = path.join(root, 'asset.png')
    const outsideFile = path.join(outside, 'secret.txt')
    await writeFile(insideFile, 'x')
    await writeFile(outsideFile, 'secret')
    assert.equal(htmlRequestAllowed(pathToFileURL(insideFile).href, root), true)
    assert.equal(htmlRequestAllowed(pathToFileURL(outsideFile).href, root), false)
    assert.equal(htmlRequestAllowed('data:text/plain,ok', root), true)
    assert.equal(htmlRequestAllowed('blob:null/abc', root), true)
    assert.equal(htmlRequestAllowed('about:blank', root), true)
    assert.equal(htmlRequestAllowed('https://example.com/track', root), false)
    assert.equal(htmlRequestAllowed('http://127.0.0.1:11434/api/tags', root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('secure HTML screenshot keeps Chrome sandbox enabled, forces offline mode and writes under workspace', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vision-html-'))
  try {
    const source = path.join(workspace, 'page.html')
    await writeFile(source, '<html><body>Hello</body></html>')
    let launchOptions
    let requestHandler
    let offline = false
    let closed = false
    const scrollTargets = []
    const page = {
      async setViewport(value) { assert.deepEqual(value, { width: 1200, height: 720 }) },
      async setOfflineMode(value) { offline = value },
      async setRequestInterception(value) { assert.equal(value, true) },
      on(event, handler) {
        assert.equal(event, 'request')
        requestHandler = handler
      },
      async goto(url) { assert.equal(url, pathToFileURL(source).href) },
      async evaluate(fn, arg) {
        const sourceText = fn.toString()
        if (sourceText.includes('scrollHeight')) return 1500
        if (sourceText.includes('scrollTo') && arg !== undefined) scrollTargets.push(arg)
        return undefined
      },
      async screenshot(options) {
        assert.deepEqual(options, { type: 'png', fullPage: true })
        return Buffer.from('png-bytes')
      },
    }
    const fakePuppeteer = {
      async launch(options) {
        launchOptions = options
        return {
          async newPage() { return page },
          async close() { closed = true },
        }
      },
    }
    const ctx = {
      get(name) {
        if (name !== 'fs') return undefined
        return { async resolve(value) { return value } }
      },
    }
    const core = {
      toRealPath(_fs, value) { return value },
      chromiumCandidates() { return ['/fake/chrome'] },
      artifactStemOf() { return 'page-safe-shot' },
    }
    const execute = createSecureHtmlScreenshotExecute(
      ctx,
      core,
      { artifactsDir: '../escape' },
      {
        importPuppeteer: async () => fakePuppeteer,
        existsSync(value) { return value === source || value === '/fake/chrome' },
        realpathSync(value) { return value },
        sleep: async () => {},
      },
    )
    const result = JSON.parse(await execute(
      { source, fullPage: true },
      { agent: { session: { header: { cwd: workspace } } } },
    ))
    assert.ok(launchOptions)
    assert.equal(launchOptions.args.includes('--no-sandbox'), false)
    assert.equal(offline, true)
    assert.equal(typeof requestHandler, 'function')
    assert.equal(closed, true)
    assert.equal(result.pageHeight, 1500)
    assert.deepEqual(scrollTargets, [0, 720, 1440])
    assert.equal(path.relative(workspace, result.path).startsWith('..'), false)
    assert.equal((await readFile(result.path)).toString(), 'png-bytes')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('fullPageHeightOf falls back to the viewport height for empty pages', async () => {
  const page = {
    async evaluate(fn) {
      const runner = new Function('document', 'window', `return (${fn.toString()})()`)
      return runner(
        { documentElement: { scrollHeight: 0 }, body: { scrollHeight: 0 } },
        { innerHeight: 800 },
      )
    },
  }
  assert.equal(await fullPageHeightOf(page), 800)
})

test('full-page wake rejects an oversized static page before the first scroll', async () => {
  let scrolls = 0
  const page = {
    async evaluate(fn, arg) {
      const sourceText = fn.toString()
      if (sourceText.includes('scrollHeight')) return 100_000
      if (sourceText.includes('scrollTo') && arg !== undefined) scrolls += 1
      return undefined
    },
  }
  await assert.rejects(
    wakePageForFullCaptureBounded(page, 720, 1200, { sleep: async () => {} }),
    /pixel safety limit/,
  )
  assert.equal(scrolls, 0, 'pixel admission must happen before expensive wake scrolling')
})

test('full-page wake bounds dynamically growing pages even below the initial pixel ceiling', async () => {
  let height = 1000
  let scrolls = 0
  const page = {
    async evaluate(fn, arg) {
      const sourceText = fn.toString()
      if (sourceText.includes('scrollHeight')) return height
      if (sourceText.includes('scrollTo') && arg !== undefined) {
        scrolls += 1
        height += 720
      }
      return undefined
    },
  }
  await assert.rejects(
    wakePageForFullCaptureBounded(page, 720, 320, {
      sleep: async () => {},
      now: () => 0,
      maxSteps: 3,
      maxWakeMs: 15_000,
    }),
    /3-step/,
  )
  assert.equal(scrolls, 3)
})

test('HTML screenshot governor caps active browser slots and drains FIFO', async () => {
  const governor = new HtmlScreenshotGovernor({ maxConcurrent: 2 })
  const releaseA = await governor.acquire()
  const releaseB = await governor.acquire()
  assert.deepEqual(governor.stats(), { maxConcurrent: 2, active: 2, queued: 0 })

  let thirdGranted = false
  const third = governor.acquire().then((release) => {
    thirdGranted = true
    return release
  })
  await Promise.resolve()
  assert.equal(thirdGranted, false)
  assert.equal(governor.stats().queued, 1)

  releaseA()
  const releaseC = await third
  assert.equal(thirdGranted, true)
  assert.equal(governor.stats().active, 2)
  releaseB()
  releaseC()
  assert.equal(governor.stats().active, 0)
})

test('non-fullPage capture skips the scroll wake', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vision-html-nofull-'))
  try {
    const source = path.join(workspace, 'page.html')
    await writeFile(source, '<html><body>Hello</body></html>')
    let evaluateCalls = 0
    const page = {
      async setViewport() {},
      async setOfflineMode() {},
      async setRequestInterception(value) { assert.equal(value, true) },
      on() {},
      async goto(url) { assert.equal(url, pathToFileURL(source).href) },
      async evaluate() { evaluateCalls += 1 },
      async screenshot(options) {
        assert.deepEqual(options, { type: 'png' })
        return Buffer.from('png-bytes')
      },
    }
    const fakePuppeteer = {
      async launch() {
        return {
          async newPage() { return page },
          async close() {},
        }
      },
    }
    const ctx = {
      get(name) {
        if (name !== 'fs') return undefined
        return { async resolve(value) { return value } }
      },
    }
    const core = {
      toRealPath(_fs, value) { return value },
      chromiumCandidates() { return ['/fake/chrome'] },
      artifactStemOf() { return 'page-safe-shot' },
    }
    const execute = createSecureHtmlScreenshotExecute(
      ctx,
      core,
      {},
      {
        importPuppeteer: async () => fakePuppeteer,
        existsSync(value) { return value === source || value === '/fake/chrome' },
        realpathSync(value) { return value },
      },
    )
    const result = JSON.parse(await execute(
      { source },
      { agent: { session: { header: { cwd: workspace } } } },
    ))
    assert.equal(evaluateCalls, 0)
    assert.equal(result.pageHeight, undefined)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('secure HTML screenshot rejects oversized viewport before launching Chrome', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vision-html-size-'))
  try {
    const source = path.join(workspace, 'page.html')
    await writeFile(source, '<html></html>')
    let launched = false
    const ctx = {
      get() { return { async resolve(value) { return value } } },
    }
    const core = {
      toRealPath(_fs, value) { return value },
      chromiumCandidates() { return ['/fake/chrome'] },
      artifactStemOf() { return 'x' },
    }
    const execute = createSecureHtmlScreenshotExecute(ctx, core, {}, {
      importPuppeteer: async () => ({ async launch() { launched = true } }),
      existsSync(value) { return value === source || value === '/fake/chrome' },
      realpathSync(value) { return value },
    })
    await assert.rejects(
      execute({ source, width: 100000 }, { agent: { session: { header: { cwd: workspace } } } }),
      /width must be an integer between/,
    )
    assert.equal(launched, false)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('real screenshot permission route rejects cross-origin POSTs without proxying the webServer child context', async () => {
  let route
  let seenWebChild
  const webCtx = {
    webServer: {
      register(spec) {
        route = spec
        return () => {}
      },
    },
    effect(factory) { return factory() },
  }
  const ctx = {
    tools: { register() { return () => {} } },
    llm: { registerAdapter() { return () => {} } },
    logger: { warn() {}, info() {}, error() {} },
    get() { return undefined },
    inject(deps, callback) {
      if (deps.includes('webServer')) {
        seenWebChild = webCtx
        callback(webCtx)
      }
    },
    effect(factory) { return factory() },
  }
  const core = {
    localProvidersOf() { return [] },
    classifyVisionFailure() { return { kind: 'other' } },
    VISION_FAILURE_KINDS: {},
  }
  const { ctx: stabilized } = installLocalVisionStabilizer(ctx, { desktopScreenshot: true }, core)
  let callbackChild
  stabilized.inject(['webServer'], (child) => { callbackChild = child })
  assert.equal(callbackChild, seenWebChild)
  assert.ok(route)

  let status
  await route.handler(
    {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    },
    {
      setHeader() {},
      writeHead(code) { status = code },
      end() {},
    },
  )
  assert.equal(status, 403)
})

test('proxy fetch cleanup becomes inert under later plugin patches and cannot resurface', () => {
  const hostFetch = () => 'host'
  const savedFetch = globalThis.fetch
  const patchA = () => 'a'
  let cleanup
  const ctx = {
    tools: { register() {} },
    effect(factory) {
      cleanup = factory()
      return () => {}
    },
  }
  try {
    globalThis.fetch = hostFetch
    const { ctx: hardened } = installAdversarialHardening(ctx, {}, {})
    hardened.effect(() => {
      globalThis.fetch = patchA
      return () => { globalThis.fetch = hostFetch }
    }, 'vision-router: proxy fetch')
    const guardedFetch = globalThis.fetch
    assert.notEqual(guardedFetch, patchA)
    assert.equal(guardedFetch(), 'a')

    const laterPatch = (...args) => guardedFetch(...args)
    globalThis.fetch = laterPatch
    cleanup()
    assert.equal(globalThis.fetch, laterPatch)
    // Simulate the later plugin unloading and restoring the fetch value it
    // captured. Vision Router's guard must remain inert instead of resurfacing.
    globalThis.fetch = guardedFetch
    assert.equal(globalThis.fetch(), 'host')
  } finally {
    globalThis.fetch = savedFetch
  }
})

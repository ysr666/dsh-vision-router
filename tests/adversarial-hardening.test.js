import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createSecureHtmlScreenshotExecute,
  htmlRequestAllowed,
  installAdversarialHardening,
  normalizeArtifactsDir,
  sameOriginRequest,
} from '../lib/adversarial-hardening.js'

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

test('secure HTML screenshot keeps Chrome sandbox enabled, intercepts requests and writes under workspace', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vision-html-'))
  try {
    const source = path.join(workspace, 'page.html')
    await writeFile(source, '<html><body>Hello</body></html>')
    let launchOptions
    let requestHandler
    let closed = false
    const page = {
      async setViewport(value) { assert.deepEqual(value, { width: 1200, height: 720 }) },
      async setRequestInterception(value) { assert.equal(value, true) },
      on(event, handler) {
        assert.equal(event, 'request')
        requestHandler = handler
      },
      async goto(url) { assert.equal(url, pathToFileURL(source).href) },
      async evaluate() { return 1500 },
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
      },
    )
    const result = JSON.parse(await execute(
      { source, fullPage: true },
      { agent: { session: { header: { cwd: workspace } } } },
    ))
    assert.ok(launchOptions)
    assert.equal(launchOptions.args.includes('--no-sandbox'), false)
    assert.equal(typeof requestHandler, 'function')
    assert.equal(closed, true)
    assert.equal(result.pageHeight, 1500)
    assert.equal(path.relative(workspace, result.path).startsWith('..'), false)
    assert.equal((await readFile(result.path)).toString(), 'png-bytes')
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

test('hardening wrapper protects screenshot permission POST from cross-origin callers', async () => {
  let registered
  let originalCalls = 0
  const webServer = {
    register(def) {
      registered = def
      return () => {}
    },
  }
  const child = { webServer }
  const ctx = {
    tools: { register() {} },
    inject(_services, callback) { callback(child) },
  }
  const { ctx: hardened } = installAdversarialHardening(ctx, {}, {})
  hardened.inject(['webServer'], (ownerCtx) => {
    ownerCtx.webServer.register({
      path: '/_dsh/vision-router/request-screenshot-permission',
      async handler(_req, res) {
        originalCalls += 1
        res.writeHead(200)
        res.end('ok')
      },
    })
  })
  const responses = []
  const res = {
    writeHead(status) { responses.push(status) },
    end() {},
  }
  await registered.handler(
    { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } },
    res,
  )
  assert.equal(responses.at(-1), 403)
  assert.equal(originalCalls, 0)
  await registered.handler(
    { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' } },
    res,
  )
  assert.equal(originalCalls, 1)
})

test('proxy fetch cleanup never removes a later plugin fetch patch', () => {
  const originalFetch = globalThis.fetch
  const patchA = () => 'a'
  const patchB = () => 'b'
  let cleanup
  const ctx = {
    tools: { register() {} },
    effect(factory) {
      cleanup = factory()
      return () => {}
    },
  }
  try {
    const { ctx: hardened } = installAdversarialHardening(ctx, {}, {})
    hardened.effect(() => {
      globalThis.fetch = patchA
      return () => { globalThis.fetch = originalFetch },
    }, 'vision-router: proxy fetch')
    assert.equal(globalThis.fetch, patchA)
    globalThis.fetch = patchB
    cleanup()
    assert.equal(globalThis.fetch, patchB)
  } finally {
    globalThis.fetch = originalFetch
  }
})

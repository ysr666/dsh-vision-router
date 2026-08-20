import assert from 'node:assert/strict'
import test from 'node:test'

import { createSecureHtmlScreenshotExecute } from '../lib/adversarial-hardening.js'

function screenshotHarness({ hangGoto = false } = {}) {
  const resolveCalls = []
  const sourceTarget = { targetKey: '/workspace/page.html', displayPath: '/workspace/page.html' }
  const workspaceTarget = { targetKey: '/workspace', displayPath: '/workspace' }
  let closeCalls = 0
  let artifactWrites = 0
  let rejectGoto

  const fs = {
    async resolve(value, options) {
      resolveCalls.push([value, options])
      if (value === '/workspace') return workspaceTarget
      if (value === 'page.html' && options?.cwd === '/workspace') return sourceTarget
      return { targetKey: '/default/page.html', displayPath: '/default/page.html' }
    },
    contains(parent, child) {
      return parent === workspaceTarget && child === sourceTarget
    },
  }

  const page = {
    async setViewport() {},
    async setOfflineMode() {},
    async setRequestInterception() {},
    on() {},
    async goto() {
      if (!hangGoto) return
      return new Promise((_resolve, reject) => { rejectGoto = reject })
    },
    async screenshot() { return Buffer.from('png') },
  }
  const browser = {
    async newPage() { return page },
    async close() {
      closeCalls += 1
      if (rejectGoto) {
        const reject = rejectGoto
        rejectGoto = undefined
        reject(new Error('browser closed'))
      }
    },
  }
  const launcher = { async launch() { return browser } }
  const ctx = { get(name) { return name === 'fs' ? fs : undefined } }
  const core = {
    toRealPath(_fs, target) { return target.targetKey },
    chromiumCandidates() { return ['/chrome'] },
    artifactStemOf() { return 'shot' },
  }
  const execute = createSecureHtmlScreenshotExecute(ctx, core, { artifactsDir: '.artifacts' }, {
    importPuppeteer: async () => launcher,
    existsSync: () => true,
    realpathSync: (value) => value,
    async mkdir() {},
    async writeFile() { artifactWrites += 1 },
  })

  return {
    execute,
    resolveCalls,
    get closeCalls() { return closeCalls },
    get artifactWrites() { return artifactWrites },
  }
}

test('secure screenshot renders the same session-cwd target that passed containment', async () => {
  const harness = screenshotHarness()
  const result = JSON.parse(await harness.execute({ source: 'page.html' }, {
    agent: { session: { header: { cwd: '/workspace' } } },
  }))

  assert.equal(result.path, '/workspace/.artifacts/shot.png')
  const sourceResolutions = harness.resolveCalls.filter(([value]) => value === 'page.html')
  assert.equal(sourceResolutions.length, 1, 'renderer must not resolve the source string a second time')
  assert.equal(sourceResolutions[0][1].cwd, '/workspace')
})

test('aborting an active secure screenshot closes Chrome and prevents artifact publication', async () => {
  const harness = screenshotHarness({ hangGoto: true })
  const controller = new AbortController()
  const pending = harness.execute({ source: 'page.html' }, {
    signal: controller.signal,
    agent: { session: { header: { cwd: '/workspace' } } },
  })

  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(
    pending,
    (error) => error?.code === 'ABORT_ERR',
  )
  assert.equal(harness.closeCalls, 1)
  assert.equal(harness.artifactWrites, 0)
})

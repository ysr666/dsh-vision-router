import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

import { CAPABILITY_BENCHMARK_CLIENT } from '../lib/vision-capability-benchmark-client.js'

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH

async function withBrowserPage(run) {
  assert.ok(executablePath, 'PUPPETEER_EXECUTABLE_PATH or CHROME_PATH is required')
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><head></head><body></body></html>')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' })
    await run(page)
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('real Chromium: benchmark controls survive shell documentElement replacement without manual events', async () => {
  await withBrowserPage(async (page) => {
    await page.evaluate(() => {
      window.fetch = async () => ({
        ok: true,
        async json() {
          return {
            ok: true,
            candidates: [{
              provider: 'demo-provider',
              model: 'demo-vision',
              key: 'demo-provider/demo-vision',
              benchmarkable: true,
              presentation: { background: { state: 'waiting' } },
            }],
            jobs: [],
          }
        },
      })
    })
    await page.addScriptTag({ content: CAPABILITY_BENCHMARK_CLIENT })

    // Replace the complete shell root first, then lazily mount General later.
    // No change/click/input event is dispatched anywhere in this test.
    await page.evaluate(() => {
      const html = document.createElement('html')
      html.lang = 'zh-CN'
      html.append(document.createElement('head'), document.createElement('body'))
      document.replaceChild(html, document.documentElement)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    await page.evaluate(() => {
      const chain = document.createElement('div')
      chain.id = 'vr-vision-backend-chain'
      const row = document.createElement('div')
      row.className = 'vr-chain-row'

      const provider = document.createElement('select')
      const providerOption = document.createElement('option')
      providerOption.value = 'demo-provider'
      providerOption.textContent = 'Demo provider'
      provider.appendChild(providerOption)
      provider.value = 'demo-provider'

      const model = document.createElement('select')
      const modelOption = document.createElement('option')
      modelOption.value = 'demo-vision'
      modelOption.textContent = 'Demo vision'
      model.appendChild(modelOption)
      model.value = 'demo-vision'

      row.append(provider, model)
      chain.appendChild(row)
      document.body.appendChild(chain)
    })

    await page.waitForSelector('#vr-vision-backend-chain [data-vr-capability-control="1"]', { timeout: 3000 })
    const state = await page.evaluate(() => ({
      controls: document.querySelectorAll('#vr-vision-backend-chain [data-vr-capability-control="1"]').length,
      status: document.querySelector('[data-vr-capability-status]')?.textContent || '',
    }))
    assert.equal(state.controls, 1)
    assert.match(state.status, /等待后台测评|Waiting for background benchmark/)
  })
})

test('real Chromium: guide completion persists onboardingSeen and clears active guide state', async () => {
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  await withBrowserPage(async (page) => {
    await page.evaluate(() => {
      window.__dvrSpec = undefined
      window.__ModuleLoader__ = {
        load(spec) {
          window.__dvrSpec = spec
          return spec
        },
      }
    })
    await page.addScriptTag({ content: clientSource })

    const result = await page.evaluate(async () => {
      const ReactStub = {
        useState(initial) { return [initial, () => {}] },
        useMemo(factory) { return factory() },
        useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
        createElement() { return null },
      }
      const bundle = window.__dvrSpec.factory((name) => {
        if (name === 'react') return ReactStub
        if (name === '@deepseek-ai/dsh-client-ui-attachment') return { ImageGallery() { return null } }
        throw new Error(`unexpected require: ${name}`)
      })

      const value = {}
      const user = {}
      const listeners = new Set()
      const writes = []
      const scope = {
        getSnapshot() { return { status: 'ready', writable: true, value: { ...value }, user: { ...user } } },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async set(field, next) {
          writes.push(['set', field, next])
          value[field] = next
          user[field] = next
          listeners.forEach((listener) => listener())
        },
        async unset(field) {
          writes.push(['unset', field])
          delete value[field]
          delete user[field]
          listeners.forEach((listener) => listener())
        },
        async load() {},
      }
      const noop = () => {}
      const ctx = {
        settingsScope: { bind() { return scope } },
        slots: { register() { return noop } },
        locale: { define() {} },
        sessions: {},
        remote: {},
        effect() { return noop },
        on() { return noop },
        get() { return undefined },
      }

      bundle.apply(ctx)
      window.localStorage.removeItem('dsh-vision-router:onboarding:model-guide-v2')
      bundle.startVisionSettingsGuide()
      const before = bundle.readVisionGuideStep()
      bundle.finishVisionSettingsGuide({ complete: true })

      const deadline = Date.now() + 1500
      while (user.onboardingSeen !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      return {
        before,
        after: bundle.readVisionGuideStep(),
        state: bundle.guideState(),
        onboardingSeen: user.onboardingSeen,
        localStorageSeen: window.localStorage.getItem('dsh-vision-router:onboarding:model-guide-v2'),
        writes,
      }
    })

    assert.equal(result.before, 'step1')
    assert.equal(result.after, undefined)
    assert.equal(result.onboardingSeen, true)
    assert.equal(result.localStorageSeen, 'seen')
    assert.ok(result.writes.some((entry) => entry[0] === 'set' && entry[1] === 'onboardingSeen' && entry[2] === true))
  })
})

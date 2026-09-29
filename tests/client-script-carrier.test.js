import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import {
  appendStructuredClientCarrier,
  appendStructuredClientStyle,
  injectClientCarrierHtml,
  injectClientStyleHtml,
  installClientScriptCarriers,
} from '../lib/client-script-carrier.js'

const MARK = 'data-vision-router-test-carrier'
const PRELUDE = "window.__carrierRuns = (window.__carrierRuns || 0) + 1;"

test('shared carrier publishes one structured Desktop row and one Web transform', () => {
  const listeners = new Map()
  let transform
  const ctx = {
    inject(_deps, callback) {
      callback({
        on(name, listener) { listeners.set(name, listener) },
        effect(factory) { factory() },
        webServer: { tapIndex(fn) { transform = fn; return () => {} } },
      })
    },
  }
  installClientScriptCarriers(ctx, { marker: MARK, prelude: PRELUDE, label: 'test carrier' })
  const rows = []
  listeners.get('webserver/index-inject')(rows)
  listeners.get('webserver/index-inject')(rows)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'script')
  assert.equal(rows[0].placement, 'head')
  assert.match(rows[0].text, new RegExp(MARK))

  const html = transform('<html><head></head><body></body></html>')
  assert.match(html, new RegExp(`<script ${MARK}>`))
})

test('structured and HTML carriers are one-shot even if both are rendered', () => {
  const rows = []
  appendStructuredClientCarrier(rows, MARK, PRELUDE)
  const webScript = injectClientCarrierHtml('<head></head>', MARK, PRELUDE)
    .match(new RegExp(`<script ${MARK}>([\\s\\S]*?)<\\/script>`))[1]
  const sandbox = { window: {} }
  vm.createContext(sandbox)
  vm.runInContext(rows[0].text.replace(/^\/\*.*?\*\/\n/, ''), sandbox)
  vm.runInContext(webScript, sandbox)
  assert.equal(sandbox.window.__carrierRuns, 1)
})

test('direct tapIndex client installers are restricted to reviewed carrier owners', () => {
  const libRoot = join(process.cwd(), 'lib')
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path)
    }
  }
  visit(libRoot)

  // remote-settings-risk-confirmation is deliberately Web-only: a genuine
  // trusted-host Web page asks for risk confirmation, while dsh-app://app is
  // local and must never enter the remote authorization flow.
  const reviewed = new Map([
    ['client-script-carrier.js', 'shared dual-carrier owner'],
    ['remote-settings-risk-confirmation.js', 'deliberate remote-Web-only confirmation'],
    ['settings-client-017-compat.js', 'owns its structured Desktop row explicitly'],
    ['settings-factory-lifecycle.js', 'owns custom structured script/style convergence'],
    ['v2-settings-ia-integration.js', 'owns custom structured script/style convergence'],
    ['vision-toggle-root-hardening.js', 'rewrites structured scripts plus HTML fallback'],
  ])

  const direct = files.filter((path) => readFileSync(path, 'utf8').includes('tapIndex('))
  const names = direct.map((path) => path.slice(libRoot.length + 1)).sort()
  assert.deepEqual(names, [...reviewed.keys()].sort())

  for (const path of direct) {
    const name = path.slice(libRoot.length + 1)
    const source = readFileSync(path, 'utf8')
    if (name === 'remote-settings-risk-confirmation.js' || name === 'client-script-carrier.js') continue
    assert.match(source, /webserver\/index-inject/, `${name} must retain a Desktop structured carrier`)
  }
})


test('carrier survives Desktop-only, Web-only, dual and repeated installation permutations', () => {
  const scenarios = [
    { name: 'desktop-only', structured: true, web: false },
    { name: 'web-only', structured: false, web: true },
    { name: 'dual', structured: true, web: true },
    { name: 'neither', structured: false, web: false },
  ]
  for (const scenario of scenarios) {
    const listeners = []
    const transforms = []
    const ctx = {
      inject(_deps, callback) {
        const webCtx = { webServer: {} }
        if (scenario.structured) webCtx.on = (name, listener) => listeners.push([name, listener])
        if (scenario.web) {
          webCtx.effect = (factory) => { factory() }
          webCtx.webServer.tapIndex = (transform) => { transforms.push(transform); return () => {} }
        }
        callback(webCtx)
      },
    }
    installClientScriptCarriers(ctx, { marker: MARK, prelude: PRELUDE, label: scenario.name })
    installClientScriptCarriers(ctx, { marker: MARK, prelude: PRELUDE, label: `${scenario.name}-again` })

    const rows = []
    for (const [name, listener] of listeners) {
      assert.equal(name, 'webserver/index-inject')
      listener(rows)
    }
    assert.equal(rows.length, scenario.structured ? 1 : 0, scenario.name)

    let html = '<html><head></head><body></body></html>'
    for (const transform of transforms) html = transform(html)
    assert.equal((html.match(new RegExp(`<script ${MARK}>`, 'g')) || []).length, scenario.web ? 1 : 0, scenario.name)
  }
})

test('one-shot fence releases after a throwing prelude so a later carrier can recover', () => {
  const prelude = "window.__attempts=(window.__attempts||0)+1;if(window.__attempts===1)throw new Error('first');window.__recovered=true;"
  const rows = []
  appendStructuredClientCarrier(rows, MARK, prelude)
  const webScript = injectClientCarrierHtml('<head></head>', MARK, prelude)
    .match(new RegExp(`<script ${MARK}>([\\s\\S]*?)<\\/script>`))[1]
  const sandbox = { window: {} }
  vm.createContext(sandbox)
  assert.throws(() => vm.runInContext(rows[0].text.replace(/^\/\*.*?\*\/\n/, ''), sandbox), /first/)
  vm.runInContext(webScript, sandbox)
  assert.equal(sandbox.window.__attempts, 2)
  assert.equal(sandbox.window.__recovered, true)
})

test('different carrier markers remain independent under mixed delivery order', () => {
  const rows = []
  appendStructuredClientCarrier(rows, 'data-vision-router-a', "window.__a=(window.__a||0)+1;")
  appendStructuredClientCarrier(rows, 'data-vision-router-b', "window.__b=(window.__b||0)+1;")
  const aWeb = injectClientCarrierHtml('<head></head>', 'data-vision-router-a', "window.__a=(window.__a||0)+1;")
    .match(/<script data-vision-router-a>([\s\S]*?)<\/script>/)[1]
  const bWeb = injectClientCarrierHtml('<head></head>', 'data-vision-router-b', "window.__b=(window.__b||0)+1;")
    .match(/<script data-vision-router-b>([\s\S]*?)<\/script>/)[1]
  const sandbox = { window: {} }
  vm.createContext(sandbox)
  vm.runInContext(bWeb, sandbox)
  vm.runInContext(rows[0].text.replace(/^\/\*.*?\*\/\n/, ''), sandbox)
  vm.runInContext(rows[1].text.replace(/^\/\*.*?\*\/\n/, ''), sandbox)
  vm.runInContext(aWeb, sandbox)
  assert.equal(sandbox.window.__a, 1)
  assert.equal(sandbox.window.__b, 1)
})

test('style and script carriers dedupe independently on HTML and structured surfaces', () => {
  let html = '<html><head></head></html>'
  html = injectClientStyleHtml(html, MARK, '.x{display:block}')
  html = injectClientStyleHtml(html, MARK, '.x{display:none}')
  html = injectClientCarrierHtml(html, MARK, PRELUDE)
  html = injectClientCarrierHtml(html, MARK, 'window.__wrong=true;')
  assert.equal((html.match(new RegExp(`<style ${MARK}>`, 'g')) || []).length, 1)
  assert.equal((html.match(new RegExp(`<script ${MARK}>`, 'g')) || []).length, 1)
  assert.match(html, /display:block/)
  assert.doesNotMatch(html, /display:none/)
  assert.doesNotMatch(html, /__wrong/)

  const rows = [{ kind: 'meta', text: null }, { kind: 'script', text: 'unrelated' }]
  assert.equal(appendStructuredClientStyle(rows, MARK, '.x{}'), true)
  assert.equal(appendStructuredClientStyle(rows, MARK, '.y{}'), false)
  assert.equal(appendStructuredClientCarrier(rows, MARK, PRELUDE), true)
  assert.equal(appendStructuredClientCarrier(rows, MARK, 'window.__wrong=true;'), false)
  assert.equal(rows.filter((row) => row.kind === 'style').length, 1)
  assert.equal(rows.filter((row) => row.kind === 'script' && row.text.includes(`/* ${MARK} */`)).length, 1)
})

test('carrier installer fails open when optional Host carrier surfaces are absent', () => {
  assert.doesNotThrow(() => installClientScriptCarriers(null, { marker: MARK, prelude: PRELUDE, label: 'none' }))
  assert.doesNotThrow(() => installClientScriptCarriers({}, { marker: MARK, prelude: PRELUDE, label: 'empty' }))
  assert.doesNotThrow(() => installClientScriptCarriers({ inject(_deps, callback) { callback({ webServer: {} }) } }, {
    marker: MARK, prelude: PRELUDE, label: 'host-without-carriers',
  }))
})

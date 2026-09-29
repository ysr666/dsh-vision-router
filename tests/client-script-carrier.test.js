import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import {
  appendStructuredClientCarrier,
  injectClientCarrierHtml,
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

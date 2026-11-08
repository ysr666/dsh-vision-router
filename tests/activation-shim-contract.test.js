// Activation-shim contract (issue #547 class).
//
// Two historical incidents are guarded here, both caused by the bundle patch:
//
//  * the `modules` / `connection` overlays must keep an explicit `webServer`
//    activation dependency — without it a parallel Loader activation can hit the
//    Cordis service-access race ("webServer without inject") and the Host fails to
//    activate its required plugins;
//  * the `vision-router` insert must be followed by an id-addressed row that
//    re-asserts `disabled: false`, because the legacy live-patch implementation
//    writes `disabled=true` back into the shared insert object and a recompose then
//    reuses it (upstream #2854), which made Desktop supervisors re-mount DVR in a
//    loop.
//
// The real-host boot gates would eventually notice a regression, but only after a
// full desktop install. This contract fails in `pnpm test`, and it ships its own
// negative controls so the checks cannot silently stop checking.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PATCH_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../cordis.patch.yml',
)

const HOST_ROWS = [
  { id: 'modules', name: '@deepseek-ai/dsh-client-modules', inject: ['webServer'] },
  { id: 'connection', name: '@deepseek-ai/dsh-client-connection', inject: ['webStartup', 'webServer'] },
]
const PLUGIN_ROW = { id: 'vision-router', name: 'dsh-vision-router' }

function stripComment(line) {
  // Bundle-patch comments are whole-line only in this file, but stay defensive.
  const index = line.indexOf(' #')
  return index === -1 ? line : line.slice(0, index)
}

/** Minimal, dependency-free reader for this file's bundle-patch shape. */
export function parseBundlePatch(text) {
  const rows = []
  let current = null
  let insideInsert = false
  const lines = String(text ?? '').split('\n')
  lines.forEach((raw, index) => {
    const line = stripComment(raw)
    if (/^\s*#/.test(raw) || line.trim() === '') return
    const topLevel = line.match(/^- (.*)$/)
    if (topLevel) {
      const rest = topLevel[1]
      current = { at: index, id: null, name: null, inject: null, disabled: null, inserts: [], keys: [] }
      rows.push(current)
      const inlineId = rest.match(/^id:\s*(\S+)/)
      if (inlineId) current.id = inlineId[1]
      insideInsert = /^insert:\s*$/.test(rest)
      return
    }
    if (current === null) return
    const rowKey = !insideInsert && line.match(/^  ([A-Za-z][A-Za-z0-9_-]*):(?:\s|$)/)?.[1]
    if (rowKey) current.keys.push(rowKey)
    const insertItem = line.match(/^\s+- id:\s*(\S+)/)
    if (insideInsert && insertItem) {
      const item = { at: index, id: insertItem[1], name: null, disabled: null }
      current.inserts.push(item)
      current.insertItem = item
      return
    }
    const field = line.match(/^\s+(id|name|inject|disabled):\s*(.*)$/)
    if (!field) return
    const [, key, rawValue] = field
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '')
    const target = insideInsert && current.insertItem ? current.insertItem : current
    if (key === 'inject') {
      target.inject = value.startsWith('[')
        ? value.replace(/^\[|\]$/g, '').split(',').map((entry) => entry.trim()).filter(Boolean)
        : [value].filter(Boolean)
      return
    }
    if (key === 'disabled') target.disabled = value === 'true'
    else target[key] = value
  })
  return rows.map((row) => ({
    at: row.at,
    id: row.id,
    name: row.name,
    inject: row.inject ?? [],
    disabled: row.disabled,
    inserts: row.inserts,
    keys: row.keys,
  }))
}

/** Classify a parsed bundle patch against the activation-shim contract. */
export function inspectActivationShim(rows) {
  const findings = []
  const list = Array.isArray(rows) ? rows : []
  const topLevel = list.filter((row) => row.inserts.length === 0 || row.id !== null)

  for (const expected of HOST_ROWS) {
    const matches = topLevel.filter((row) => row.id === expected.id && row.inserts.length === 0)
    if (matches.length !== 1) {
      findings.push(`${expected.id}: expected exactly one merge overlay, found ${matches.length}`)
      continue
    }
    const row = matches[0]
    if (row.name !== expected.name) {
      findings.push(`${expected.id}: identity assertion changed to ${String(row.name)}`)
    }
    for (const dependency of expected.inject) {
      if (!row.inject.includes(dependency)) {
        findings.push(`${expected.id}: activation dependency ${dependency} is missing from inject`)
      }
    }
    if (expected.id === 'connection') {
      if (JSON.stringify(row.inject) !== JSON.stringify(expected.inject)) {
        findings.push('connection: injection must be exactly [webStartup, webServer]')
      }
      if (JSON.stringify([...row.keys].sort()) !== JSON.stringify(['inject', 'name'])) {
        findings.push('connection: only name/inject may be overridden, never Host config or trust')
      }
    }
    if (row.disabled === true) findings.push(`${expected.id}: the overlay disables a Host row`)
  }

  // The only Connection overlay is the expected activation dependency above.
  // No private ready service and no Host-owned trustedHosts/config overrides.
  if (list.some((row) => row.inserts.some((item) => item.id === 'vision-router-web-connection-ready'))) {
    findings.push('retired ready bridge: DVR must not insert the private Connection provider')
  }
  if (list.some((row) => row.inject.includes('visionRouterWebConnectionReady'))) {
    findings.push('retired ready bridge: DVR must not inject the private Connection service')
  }

  const insertRow = list.find((row) => row.inserts.some((item) => item.id === PLUGIN_ROW.id))
  if (!insertRow) {
    findings.push(`${PLUGIN_ROW.id}: no insert row declares the plugin`)
  } else {
    const inserted = insertRow.inserts.find((item) => item.id === PLUGIN_ROW.id)
    if (inserted.name !== PLUGIN_ROW.name) {
      findings.push(`${PLUGIN_ROW.id}: inserted row name is ${String(inserted.name)}`)
    }
    const restore = list.find(
      (row) => row.inserts.length === 0 && row.id === PLUGIN_ROW.id && row.at > insertRow.at,
    )
    if (!restore) {
      findings.push(
        `${PLUGIN_ROW.id}: no id-addressed row after the insert re-asserts disabled: false`,
      )
    } else if (restore.disabled !== false) {
      findings.push(`${PLUGIN_ROW.id}: the post-insert row does not set disabled: false`)
    }
  }

  for (const row of list) {
    if (row.disabled === true) findings.push(`${String(row.id)}: patch disables a row`)
    for (const item of row.inserts) {
      if (item.disabled === true) findings.push(`${item.id}: inserted row is disabled`)
    }
  }
  return findings
}

test('the shipped bundle adds only safe Connection ordering and preserves recompose re-enable', () => {
  const findings = inspectActivationShim(parseBundlePatch(readFileSync(PATCH_PATH, 'utf8')))
  assert.deepEqual(findings, [])
})

test('the contract fails when a webServer activation dependency disappears', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8')
    .replace('  inject: [webServer]\n', '')
  const findings = inspectActivationShim(parseBundlePatch(patch))
  assert.ok(
    findings.some((finding) => finding.startsWith('modules:') && /webServer/.test(finding)),
    `expected a modules/webServer finding, got ${JSON.stringify(findings)}`,
  )
})

test('the contract fails when the plugin insert loses its recompose re-enable', () => {
  const source = readFileSync(PATCH_PATH, 'utf8')
  const rows = parseBundlePatch(source).filter(
    (row, index, all) => !(row.inserts.length === 0 && row.id === 'vision-router' && index === all.length - 2),
  )
  const findings = inspectActivationShim(
    parseBundlePatch(source.replace(/\n- id: vision-router\n  name: dsh-vision-router\n  disabled: false\n/, '\n')),
  )
  assert.ok(
    findings.some((finding) => /no id-addressed row after the insert/.test(finding)),
    `expected a recompose finding, got ${JSON.stringify(findings)}`,
  )
  assert.ok(rows.length > 0)
})

test('the contract fails when the patch disables a Host row', () => {
  const findings = inspectActivationShim(
    parseBundlePatch('- id: modules\n  name: "@deepseek-ai/dsh-client-modules"\n  inject: [webServer]\n  disabled: true\n'),
  )
  assert.ok(findings.some((finding) => /modules/.test(finding)))
})

test('the contract fails when the modules identity assertion drifts', () => {
  const findings = inspectActivationShim(parseBundlePatch(
    '- id: modules\n  name: "@deepseek-ai/dsh-client-modules-next"\n  inject: [webServer]\n',
  ))
  assert.ok(findings.some((finding) => /identity assertion changed/.test(finding)))
})

test('the contract rejects a second Connection overlay and the retired private ready service', () => {
  const original = readFileSync(PATCH_PATH, 'utf8')
  const legacy = original + '\n- id: connection\n  name: "@deepseek-ai/dsh-client-connection"\n  inject: [webStartup, visionRouterWebConnectionReady]\n'
  const findings = inspectActivationShim(parseBundlePatch(legacy))
  assert.ok(findings.some((finding) => finding.startsWith('connection:')))
  assert.ok(findings.some((finding) => finding.startsWith('retired ready bridge:')))
})

test('a ready-bridge insert is rejected without blocking real Vision Router insertion', () => {
  const original = readFileSync(PATCH_PATH, 'utf8')
  const legacy = original.replace(
    '    - id: vision-router\n',
    '    - id: vision-router-web-connection-ready\n      name: ./presets/web-connection-ready/index.mjs\n    - id: vision-router\n',
  )
  assert.ok(inspectActivationShim(parseBundlePatch(legacy))
    .some((finding) => finding.startsWith('retired ready bridge:')))
})
test('the retired private readiness bridge is not distributed or required', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = readFileSync(PATCH_PATH, 'utf8')
  assert.equal(pkg.files.includes('presets'), false)
  assert.doesNotMatch(patch, /visionRouterWebConnectionReady|vision-router-web-connection-ready/)
  assert.match(patch, /- id: connection\s+name: '@deepseek-ai\/dsh-client-connection'\s+inject: \[webStartup, webServer\]/)
})

test('the activation contract rejects Connection trust/config override and missing webServer', () => {
  const source = readFileSync(PATCH_PATH, 'utf8')
  for (const wrong of [
    source.replace('  inject: [webStartup, webServer]\n', '  inject: [webStartup]\n'),
    source.replace('  inject: [webStartup, webServer]\n',
      '  inject: [webStartup, webServer]\n  config:\n    trustedHosts: !!js ctx.webStartup.trustedHosts\n'),
    source.replace("name: '@deepseek-ai/dsh-client-connection'",
      "name: '@unexpected/connection'"),
  ]) {
    const findings = inspectActivationShim(parseBundlePatch(wrong))
    assert.ok(findings.some((item) => item.startsWith('connection:')), JSON.stringify(findings))
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const client = readFileSync(new URL('../src/lib/client.js', import.meta.url), 'utf8')
const svg = readFileSync(new URL('../assets/icon.svg', import.meta.url), 'utf8').trim()

test('DSH Plugin Manager loads a local packaged SVG icon', () => {
  assert.equal(manifest.icon, './assets/icon.svg')
  assert.equal(manifest.exports['./icon'], manifest.icon)
  assert.ok(manifest.files.includes('assets'))
  const path = resolve(root, manifest.icon)
  assert.ok(path.startsWith(root + sep))
  assert.ok(statSync(path).size < 256 * 1024)
  assert.match(svg, /^<svg\b/)
  assert.match(svg, /viewBox="0 0 64 64"/)
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b|\bhref=|<image\b/i)
})

test('native Settings section uses the identical artwork and registers a scoped icon', () => {
  const declaration = client.match(/^    const VISION_ROUTER_ICON_SVG = (".+")$/m)
  assert.ok(declaration)
  assert.equal(JSON.parse(declaration[1]), svg)
  assert.match(client, /data:image\/svg\+xml,.*encodeURIComponent\(VISION_ROUTER_ICON_SVG\)/)
  assert.match(client, /ctx\.slots\.inject\('settings\.section\.icon', function\* \(\) \{/)
  assert.match(client, /name: 'settings\.section\.icon', id: 'vision-router'/)
  assert.match(client, /'vision-router: settings navigation icon'/)
  assert.match(client, /React\.createElement\('img', \{/)
  assert.match(client, /width: size,\s*height: size,/)
})

test('real Alpha Settings lifecycle asserts that the icon renders and decodes', () => {
  const gate = readFileSync(new URL('../.github/workflows/dsh-alpha-settings-host-gate.yml', import.meta.url), 'utf8')
  const smoke = readFileSync(new URL('../scripts/dsh-preview-settings-browser-lifecycle-smoke.mjs', import.meta.url), 'utf8')
  assert.match(gate, /DVR_EXPECT_NATIVE_SETTINGS_ICON: '1'/)
  assert.match(smoke, /process\.env\.DVR_EXPECT_NATIVE_SETTINGS_ICON === '1'/)
  assert.match(smoke, /\[data-slot="settings\.section\.icon"\] img/)
  assert.match(smoke, /image\.complete && image\.naturalWidth > 0/)
})

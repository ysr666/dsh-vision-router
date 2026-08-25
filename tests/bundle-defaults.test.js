import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config, SETTINGS_CONTRACT_REVISION } from '../entry.js'
import {
  GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE,
  injectGuideVisionToggleHighlight,
  unionGuideRects,
} from '../lib/guide-vision-toggle-highlight.js'

const bundlePatch = new URL('../cordis.patch.yml', import.meta.url)

test('installed bundle keeps the full vision tool schema stable by default', async () => {
  const text = await readFile(bundlePatch, 'utf8')
  assert.match(
    text,
    /- id: vision-router[\s\S]*?name: dsh-vision-router[\s\S]*?config:\s*\n\s+progressiveTools: false/,
  )
})

test('bundle declares the rc8 large-image admission policy for clean profiles', async () => {
  const text = await readFile(bundlePatch, 'utf8')
  assert.match(
    text,
    /- id: attachment-local[\s\S]*?maxImageBytes: 20971520[\s\S]*?maxImagePixels: 100000000[\s\S]*?maxImageDimension: 10000/,
  )
})

test('public plugin config defaults progressive tools off', () => {
  assert.equal(Config({}).progressiveTools, false)
})

test('progressive tools remain an explicit opt-in', () => {
  assert.equal(Config({ progressiveTools: true }).progressiveTools, true)
})

test('entry contract exposes routing product semantics without enabling auto execution or measurement by default', () => {
  assert.equal(SETTINGS_CONTRACT_REVISION, 7)
  const defaults = Config({})
  assert.equal(defaults.routingMode, 'ordered')
  assert.equal(defaults.routingPreference, 'balanced')
  assert.equal(defaults.backgroundBenchmarking, 'off')
  assert.equal(Config({ routingMode: 'auto', routingPreference: 'local' }).routingMode, 'auto')
  assert.equal(Config({ routingMode: 'auto', routingPreference: 'local' }).routingPreference, 'local')
  assert.equal(Config({ backgroundBenchmarking: 'local-free' }).backgroundBenchmarking, 'local-free')
  assert.equal(Config({ backgroundBenchmarking: 'all' }).backgroundBenchmarking, 'all')
  assert.equal(Config({ backgroundBenchmarking: 'off' }).backgroundBenchmarking, 'off')
  const schema = Config.toJSON()
  const fields = schema.refs[String(schema.uid)].dict
  assert.equal(Object.hasOwn(fields, 'capabilityRoutingShadow'), false)
  assert.equal(Object.hasOwn(fields, 'capabilityRoutingStrategy'), false)
})

test('public plugin config leaves the whole-turn vision budget unlimited by default', () => {
  assert.equal(Config({}).visionTurnBudgetMs, 0)
  assert.equal(Config({ visionTurnBudgetMs: 180000 }).visionTurnBudgetMs, 180000)
})

test('walkthrough step 1 combines the Vision toggle and model selector into one spotlight', () => {
  assert.deepEqual(
    unionGuideRects(
      { x: 100, y: 440, left: 100, top: 440, right: 220, bottom: 500, width: 120, height: 60 },
      { x: 236, y: 430, left: 236, top: 430, right: 760, bottom: 510, width: 524, height: 80 },
    ),
    { x: 100, y: 430, left: 100, top: 430, right: 760, bottom: 510, width: 660, height: 80 },
  )
  assert.match(GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE, /data-vr-step="step1"/)
  assert.match(GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE, /data-vision-router-mode-toggle/)
  assert.match(GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE, /vr-guide-spot-hole/)
  assert.match(GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE, /vr-guide-spot-ring/)

  const html = '<html><head></head><body></body></html>'
  const once = injectGuideVisionToggleHighlight(html)
  assert.equal(injectGuideVisionToggleHighlight(once), once)
  assert.equal((once.match(/data-vision-router-guide-toggle-highlight/g) ?? []).length, 1)
})

test('entry contract always exposes the local remote-settings permission and handshake', () => {
  assert.equal(SETTINGS_CONTRACT_REVISION, 7)
  assert.equal(Config({}).allowRemoteSettings, false)
  assert.equal(Config({ allowRemoteSettings: true }).allowRemoteSettings, true)
  assert.equal(Config({}).settingsContractRevision, 7)
})

test('entry contract exposes the custom depth tier to every settings entry point', () => {
  const defaults = Config({})
  assert.equal(defaults.visionDepth, 'standard')
  assert.equal(defaults.visionDepthMaxCalls, 0)

  const custom = Config({ visionDepth: 'custom', visionDepthMaxCalls: 7 })
  assert.equal(custom.visionDepth, 'custom')
  assert.equal(custom.visionDepthMaxCalls, 7)
})

test('release line stays on the stable v2 package identity', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-vision-router')
  assert.match(pkg.version, /^2\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
})

test('v2.0.0 ships curated release notes and the tag workflow consumes them first', async () => {
  const notes = await readFile(new URL('../docs/releases/v2.0.0.md', import.meta.url), 'utf8')
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

  assert.match(notes, /^# v2\.0\.0$/m)
  assert.match(notes, /能力感知 Auto 路由 \/ Capability-aware Auto routing/)
  assert.match(notes, /真实验收与发布门禁 \/ Real-machine acceptance & release gates/)
  assert.match(workflow, /CURATED_NOTES="docs\/releases\/\$RELEASE_TAG\.md"/)
  assert.match(workflow, /cat "\$CURATED_NOTES" > release-notes\.md/)
})

test('manual Release workflow creates only the exact current-main package tag before publishing', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /target_sha:/)
  assert.match(workflow, /RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/)
  assert.match(workflow, /RELEASE_SHA: \$\{\{ inputs\.target_sha \|\| github\.sha \}\}/)
  assert.match(workflow, /manual release target must be the exact current origin\/main HEAD/)
  assert.match(workflow, /Run tests[\s\S]*Ensure immutable release tag exists at verified SHA/)
  assert.match(workflow, /gh api[\s\S]*repos\/\$GITHUB_REPOSITORY\/git\/refs[\s\S]*refs\/tags\/\$RELEASE_TAG/)
  assert.match(workflow, /already exists at \$REMOTE_TAG_SHA, expected \$RELEASE_SHA/)
  assert.match(workflow, /REMOTE_TAG_SHA[\s\S]*\$RELEASE_SHA/)
  assert.match(workflow, /npm publish "\$PACKAGE_TARBALL" --provenance --access public/)
})

test('release runtime exposes one benchmark UI and no production v2 acceptance control surface', async () => {
  const entry = await readFile(new URL('../entry.js', import.meta.url), 'utf8')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  assert.doesNotMatch(entry, /installExactVisionTestClient/)
  assert.doesNotMatch(entry, /installV2AcceptanceService/)
  assert.doesNotMatch(entry, /createV2ExecutionAcceptanceObserver/)
  assert.doesNotMatch(entry, /installVisionRoutingPreviewService/)
  assert.match(entry, /installCapabilityBenchmarkClient/)
  assert.equal(pkg.bin['dsh-vision-router'], './lib/doctor-cli.js')
  assert.equal(Object.prototype.hasOwnProperty.call(pkg.bin, 'dsh-vision-router-acceptance'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(pkg.scripts, 'test:acceptance:v2'), false)
  for (const path of [
    '../lib/v2-acceptance-cli.js',
    '../lib/v2-acceptance-service.js',
    '../lib/v2-execution-acceptance-observer.js',
    '../lib/vision-backend-smoke-test-client.js',
    '../lib/vision-backend-smoke-test.js',
    '../lib/vision-routing-preview-service.js',
  ]) {
    await assert.rejects(readFile(new URL(path, import.meta.url)), (error) => error?.code === 'ENOENT')
  }
})

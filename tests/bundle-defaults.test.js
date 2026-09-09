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

test('bundle declares one large-image policy for admission and alpha canonical storage', async () => {
  const text = await readFile(bundlePatch, 'utf8')
  assert.match(
    text,
    /- id: attachment-local[\s\S]*?maxImageBytes: 20971520[\s\S]*?maxImagePixels: 100000000[\s\S]*?maxImageDimension: 10000[\s\S]*?normalizedImageMaxBytes: 20971520[\s\S]*?normalizedImageMaxPixels: 100000000[\s\S]*?normalizedImageMaxDimension: 10000/,
  )
})

test('public docs promise Host-canonical raster rather than uploader source-byte identity', async () => {
  const [en, zh] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh.md', import.meta.url), 'utf8'),
  ])

  assert.match(en, /Host-canonical image pixels on the vision model's side/)
  assert.match(en, /Host-persisted canonical image/)
  assert.match(en, /not preservation of the uploader's original encoded bytes/)
  assert.doesNotMatch(en, /original pixels on the vision model's side/)
  assert.doesNotMatch(en, /routing bridge — pixel-faithful/)
  assert.doesNotMatch(en, /adds raw-image routing/)

  assert.match(zh, /Host 规范化后的图像像素留在视觉模型侧/)
  assert.match(zh, /Host 持久化后的 canonical image/)
  assert.match(zh, /不是上传源文件编码字节逐字节不变/)
  assert.doesNotMatch(zh, /原图像素留在视觉模型侧/)
  assert.doesNotMatch(zh, /路由桥，像素保真/)
  assert.doesNotMatch(zh, /提供"原图直看"路由/)
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

test('release workflow confines write tokens to non-executing tag/release phases', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const verifyStart = workflow.indexOf('  verify:')
  const tagStart = workflow.indexOf('  tag:', verifyStart + 1)
  const publishStart = workflow.indexOf('  publish:', tagStart + 1)
  const releaseStart = workflow.indexOf('  github-release:', publishStart + 1)
  assert.ok(verifyStart > 0 && tagStart > verifyStart && publishStart > tagStart && releaseStart > publishStart)

  const verify = workflow.slice(verifyStart, tagStart)
  const tag = workflow.slice(tagStart, publishStart)
  const publish = workflow.slice(publishStart, releaseStart)
  const release = workflow.slice(releaseStart)

  assert.match(workflow, /^permissions: \{\}$/m)
  assert.match(verify, /permissions:[\s\S]*contents: read/)
  assert.doesNotMatch(verify, /contents: write/)
  assert.match(tag, /needs: verify[\s\S]*permissions:[\s\S]*contents: write/)
  assert.doesNotMatch(tag, /pnpm install|pnpm test|npm pack|npm publish/)
  assert.match(publish, /needs: tag[\s\S]*contents: read[\s\S]*id-token: write/)
  assert.doesNotMatch(publish, /contents: write/)
  assert.match(release, /needs: publish[\s\S]*permissions:[\s\S]*contents: write/)
  assert.doesNotMatch(workflow, /npm install --global/)
  assert.match(workflow, /NPM_CLI_SHA256: '[0-9a-f]{64}'/)
  assert.match(workflow, /sha256sum --check --strict/)
})

test('PR workflows cancel superseded heads and Windows screenshot avoids pnpm setup', async () => {
  const { readdir } = await import('node:fs/promises')
  const workflowDir = new URL('../.github/workflows/', import.meta.url)
  const names = await readdir(workflowDir)

  for (const name of names.filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))) {
    const source = await readFile(new URL(name, workflowDir), 'utf8')
    if (!source.includes('\n  pull_request:')) continue
    assert.match(source, /^concurrency:/m, `${name}: PR workflow must define concurrency`)
    assert.match(source, /github\.event\.pull_request\.number\s*\|\|\s*github\.ref/, `${name}: concurrency must be PR-scoped`)
    assert.match(source, /cancel-in-progress:\s*(?:true|\$\{\{\s*github\.event_name\s*==\s*['\"]pull_request['\"]\s*\}\})/, `${name}: superseded PR heads must actually cancel`)
  }

  const hardening = await readFile(new URL('../.github/workflows/adversarial-compat-hardening.yml', import.meta.url), 'utf8')
  const start = hardening.indexOf('  windows-node24-screenshot:')
  const end = hardening.indexOf('\n  preview-host-contract:', start)
  assert.ok(start >= 0 && end > start, 'Windows screenshot job anchors must remain explicit and ordered')
  const windows = hardening.slice(start, end)
  assert.match(windows, /timeout-minutes: 5/)
  assert.match(windows, /actions\/setup-node@/)
  assert.doesNotMatch(windows, /pnpm\/action-setup|pnpm install|cache: pnpm/)
})

test('CI impact classifier is bounded and fail-closed for trusted shadow input', async () => {
  const { classifyCiImpact, classifyCiImpactJsonLines, MAX_CI_IMPACT_INPUT_BYTES, MAX_CI_IMPACT_PATHS } = await import('../scripts/ci-impact-classifier.mjs')

  assert.equal(classifyCiImpact(['docs/doctor.md', 'README.md']).docsOnly, true)
  assert.equal(classifyCiImpact(['lib/windows-desktop-capture.js']).windows, true)
  assert.equal(classifyCiImpact(['lib/windows-desktop-capture.js']).full, false)
  assert.equal(classifyCiImpact(['lib/client.js']).browser, true)
  const issue431 = classifyCiImpact([
    'lib/client-presentation-boundary-main.js',
    'lib/vision-model-visibility-boundary-main.js',
    'tests/issue-284-model-visibility.test.js',
    'tests/issue-284-vision-selection-effort.test.js',
  ])
  assert.equal(issue431.browser, true)
  assert.equal(issue431.host, false)
  assert.equal(issue431.full, false)
  assert.deepEqual(issue431.reasons, [])
  for (const path of [
    'lib/live-model-client-prelude.js',
    'lib/settings-ia-client-prelude.js',
    'lib/settings-limit-client-prelude.js',
    'lib/strict-live-model-client-prelude.js',
    'lib/vision-turn-budget-client-prelude.js',
    'lib/wrapper-scope-client-prelude.js',
    'scripts/dsh-preview-mixed-attachment-paste-smoke.mjs',
    'tests/clipboard-image-paste-compat.test.js',
    'tests/issue-367-remote-session-inject.test.js',
  ]) {
    const browserOnly = classifyCiImpact([path])
    assert.equal(browserOnly.browser, true, `${path}: browser boundary`)
    assert.equal(browserOnly.host, false, `${path}: not a Host boundary`)
    assert.equal(browserOnly.full, false, `${path}: known browser-scoped change`)
  }
  for (const path of [
    'lib/client-host-compat-prelude.js',
    'lib/guide-vision-toggle-highlight.js',
    'lib/remote-settings-risk-confirmation.js',
    'lib/settings-client-rc8-lifecycle.js',
    'lib/settings-factory-lifecycle.js',
    'lib/settings-native-card-layout.js',
    'lib/v2-settings-ia-integration.js',
    'lib/vision-capability-benchmark-client.js',
    'lib/vision-exact-check-client.js',
    'lib/vision-routing-settings-prelude.js',
  ]) {
    const browserOnly = classifyCiImpact([path])
    assert.equal(browserOnly.browser, true, `${path}: audited browser boundary`)
    assert.equal(browserOnly.host, false, `${path}: not a Host boundary`)
    assert.equal(browserOnly.full, false, `${path}: browser-scoped change`)
  }
  assert.equal(classifyCiImpact(['package.json']).full, true)
  assert.deepEqual(classifyCiImpact(['package.json']).reasons, ['CI/package routing metadata changed'])
  assert.equal(classifyCiImpact(['lib/new-unknown-boundary.js']).full, true)
  assert.equal(classifyCiImpact([]).full, true)
  assert.equal(classifyCiImpact(Array(MAX_CI_IMPACT_PATHS + 1).fill('lib/client.js')).full, true)
  assert.equal(classifyCiImpact(['x'.repeat(MAX_CI_IMPACT_INPUT_BYTES + 1)]).full, true)

  assert.equal(classifyCiImpactJsonLines('\"docs/doctor.md\"\n\"README.md\"\n').docsOnly, true)
  assert.equal(classifyCiImpactJsonLines('\"docs/ok.md\\nREADME.md\"\n').full, true)
  assert.equal(classifyCiImpactJsonLines('{not-json}\n').full, true)
  assert.equal(classifyCiImpactJsonLines('42\n').full, true)
})

test('CI impact shadow executes only the trusted base classifier', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci-impact-shadow.yml', import.meta.url), 'utf8')

  assert.match(workflow, /pull_request_target:/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: read/)
  assert.doesNotMatch(workflow, /contents: write|statuses: write|id-token: write|secrets\./)
  assert.equal(workflow.includes('BASE_SHA: ${{ github.event.pull_request.base.sha }}'), true)
  assert.doesNotMatch(workflow, /actions\/checkout@/)
  assert.doesNotMatch(workflow, /persist-credentials|path: trusted-base/)
  assert.doesNotMatch(workflow, /pull_request\.head/)
  assert.equal(workflow.includes('[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]'), true)
  assert.doesNotMatch(workflow, /application\/vnd\.github\.raw/)
  assert.equal(workflow.includes('contents/scripts/ci-impact-classifier.mjs?ref=$BASE_SHA'), true)
  assert.equal(workflow.includes("test \"$(jq -r '.encoding' \"$RUNNER_TEMP/dvr-ci-impact-classifier.json\")\" = 'base64'"), true)
  assert.match(workflow, /base64 --decode/)
  assert.match(workflow, /CLASSIFIER_BYTES > 0 && CLASSIFIER_BYTES <= 65536/)
  assert.match(workflow, /EXPECTED_BLOB=.*jq -r '\.sha'/)
  assert.match(workflow, /ACTUAL_BLOB=.*git hash-object/)
  assert.equal(workflow.includes('\"$ACTUAL_BLOB\" = \"$EXPECTED_BLOB\"'), true)
  assert.match(workflow, /\.filename \| @json/)
  assert.equal(workflow.includes('node "$RUNNER_TEMP/dvr-ci-impact-classifier.mjs" --json-lines'), true)
  assert.match(workflow, /timeout-minutes: 2/)
})

test('security policy links reporters to enabled private vulnerability reporting', async () => {
  const policy = await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8')
  assert.match(policy, /Private Vulnerability Reporting/)
  const reportingLine = policy.split('\n').find((line) => line.startsWith('Please use [GitHub **Private Vulnerability Reporting**]'))
  assert.equal(reportingLine, 'Please use [GitHub **Private Vulnerability Reporting**](https://github.com/ysr666/dsh-vision-router/security)')
  assert.match(policy, /Do \*\*not\*\* post exploit details/)
})

test('client prelude changes always trigger the real browser and alpha source gates', async () => {
  const workflows = [
    'dsh-preview-browser-smoke.yml',
    'alpha-browser-cold-toggle-smoke.yml',
    'dsh-alpha-source-contract.yml',
  ]
  for (const name of workflows) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    const trigger = "      - 'lib/*-client-prelude.js'"
    assert.equal(source.split(trigger).length - 1, 2, `${name}: client preludes must trigger PR and main`)
  }
})

test('audited browser integration modules always trigger every real browser and alpha source gate', async () => {
  const workflows = [
    'dsh-preview-browser-smoke.yml',
    'alpha-browser-cold-toggle-smoke.yml',
    'dsh-alpha-source-contract.yml',
  ]
  const boundaries = [
    'lib/client-host-compat-prelude.js',
    'lib/guide-vision-toggle-highlight.js',
    'lib/remote-settings-risk-confirmation.js',
    'lib/settings-client-rc8-lifecycle.js',
    'lib/settings-factory-lifecycle.js',
    'lib/settings-native-card-layout.js',
    'lib/v2-settings-ia-integration.js',
    'lib/vision-capability-benchmark-client.js',
    'lib/vision-exact-check-client.js',
    'lib/vision-routing-settings-prelude.js',
  ]
  for (const name of workflows) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    assert.equal(source.split("      - 'lib/web/**'").length - 1, 2, `${name}: lib/web must trigger PR and main`)
    for (const path of boundaries) {
      const trigger = `      - '${path}'`
      assert.equal(source.split(trigger).length - 1, 2, `${name}: ${path} must trigger PR and main`)
    }
  }
})

test('model visibility boundary changes always trigger the real browser and alpha source gates', async () => {
  const workflows = [
    'dsh-preview-browser-smoke.yml',
    'alpha-browser-cold-toggle-smoke.yml',
    'dsh-alpha-source-contract.yml',
  ]
  for (const name of workflows) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    for (const path of [
      'lib/vision-model-visibility-boundary-main.js',
      'lib/vision-model-visibility-boundary.js',
    ]) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      assert.equal((source.match(new RegExp(escaped, 'g')) ?? []).length, 2, `${name}: ${path} must trigger PR and main`)
    }
  }
})

test('release runtime exposes one benchmark UI and no production v2 acceptance control surface', async () => {
  const entry = await readFile(new URL('../entry.js', import.meta.url), 'utf8')
  const runtimeComposition = await readFile(new URL('../lib/runtime-composition.js', import.meta.url), 'utf8')
  const benchmarkPanel = await readFile(new URL('../lib/web/benchmark-panel.js', import.meta.url), 'utf8')
  const webComposition = await readFile(new URL('../lib/web/index.js', import.meta.url), 'utf8')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  const releaseSurface = `${entry}\n${runtimeComposition}\n${benchmarkPanel}\n${webComposition}`
  assert.doesNotMatch(releaseSurface, /installExactVisionTestClient/)
  assert.doesNotMatch(releaseSurface, /installV2AcceptanceService/)
  assert.doesNotMatch(releaseSurface, /createV2ExecutionAcceptanceObserver/)
  assert.doesNotMatch(releaseSurface, /installVisionRoutingPreviewService/)
  assert.match(entry, /applyVisionRuntimeComposition/)
  assert.match(runtimeComposition, /installVisionWebIntegration/)
  assert.match(benchmarkPanel, /installCapabilityBenchmarkClient/)
  assert.doesNotMatch(benchmarkPanel, /installSwitchedCapabilityBenchmarkClient/)
  assert.match(webComposition, /benchmarkPanel/)
  assert.equal(pkg.bin['dsh-vision-router'], './lib/doctor-cli-p0.js')
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

test('real DSH browser workflows use exact main-written build caches without skipping Host smoke', async () => {
  const cacheSha = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9'
  const cases = [
    ['dsh-preview-browser-smoke.yml', 'dsh-preview', 'Build preview web runtime', 'Run cold Vision toggle against preview Host and Chromium'],
    ['alpha-browser-cold-toggle-smoke.yml', 'dsh-alpha', 'Build exact alpha web runtime', 'Run cold Vision toggle against real Host and Chromium'],
  ]

  for (const [name, root, buildName, smokeName] of cases) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    assert.match(source, new RegExp(`actions/cache/restore@${cacheSha}`), `${name}: restore must use pinned cache v6.1.0`)
    assert.match(source, new RegExp(`actions/cache/save@${cacheSha}`), `${name}: save must use the same pinned cache action`)
    assert.doesNotMatch(source, /restore-keys:/, `${name}: build cache must use exact keys only`)
    assert.match(source, /KEY="dsh-web-v1-\$\{RUNNER_OS\}-node22-pnpm11\.7\.0-\$\{DSH_SHA\}-\$\{LOCK_SHA\}-\$\{TREE_SHA\}"/)
    assert.match(source, /DSH_SHA="\$\(git rev-parse HEAD\)"/)
    assert.match(source, /LOCK_SHA="\$\(sha256sum pnpm-lock\.yaml/)
    assert.match(source, /TREE_SHA="\$\(git ls-tree -r --full-tree HEAD/)
    assert.match(source, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && steps\.dsh-build-cache\.outputs\.cache-hit != 'true'/)
    assert.match(source, new RegExp(`- name: ${buildName}\\n\\s+if: steps\\.dsh-build-cache\\.outputs\\.cache-hit != 'true'`))
    assert.match(source, new RegExp(`${root}/lib[\\s\\S]*${root}/packages/\\*/\\*/lib[\\s\\S]*${root}/apps/web/dist[\\s\\S]*${root}/\\.dsh-build`))

    const install = source.indexOf('pnpm install --frozen-lockfile')
    const restore = source.indexOf('Restore trusted DSH web build cache')
    const build = source.indexOf(`- name: ${buildName}`)
    const save = source.indexOf('Save trusted DSH web build cache from main')
    const chromium = source.indexOf('Install Chromium for DSH Playwright')
    const smoke = source.indexOf(smokeName)
    assert.ok(install >= 0 && restore > install && build > restore && save > build && chromium > save && smoke > chromium,
      `${name}: cache may skip only DSH build; dependency install, Chromium, and real Host smoke stay live`)
  }
})

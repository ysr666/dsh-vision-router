import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config, SETTINGS_CONTRACT_REVISION } from '../entry.js'
import { Config as CoreConfig } from '../index.js'
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

test('bundle re-enables its inserted row after HMR/shared-object mutation', async () => {
  const text = await readFile(bundlePatch, 'utf8')
  assert.match(
    text,
    /- insert:[\s\S]*?- id: vision-router[\s\S]*?name: dsh-vision-router[\s\S]*?progressiveTools: false[\s\S]*?\n- id: vision-router\s+name: dsh-vision-router\s+disabled: false/,
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

test('public Config composition preserves the mature Core schema identity', () => {
  assert.equal(Config, CoreConfig)
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

test('release line stays on a single stable major package identity', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-vision-router')
  // One stable major per release line (2.x through v2.3.0, 3.x from v3.0.0 on):
  // a 0.x line or a prerelease-only identity is still refused.
  assert.match(pkg.version, /^(?:2|3)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
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
  assert.doesNotMatch(workflow, /\npush:\s*\n[\s\S]{0,120}tags:/, 'a pushed tag must never be a release entry point')
  assert.match(workflow, /target_sha:/)
  assert.match(workflow, /RELEASE_TAG: \$\{\{ inputs\.tag \}\}/)
  assert.match(workflow, /RELEASE_SHA: \$\{\{ inputs\.target_sha \}\}/)
  assert.match(workflow, /manual release target must be the exact current origin\/main HEAD/)
  // A released version is immutable and single-use: an existing tag is refused,
  // never "recovered". Re-dispatching a tag from a ref that is not the release
  // commit mints provenance for the wrong SourceRepositoryDigest, which is
  // exactly what the removed recovery branch used to allow.
  assert.match(workflow, /already exists at \$REMOTE_TAG_SHA\. A released version is immutable/)
  assert.doesNotMatch(workflow, /RELEASE_RECOVERY/)
  assert.doesNotMatch(workflow, /permitting recovery after main advanced/)
  assert.match(workflow, /SourceRepositoryDigest/)
  assert.match(workflow, /Run tests[\s\S]*Ensure immutable release tag exists at verified SHA/)
  assert.match(workflow, /Run tests[\s\S]*Verify generated browser source[\s\S]*pnpm client:check/)
  assert.match(workflow, /Verify release Host support policy[\s\S]*tests\/dsh-support-window\.test\.js/)
  assert.match(
    workflow,
    /Preflight exact packed contract before irreversible tag[\s\S]*npm pack --json[\s\S]*verify-packed-public-api\.mjs[\s\S]*release-registry-identity\.mjs inspect[\s\S]*Ensure immutable release tag exists at verified SHA/,
  )
  assert.match(workflow, /gh api[\s\S]*repos\/\$GITHUB_REPOSITORY\/git\/refs[\s\S]*refs\/tags\/\$RELEASE_TAG/)
  assert.match(workflow, /refusing to adopt or republish a pre-existing registry version/)
  assert.match(workflow, /REMOTE_TAG_SHA[\s\S]*\$RELEASE_SHA/)
  assert.match(workflow, /npm publish "\$PACKAGE_TARBALL" --provenance --access public/)
})

test('release workflow refuses stale README announcement bars and missing release notes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  // Documentation freshness is part of the release contract, not a warning:
  // both README bars must carry the released version and either curated notes
  // or a matching CHANGELOG section must exist.
  assert.ok(
    workflow.includes('^>[[:space:]]*\\[!WARNING\\]'),
    'release workflow must scope the freshness check to the top [!WARNING] announcement bar',
  )
  assert.match(
    workflow,
    /::error::\$f is missing a top \[!WARNING\] announcement bar mentioning \$\{EXPECTED_TAG\}; update the bar before releasing/,
  )
  assert.match(
    workflow,
    /::error::no curated release notes \(\$CURATED_NOTES\) and no CHANGELOG\.md section for \$EXPECTED_TAG/,
  )
  assert.doesNotMatch(workflow, /::warning::\$f does not yet mention/)
  assert.doesNotMatch(workflow, /::warning::no curated release notes/)
})

test('release workflow confines repository and publish write authority to the correct phases', async () => {
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
  assert.match(verify, /permissions:[\s\S]*contents: read[\s\S]*artifact-metadata: write/)
  assert.doesNotMatch(verify, /contents: write|id-token: write|attestations: write/)
  assert.match(tag, /needs: verify[\s\S]*permissions:[\s\S]*contents: write/)
  assert.doesNotMatch(tag, /pnpm install|pnpm test|npm pack|npm publish/)
  assert.match(publish, /needs: \[verify, tag\][\s\S]*contents: read[\s\S]*actions: read[\s\S]*id-token: write/)
  assert.match(publish, /attestations: write/)
  assert.match(publish, /artifact-metadata: write/)
  assert.doesNotMatch(publish, /contents: write|pnpm install|pnpm build|npm pack/)
  assert.match(release, /needs: publish[\s\S]*permissions:[\s\S]*contents: write[\s\S]*actions: read/)
  assert.doesNotMatch(release, /id-token: write|attestations: write|artifact-metadata: write/)
  assert.doesNotMatch(workflow, /npm install --global/)
  assert.match(workflow, /NPM_CLI_SHA256: '[0-9a-f]{64}'/)
  assert.match(workflow, /sha256sum --check --strict/)
})

test('release provenance binds the exact npm tarball before the write-token phase', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const publishStart = workflow.indexOf('  publish:')
  const releaseStart = workflow.indexOf('  github-release:', publishStart + 1)
  assert.ok(publishStart > 0 && releaseStart > publishStart)

  const publish = workflow.slice(publishStart, releaseStart)
  const release = workflow.slice(releaseStart)
  assert.match(workflow, /Preflight exact packed contract before irreversible tag[\s\S]*actions\/upload-artifact@[0-9a-f]{40} # v7\.0\.1[\s\S]*name: release-package-candidate/)
  assert.match(publish, /Rehydrate exact pre-tag package candidate[\s\S]*release-package-candidate[\s\S]*PRETAG_SHA1[\s\S]*PRETAG_SHA256/)
  assert.match(publish, /uses: actions\/attest@[0-9a-f]{40} # v4\.2\.2/)
  assert.match(publish, /subject-path: \$\{\{ steps\.package\.outputs\.tarball \}\}/)
  assert.match(publish, /PROVENANCE_NAME=\"\$\{PACKAGE_TARBALL\}\.intoto\.jsonl\"/)
  assert.match(publish, /gh attestation verify \"\$PACKAGE_TARBALL\"[\s\S]*--signer-workflow[\s\S]*--source-digest \"\$RELEASE_SHA\"[\s\S]*--deny-self-hosted-runners/)
  assert.match(publish, /PROVENANCE_BYTES[\s\S]*131072/)
  assert.match(publish, /uses: actions\/upload-artifact@[0-9a-f]{40} # v7\.0\.1[\s\S]*name: release-provenance[\s\S]*retention-days: 1/)
  assert.doesNotMatch(publish, /bundle_b64|base64 -w0/)
  assert.match(release, /gh run download \"\$GITHUB_RUN_ID\"[\s\S]*--name release-provenance/)
  assert.match(release, /release provenance handoff failed SHA-256 verification/)
  assert.match(release, /gh release create[\s\S]*\"\$PROVENANCE_NAME\"/)
  // Immutability applies the moment a release is published, so every asset must
  // be attached to a draft and verified before the release becomes public.
  assert.match(release, /Create immutable GitHub Release \(draft, attach, publish\)/)
  assert.match(release, /gh release create "\$RELEASE_TAG" \\\n\s+--verify-tag \\\n\s+--draft/)
  assert.match(release, /gh release upload "\$RELEASE_TAG"[\s\S]*"\$PACKAGE_TARBALL"[\s\S]*"\$PROVENANCE_NAME"[\s\S]*"SHA256SUMS\.txt"/)
  assert.match(release, /attached release tarball does not match the verified package SHA-256/)
  assert.match(release, /gh release edit "\$RELEASE_TAG" --draft=false --latest/)
  assert.match(release, /is still a draft after publish/)
  const draftIndex = release.indexOf('--draft')
  const uploadIndex = release.indexOf('gh release upload "$RELEASE_TAG"')
  const verifyIndex = release.indexOf('attached release tarball does not match')
  const publishIndex = release.indexOf('--draft=false --latest')
  assert.ok(
    draftIndex > 0 && uploadIndex > draftIndex && verifyIndex > uploadIndex && publishIndex > verifyIndex,
    'release assets must be attached and verified before the immutable release is published',
  )
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
  const end = hardening.indexOf('\n  linux-desktop-screenshot:', start)
  assert.ok(start >= 0 && end > start, 'Windows screenshot job anchors must remain explicit and ordered')
  const windows = hardening.slice(start, end)
  assert.match(windows, /timeout-minutes: 5/)
  assert.match(windows, /actions\/setup-node@/)
  assert.doesNotMatch(windows, /pnpm\/action-setup|pnpm install|cache: pnpm/)
})

test('workflow path filters follow canonical source ownership instead of generated package artifacts', async () => {
  const { access, readdir } = await import('node:fs/promises')
  const workflowDir = new URL('../.github/workflows/', import.meta.url)
  for (const name of (await readdir(workflowDir)).filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))) {
    const source = await readFile(new URL(name, workflowDir), 'utf8')
    const triggerRegion = source.slice(0, source.indexOf('\nconcurrency:') >= 0 ? source.indexOf('\nconcurrency:') : source.indexOf('\njobs:'))
    for (const match of triggerRegion.matchAll(/^\s+- '([^']+)'\s*$/gm)) {
      const path = match[1]
      assert.notEqual(path === 'entry.js' || path === 'index.js' || path.startsWith('lib/'), true,
        `${name}: generated package artifact cannot own a workflow trigger: ${path}`)
      if (!path.startsWith('src/') || /[*?[\]]/.test(path)) continue
      await assert.doesNotReject(
        () => access(new URL(`../${path}`, import.meta.url)),
        `${name}: canonical workflow trigger must exist: ${path}`,
      )
    }
  }
})

test('CI impact classifier is bounded and fail-closed for trusted shadow input', async () => {
  const { classifyCiImpact, classifyCiImpactJsonLines, MAX_CI_IMPACT_INPUT_BYTES, MAX_CI_IMPACT_PATHS } = await import('../scripts/ci-impact-classifier.mjs')

  assert.equal(classifyCiImpact(['docs/doctor.md', 'README.md']).docsOnly, true)
  assert.equal(classifyCiImpact(['src/lib/windows-desktop-capture.js']).windows, true)
  assert.equal(classifyCiImpact(['src/lib/windows-desktop-capture.js']).full, false)
  assert.equal(classifyCiImpact(['src/lib/client.js']).browser, true)
  const sessionTurnResolver = classifyCiImpact(['src/lib/session-turn-resolver.js'])
  assert.equal(sessionTurnResolver.host, true)
  assert.equal(sessionTurnResolver.browser, false)
  assert.equal(sessionTurnResolver.full, false)
  assert.deepEqual(sessionTurnResolver.reasons, [])
  const imageOffloadCompat = classifyCiImpact(['src/lib/image-offload-compat.js'])
  assert.equal(imageOffloadCompat.host, true)
  assert.equal(imageOffloadCompat.browser, false)
  assert.equal(imageOffloadCompat.full, false)
  assert.deepEqual(imageOffloadCompat.reasons, [])
  const issue431 = classifyCiImpact([
    'src/lib/client-presentation-boundary-main.js',
    'src/lib/vision-model-visibility-boundary-main.js',
    'tests/issue-284-model-visibility.test.js',
    'tests/issue-284-vision-selection-effort.test.js',
  ])
  assert.equal(issue431.browser, true)
  assert.equal(issue431.host, false)
  assert.equal(issue431.full, false)
  assert.deepEqual(issue431.reasons, [])
  for (const path of [
    'src/lib/live-model-client-prelude.js',
    'src/lib/settings-ia-client-prelude.js',
    'src/lib/settings-limit-client-prelude.js',
    'src/lib/strict-live-model-client-prelude.js',
    'src/lib/vision-turn-budget-client-prelude.js',
    'src/lib/wrapper-scope-client-prelude.js',
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
    'src/lib/client-host-compat-prelude.js',
    'src/lib/guide-vision-toggle-highlight.js',
    'src/lib/remote-settings-risk-confirmation.js',
    'src/lib/settings-client-loader-lifecycle.js',
    'src/lib/settings-factory-lifecycle.js',
    'src/lib/settings-native-card-layout.js',
    'src/lib/v2-settings-ia-integration.js',
    'src/lib/vision-capability-benchmark-client.js',
    'src/lib/vision-exact-check-client.js',
    'src/lib/vision-routing-settings-prelude.js',
  ]) {
    const browserOnly = classifyCiImpact([path])
    assert.equal(browserOnly.browser, true, `${path}: audited browser boundary`)
    assert.equal(browserOnly.host, false, `${path}: not a Host boundary`)
    assert.equal(browserOnly.full, false, `${path}: browser-scoped change`)
  }
  assert.equal(classifyCiImpact(['package.json']).full, true)
  assert.deepEqual(classifyCiImpact(['package.json']).reasons, ['CI/package routing metadata changed'])
  assert.equal(classifyCiImpact(['src/lib/new-unknown-boundary.js']).full, true)
  assert.equal(classifyCiImpact([]).full, true)
  assert.equal(classifyCiImpact(Array(MAX_CI_IMPACT_PATHS + 1).fill('src/lib/client.js')).full, true)
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
    const trigger = "      - 'src/lib/*-client-prelude.js'"
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
    'src/lib/client-host-compat-prelude.js',
    'src/lib/guide-vision-toggle-highlight.js',
    'src/lib/remote-settings-risk-confirmation.js',
    'src/lib/settings-client-loader-lifecycle.js',
    'src/lib/settings-factory-lifecycle.js',
    'src/lib/settings-native-card-layout.js',
    'src/lib/v2-settings-ia-integration.js',
    'src/lib/vision-capability-benchmark-client.js',
    'src/lib/vision-exact-check-client.js',
    'src/lib/vision-routing-settings-prelude.js',
  ]
  for (const name of workflows) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    assert.equal(source.split("      - 'src/lib/web/**'").length - 1, 2, `${name}: lib/web must trigger PR and main`)
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
      'src/lib/vision-model-visibility-boundary-main.js',
      'src/lib/vision-model-visibility-boundary.js',
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

test('DSH release evidence changes always trigger exact source and real browser gates', async () => {
  const [browser, source] = await Promise.all([
    readFile(new URL('../.github/workflows/dsh-preview-browser-smoke.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-alpha-source-contract.yml', import.meta.url), 'utf8'),
  ])

  for (const path of ["'package.json'", "'src/lib/dsh-support-window.js'"]) {
    assert.equal((browser.match(new RegExp(path.replaceAll('.', '\\.'), 'g')) ?? []).length, 2)
  }
  assert.equal((source.match(/'package\.json'/g) ?? []).length, 2)
  assert.equal((source.match(/'src\/lib\/dsh-support-window\.js'/g) ?? []).length, 2)
})

test('DSH 0.1.7 browser smoke follows both presentation-boundary carriers', async () => {
  const source = await readFile(new URL('../.github/workflows/dsh-017-browser-smoke.yml', import.meta.url), 'utf8')
  for (const path of [
    "'src/lib/client-presentation-boundary-main.js'",
    "'src/lib/client-presentation-boundary.js'",
  ]) {
    assert.equal((source.match(new RegExp(path.replaceAll('.', '\\.'), 'g')) ?? []).length, 2)
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
    assert.match(source, /KEY="dsh-web-v4-\$\{RUNNER_OS\}-node22-pnpm11\.7\.0-\$\{DSH_SHA\}-\$\{LOCK_SHA\}-\$\{TREE_SHA\}"/)
    assert.match(source, /DSH_SHA="\$\(git rev-parse HEAD\)"/)
    assert.match(source, /LOCK_SHA="\$\(sha256sum pnpm-lock\.yaml/)
    assert.match(source, /TREE_SHA="\$\(git ls-tree -r --full-tree HEAD/)
    assert.match(source, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && steps\.dsh-build-cache\.outputs\.cache-hit != 'true'/)
    assert.match(source, new RegExp(`- name: ${buildName}\\n\\s+if: steps\\.dsh-build-cache\\.outputs\\.cache-hit != 'true'`))
    assert.match(source, new RegExp(`${root}/lib[\\s\\S]*${root}/packages/\\*/\\*/lib[\\s\\S]*${root}/vendor/\\*/lib[\\s\\S]*${root}/apps/\\*/lib[\\s\\S]*${root}/apps/web/dist[\\s\\S]*${root}/\\.dsh-build`))

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

test('DSH build caches retain native JS entrypoints and binaries as one complete build surface', async () => {
  const workflows = [
    'dsh-preview-browser-smoke.yml',
    'alpha-browser-cold-toggle-smoke.yml',
    'dsh-017-browser-smoke.yml',
    'dsh-017-real-host-smoke.yml',
    'dsh-020-rc2-validation.yml',
  ]

  for (const name of workflows) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    const cacheBlocks = [...source.matchAll(/path: \|\n((?:\s{12}[^\n]+\n)+)\s{10}key:/g)]
      .map(([, block]) => block)
      .filter(block => block.includes('/.dsh-build'))
    assert.ok(cacheBlocks.length > 0, `${name}: expected at least one DSH build cache block`)
    for (const block of cacheBlocks) {
      assert.match(block, /native\/system\/packages\/\*\/lib/, `${name}: cache must retain @deepseek-ai/node-addon-system JS entrypoints`)
      assert.match(block, /native\/system\/packages\/\*\/bin/, `${name}: cache must retain platform native binaries`)
    }
  }

  const rc17 = await readFile(new URL('../.github/workflows/dsh-017-real-host-smoke.yml', import.meta.url), 'utf8')
  assert.match(rc17, /dsh-desktop-renderer-v2-/,
    'renderer cache schema must invalidate the old cache that omitted native JS entrypoints')
})

test('Desktop renderer E2E drives the Vision onboarding through the account-owned Settings launcher', async () => {
  const source = await readFile(new URL('../scripts/dsh-desktop-renderer-e2e.mjs', import.meta.url), 'utf8')
  assert.match(source, /exerciseVisionOnboardingSettingsPath\(page\)/)
  assert.match(source, /phase === 'menu' \|\| phase === 'nav'/)
  assert.match(source, /getByRole\('menuitem', \{ name: \/设置\|Settings\/i \}\)/)
  assert.match(source, /\[data-vr-guide-target="vision-backend"\]/)
  assert.doesNotMatch(source, /dismissVisionOnboarding/,
    'real Desktop coverage must exercise the onboarding path instead of skipping it')
})

test('issue #684 Desktop renderer captures bounded Host selection and button state evidence on timeout', async () => {
  const source = await readFile(new URL('../scripts/dsh-desktop-renderer-e2e.mjs', import.meta.url), 'utf8')
  assert.match(source, /path: '\/dvr-e2e-model-selections'/)
  assert.match(source, /event\?\.type === 'model\/selection'/)
  assert.match(source, /latest: selections\.slice\(-8\)/)
  assert.match(source, /history\.length > 48/)
  assert.match(source, /window\.__dvrDesktopToggleAudit/)
  assert.match(source, /readHostModelSelections\(authenticatedHostUrl\)/)
  assert.match(source, /hostSelections=\$\{JSON\.stringify\(hostSelections\)\}/)
  assert.match(source, /buttonHistory=\$\{JSON\.stringify\(buttonHistory\)\}/)
  assert.match(source, /const deadline = Date\.now\(\) \+ 30_000/)
  assert.equal((source.match(/await toggle\.click\(\)/g) ?? []).length, 2,
    'diagnostics must not add hidden selection retries or extra toggle clicks')
})

test('issue #684 real Desktop validates its forensic Host event probe on successful two-way toggles', async () => {
  const source = await readFile(new URL('../scripts/dsh-desktop-renderer-e2e.mjs', import.meta.url), 'utf8')
  assert.match(source, /const selectionProbe = await readHostModelSelections\(authenticatedHostUrl\)/)
  assert.match(source, /const committedSession = selectionProbe\.sessions\.find/)
  assert.match(source, /event\?\.provider === expectedProviders\[index\]/)
  assert.match(source, /event\.model === 'desktop-text'/)
  assert.match(source, /await waitForSettledVisionState\(initialPressed, 'return transition'\)/)
  assert.equal((source.match(/await toggle\.click\(\)/g) ?? []).length, 2,
    'the positive control must not add extra clicks or retries')
})

test('issue #684 forensics observes Host next and a bounded browser directory snapshot', async () => {
  const source = await readFile(new URL('../scripts/dsh-desktop-renderer-e2e.mjs', import.meta.url), 'utf8')
  assert.match(source, /next: modelSelectionSummary\(state\.pending \?\? state\.lastUsed\)/,
    'Host stateOf returns raw pending/lastUsed; derive the wire next instead of reading nonexistent state.next')
  assert.match(source, /assert\.equal\(committedSession\.projected\?\.next\?\.provider/,
    'real alpha.2 Desktop must positive-control the reconstructed wire next')
  assert.match(source, /scope\.sessions\.list\(\)\.slice\(-8\)/)
  assert.match(source, /function readClientModelDirectory\(page\)/)
  assert.match(source, /depth < 64/, 'browser directory lookup must be bounded')
  assert.match(source, /groupCount: Array\.isArray\(state\?\.groups\)/)
  assert.match(source, /hasError: typeof state\?\.error === 'string'/)
  assert.ok(source.includes('clientDirectory=${JSON.stringify(clientDirectory)}'),
    'a failure must carry the sanitized client snapshot alongside Host evidence')
  assert.match(source, /assert\.equal\(clientDirectory\.available, true/,
    'a successful Desktop toggle must positive-control the browser probe')
  assert.doesNotMatch(source, /error: state\?\.error|groups: state\?\.groups|sessionId: directory\.sessionId/,
    'never serialize raw error or directory internals')
})

test('Desktop renderer E2E waits for each Vision selection transaction to settle', async () => {
  const source = await readFile(new URL('../scripts/dsh-desktop-renderer-e2e.mjs', import.meta.url), 'utf8')
  assert.match(source, /const toggledPressed = initialPressed === 'true' \? 'false' : 'true'/,
    'the real Host check must exercise the opposite state regardless of its persisted initial mode')
  const stabilitySource = await readFile(new URL('../scripts/dsh-desktop-toggle-stability.mjs', import.meta.url), 'utf8')
  assert.match(source, /page\.evaluate\(installDesktopVisionToggleAudit\)/)
  assert.match(source, /__dvrDesktopToggleAudit\?\.stableFor\(target, 300\)/)
  assert.match(stabilitySource, /new MutationObserver/)
  assert.match(stabilitySource, /attributeFilter: \['aria-pressed', 'aria-busy', 'disabled'\]/)
  assert.match(stabilitySource, /childList: true/)
  assert.doesNotMatch(source, /page\.waitForTimeout\(300\)/, 'two endpoint samples cannot establish uninterrupted readiness')
  const firstToggle = source.indexOf("await waitForSettledVisionState(toggledPressed, 'first transition')")
  const secondClick = source.indexOf('await toggle.click()', firstToggle)
  const restored = source.indexOf("await waitForSettledVisionState(initialPressed, 'return transition')", secondClick)
  assert.match(source, /window\.__dvrDesktopToggleAudit\?\.stableFor\(target, 300\)/,
    'the first toggle must remain continuously actionable before the second click')
  assert.match(source, /const deadline = Date\.now\(\) \+ 30_000/,
    'continuous ready-state checks must have a single bounded deadline')
  assert.match(source, /waitForSettledVisionState\(initialPressed, 'initial ready baseline'\)/,
    'the test must wait for a stable initial model directory before toggling')
  assert.match(source, /observed=\$\{JSON\.stringify\(observed\)\}/,
    'failed transitions must emit bounded button-state evidence')
  assert.ok(firstToggle >= 0 && secondClick > firstToggle && restored > secondClick,
    'the second click must wait for the first Host-owned selection to become interactive')
})

test('Desktop E2E diagnostic files persist only fixed summaries of Host network evidence', async () => {
  const source = await readFile(new URL('../scripts/dsh-desktop-renderer-e2e.mjs', import.meta.url), 'utf8')
  assert.match(source, /function fileSafeCoreProbe\(probe\)/)
  assert.match(source, /coreProbe: fileSafeCoreProbe\(lastCoreProbe\)/)
  assert.match(source, /runtimePackageEvidence: fileSafeRuntimePackageEvidence\(runtimePackageEvidence\)/)
  assert.match(source, /failureState: fileSafeFailureState\(failureState\)/)
  assert.match(source, /functionalVisionTurn: fileSafeTurnEvidence\(textEvidence, visionEvidence\)/)
  assert.doesNotMatch(source, /writeFileSync\(diagnosticPath,[^\n]*JSON\.stringify\(failure/,
    'raw failure objects may contain Host response bodies and must never be persisted')
  assert.doesNotMatch(source, /writeFileSync\(diagnosticPath,[^\n]*JSON\.stringify\(lastCoreProbe/,
    'raw Host probe responses must remain console-only')
  const fileFailureStart = source.indexOf('const fileFailure = {')
  const fileFailureEnd = source.indexOf('try { writeFileSync(diagnosticPath', fileFailureStart)
  assert.ok(fileFailureStart >= 0 && fileFailureEnd > fileFailureStart)
  const persistedFailureShape = source.slice(fileFailureStart, fileFailureEnd)
  assert.doesNotMatch(persistedFailureShape, /\berror\s*:/,
    'persisted failure diagnostics must not carry arbitrary thrown/network error text')
  assert.doesNotMatch(persistedFailureShape, /\bcoreProbe\s*:\s*lastCoreProbe\b/,
    'persisted failure diagnostics must project rather than copy Host probe data')
})

test('heavy Host classifier skips only version-only curated release metadata', async () => {
  const { classifyHeavyHostImpact } = await import('../scripts/ci-heavy-host-impact.mjs')
  const base = { name: 'dsh-vision-router', version: '2.2.5', peerDependencies: { dsh: '^0.2.0' } }
  const release = { ...base, version: '2.2.6' }

  assert.deepEqual(
    classifyHeavyHostImpact({ changedPaths: ['package.json', 'docs/releases/v2.2.6.md'], basePackage: base, headPackage: release }),
    { heavy: false, reason: 'release metadata only: package version + curated notes' },
  )
  assert.equal(classifyHeavyHostImpact({ changedPaths: ['package.json'], basePackage: base, headPackage: release }).heavy, false)
  assert.equal(classifyHeavyHostImpact({ changedPaths: ['docs/releases/v2.2.6.md'], basePackage: base, headPackage: release }).heavy, false)

  const peerChanged = { ...release, peerDependencies: { dsh: '>=0.2.0-rc.1 <0.3.0-0' } }
  assert.equal(classifyHeavyHostImpact({ changedPaths: ['package.json'], basePackage: base, headPackage: peerChanged }).heavy, true)
  assert.equal(classifyHeavyHostImpact({ changedPaths: ['package.json', 'src/lib/dsh-settings-017-compat.js'], basePackage: base, headPackage: release }).heavy, true)
  assert.equal(classifyHeavyHostImpact({ changedPaths: ['.github/workflows/dsh-020-rc2-validation.yml'], basePackage: base, headPackage: release }).heavy, true)
  assert.equal(classifyHeavyHostImpact({ changedPaths: [], basePackage: base, headPackage: release }).heavy, true)
})

test('heavy Host workflows fail closed on PR impact and reuse only main-written exact build caches', async () => {
  const cacheSha = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9'
  for (const name of ['dsh-017-real-host-smoke.yml', 'dsh-020-rc2-validation.yml']) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    assert.match(source, /name: classify heavy Host impact/)
    assert.match(source, /git show "\$BASE_SHA:scripts\/ci-heavy-host-impact\.mjs"/)
    assert.match(source, /trusted base classifier unavailable: fail closed/)
    assert.match(source, /if: needs\.impact\.outputs\.heavy == 'true'/)
    assert.match(source, new RegExp(`actions/cache/restore@${cacheSha}`))
    assert.match(source, new RegExp(`actions/cache/save@${cacheSha}`))
    assert.doesNotMatch(source, /restore-keys:/)
    assert.match(source, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/)
    assert.match(source, /if: steps\.dsh-build-cache\.outputs\.cache-hit != 'true'/)
    assert.match(source, /native\/system\/packages\/\*\/lib/)
    assert.match(source, /native\/system\/packages\/\*\/bin/)
    assert.match(source, /vendor\/\*\/lib/)
    assert.match(source, /apps\/\*\/lib/)
  }

  const rc17 = await readFile(new URL('../.github/workflows/dsh-017-real-host-smoke.yml', import.meta.url), 'utf8')
  assert.match(rc17, /push:\n\s+branches: \[main\]/)
  const rc20 = await readFile(new URL('../.github/workflows/dsh-020-rc2-validation.yml', import.meta.url), 'utf8')
  assert.match(rc20, /KEY="dsh-web-v4-\$\{RUNNER_OS\}-node22-pnpm11\.7\.0-/)
  assert.match(rc20, /KEY="dsh-host-v4-\$\{RUNNER_OS\}-node\$\{NODE_VERSION\}-pnpm11\.7\.0-/)
  assert.doesNotMatch(rc20, /DSH_EXPECTED_VERSION: 0\.2\.0-rc\.1/, 'rc.2 Desktop renderer gates must not retain the rc.1 runtime identity')
})

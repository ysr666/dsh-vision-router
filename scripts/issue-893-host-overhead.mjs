// Diagnostic-only benchmark; never distribute the instrumented files.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.env.DVR_SOURCE_ROOT)
const host = resolve(process.env.DSH_SOURCE_ROOT)
const sourcePath = join(root, 'src/lib/live-model-discovery.js')
const builtPath = join(root, 'lib/live-model-discovery.js')
const original = readFileSync(sourcePath, 'utf8')
const built = readFileSync(builtPath, 'utf8')
assert.equal(original, built)
const digest = source => createHash('sha256').update(source).digest('hex')
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'instrumentation anchor: ' + before)
  return source.replace(before, () => after)
}
const symbol = JSON.stringify('dvr.issue893.profile.metrics')
const harnessPath = join(root, 'scripts/issue-893-generated-host-overhead.mjs')
const temporary = mkdtempSync(join(tmpdir(), 'dvr-893-ab-'))
function instrument(source, variant) {
  const metric = JSON.stringify({ variant, sourceDigest: digest(source), calls: 0, errors: 0, cpuUs: 0, wallMs: 0, byCaller: {} })
  source = replaceOnce(source, 'function configEditorProviders(ctx) {',
    'const issue893Metric = globalThis[Symbol.for(' + symbol + ')] ??= ' + metric + '\nfunction configEditorProviders(ctx) {')
  return replaceOnce(source, '    const rows = editor.configuration()', [
    '    let rows',
    '    issue893Metric.calls += 1',
    '    const frames = (new Error().stack || "").split("\\n").slice(3, 9)',
    '    const caller = frames.map(frame => { const match = /([^\\\\/():]+\\.js):(\\d+):\\d+/.exec(frame); return match ? match[1] + ":" + match[2] : "other" }).join(" > ")',
    '    const bucket = issue893Metric.byCaller[caller] ??= { calls: 0, wallMs: 0 }',
    '    bucket.calls += 1',
    '    const cpu = process.cpuUsage()',
    '    const wall = performance.now()',
    '    try { rows = editor.configuration() }',
    '    catch (error) { issue893Metric.errors += 1; throw error }',
    '    finally {',
    '      const used = process.cpuUsage(cpu)',
    '      issue893Metric.cpuUs += used.user + used.system',
    '      const elapsed = performance.now() - wall',
    '      issue893Metric.wallMs += elapsed',
    '      bucket.wallMs += elapsed',
    '    }',
  ].join('\n'))
}
let harness = readFileSync(join(root, 'scripts/dsh-desktop-renderer-e2e.mjs'), 'utf8').replace(/\r\n/g, '\n')
const routeAnchor = "  ctx.inject(['webServer'], (scope) => {\n    scope.effect(() => scope.webServer.register({\n      kind: 'exact',\n      path: '/dvr-e2e-core-status',"
harness = replaceOnce(harness, routeAnchor,
  "  ctx.inject(['webServer'], (scope) => {\n    scope.effect(() => scope.webServer.register({\n      kind: 'exact',\n      path: '/dvr-e2e-893-profile-metrics',\n      handler(_request, response) {\n        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })\n        response.end(JSON.stringify(globalThis[Symbol.for(" + symbol + ")] ?? null))\n      },\n    }), 'desktop-e2e: diagnostic-only config profile counters')\n" + routeAnchor.slice(routeAnchor.indexOf('\n') + 1))
const mockAnchor = "  textServer = await listenHttp(async (req, res) => {\n    if (req.method !== 'POST'"
harness = replaceOnce(harness, mockAnchor,
  "  textServer = await listenHttp(async (req, res) => {\n    if (req.method === 'GET' && req.url === '/v1/models') {\n      res.writeHead(200, { 'content-type': 'application/json' })\n      res.end(JSON.stringify({ data: [{ id: 'desktop-text' }] }))\n      return\n    }\n    if (req.method !== 'POST'")
const extra = []
for (let i = 1; i <= 11; i++) {
  extra.push(
    "    '      profile-bench-" + i + ":',",
    "    '        displayName: Profile Bench " + i + "',",
    "    '        api: openai-completions',",
    "    '        apiKeyEnv: DVR_DESKTOP_E2E_API_KEY',",
    '    ' + String.fromCharCode(96) + '        baseURL: ' + '$' + '{textServer.url}/v1' + String.fromCharCode(96) + ',',
    "    '        models:',",
    "    '          - id: desktop-text',",
    "    '            input: [text]',",
    "    '            contextWindow: 131072',",
    "    '            maxTokens: 2048',",
  )
}
const providersAnchor = "    ...(checkNativePolicy ? [\n      // A different provider"
harness = replaceOnce(harness, providersAnchor, extra.join('\n') + '\n' + providersAnchor)
harness = replaceOnce(harness, '  child = spawn(executable, args, {',
  '  const startupStarted = performance.now()\n  child = spawn(executable, args, {')
harness = replaceOnce(harness, "const dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || join(here, '..'))",
  "const withoutDvr = process.env.DVR_893_VARIANT === 'host-only'\nconst dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || join(here, '..'))")
harness = replaceOnce(harness, "  manifest.dependencies['dsh-vision-router'] = ",
  "  if (!withoutDvr) manifest.dependencies['dsh-vision-router'] = ")
harness = replaceOnce(harness, "  if (!manifest.dsh.profile.bundles.includes('dsh-vision-router'))",
  "  if (!withoutDvr && !manifest.dsh.profile.bundles.includes('dsh-vision-router'))")
harness = replaceOnce(harness, "    '- id: vision-router',",
  "    ...(!withoutDvr ? [\n    '- id: vision-router',")
harness = replaceOnce(harness, "    '        model: desktop-vision',\n    '',",
  "    '        model: desktop-vision',\n    ] : []),\n    '',")
harness = replaceOnce(harness, "  reportPhase('desktop-boot-ready')",
  "  const bootMs = performance.now() - startupStarted\n  reportPhase('desktop-boot-ready')")
const start = "  const markers = boot.injections.filter"
const end = '\n} catch (error) {\n  if (page && screenshotPath) {'
assert.equal(harness.split(start).length, 2)
assert.equal(harness.split(end).length, 2)
const beginAt = harness.indexOf(start)
const endAt = harness.indexOf(end)
assert.ok(endAt > beginAt)
harness = harness.slice(0, beginAt) + '\n' + ["  const marks = boot.injections.filter(row => row?.kind === 'script' && typeof row.text === 'string').map(row => row.text).join('\\n')","  assert.equal(marks.includes('data-vision-router-presentation-boundary'), !withoutDvr, 'DVR presence control')","  const composer = page.locator('[data-composer-input][contenteditable=\"true\"]').first()","  await composer.waitFor({ state: 'visible', timeout: 30000 })","  const model = page.getByRole('button', { name: /^(?:Select model|选择模型)/i }).last()","  await model.waitFor({ state: 'visible', timeout: 30000 })","  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(node => /^(?:Select model|选择模型)/i.test(node.getAttribute('aria-label') || '') && !node.disabled && node.getAttribute('aria-busy') !== 'true'), null, { timeout: 30000 })","  const commonReadyMs = performance.now() - startupStarted","  assert.ok(existsSync(workspace), 'default workspace not initialized')","  const sample = async () => {","    const target = new URL(authenticatedHostUrl)","    const cookie = await exchangeHostCookie(authenticatedHostUrl)","    target.pathname = '/dvr-e2e-893-profile-metrics'","    target.search = ''","    const response = await fetchHostProbe(target, { headers: { cookie }, redirect: 'manual' })","    assert.ok(response.ok, 'missing real Host benchmark endpoint')","    return await response.json()","  }","  const common = await sample()","  let visionReadyMs = null","  if (!withoutDvr) {","    await page.waitForFunction(() => { const node = document.querySelector('[data-vision-router-mode-toggle=\"true\"]'); return node && !node.disabled && node.getAttribute('aria-busy') !== 'true' }, null, { timeout: 30000 })","    visionReadyMs = performance.now() - startupStarted","  } else assert.equal(await page.locator('[data-vision-router-mode-toggle=\"true\"]').count(), 0)","  await new Promise(resolve => setTimeout(resolve, 1000))","  const settled = await sample()","  assert.equal(rendererErrors.length, 0)","  writeFileSync(process.env.DVR_893_SAMPLE, JSON.stringify({ dsh: dshVersion, platform: process.platform, electronNode, bootMs, commonReadyMs, visionReadyMs, common, settled }))","  reportPhase('issue-893-profile-sampled')"].join('\n') + harness.slice(endAt)

const results = []
try {
  writeFileSync(harnessPath, harness)
  const syntax = spawnSync(process.execPath, ['--check', harnessPath], { stdio: 'inherit' })
  assert.equal(syntax.status, 0)
  for (const [index, variant] of ['host-only', 'candidate', 'candidate', 'host-only'].entries()) {
    const raw = original
    const patched = variant === 'candidate' ? instrument(raw, variant) : raw
    writeFileSync(sourcePath, patched)
    writeFileSync(builtPath, patched)
    const samplePath = join(temporary, 'sample-' + index + '.json')
    const child = spawnSync(process.execPath, ['--import', 'tsx', harnessPath], {
      cwd: host, env: { ...process.env, DVR_DESKTOP_CHECK_WHOLE_TURN_ROUTING: '1', DVR_893_SAMPLE: samplePath, DVR_893_VARIANT: variant },
      stdio: 'inherit', timeout: 240000,
    })
    assert.equal(child.status, 0, 'real Desktop startup failed: ' + variant + ' ' + String(child.error ?? child.signal ?? ''))
    const sample = JSON.parse(readFileSync(samplePath, 'utf8'))
    if (variant === 'host-only') {
      assert.equal(sample.common, null)
      assert.equal(sample.settled, null)
      assert.equal(sample.visionReadyMs, null)
    } else {
      for (const metric of [sample.common, sample.settled]) {
        assert.equal(metric.variant, variant)
        assert.equal(metric.sourceDigest, digest(raw))
        assert.ok(metric.calls > 0)
        assert.equal(metric.errors, 0)
        assert.equal(Object.values(metric.byCaller).reduce((n, bucket) => n + bucket.calls, 0), metric.calls)
      }
      assert.ok(sample.settled.calls >= sample.common.calls)
    }
    results.push({ variant, ...sample })
    console.log('ISSUE_893_SAMPLE ' + JSON.stringify({ variant, ...sample }))
  }
  const average = (variant, metric) => {
    const rows = results.filter(row => row.variant === variant)
    return rows.reduce((sum, row) => sum + metric(row), 0) / rows.length
  }
  const summary = Object.fromEntries(['host-only', 'candidate'].map(variant => [variant, {
    bootMs: average(variant, r => r.bootMs),
    commonReadyMs: average(variant, r => r.commonReadyMs),
    ...(variant === 'candidate' ? { visionReadyMs: average(variant, r => r.visionReadyMs),
      callsAtCommon: average(variant, r => r.common.calls),
      callWallMsAtCommon: average(variant, r => r.common.wallMs) } : {}),
  }]))
  console.log('ISSUE_893_HOST_OVERHEAD ' + JSON.stringify({ results, summary }))
} finally {
  writeFileSync(sourcePath, original)
  writeFileSync(builtPath, built)
  rmSync(harnessPath, { force: true })
  rmSync(temporary, { force: true, recursive: true })
}

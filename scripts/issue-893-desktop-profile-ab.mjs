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
const baseline = readFileSync(resolve(process.env.DVR_BASELINE_SOURCE), 'utf8')
assert.equal(original, built)
assert.notEqual(baseline, original)
const digest = source => createHash('sha256').update(source).digest('hex')
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'instrumentation anchor: ' + before)
  return source.replace(before, () => after)
}
const symbol = JSON.stringify('dvr.issue893.profile.metrics')
const harnessPath = join(root, 'scripts/issue-893-generated-desktop-harness.mjs')
const temporary = mkdtempSync(join(tmpdir(), 'dvr-893-ab-'))
function instrument(source, variant) {
  const metric = JSON.stringify({ variant, sourceDigest: digest(source), calls: 0, errors: 0, cpuUs: 0, wallMs: 0 })
  source = replaceOnce(source, 'function configEditorProviders(ctx) {',
    'const issue893Metric = globalThis[Symbol.for(' + symbol + ')] ??= ' + metric + '\nfunction configEditorProviders(ctx) {')
  return replaceOnce(source, '    const rows = editor.configuration()', [
    '    let rows',
    '    const cpu = process.cpuUsage()',
    '    const wall = performance.now()',
    '    issue893Metric.calls += 1',
    '    try { rows = editor.configuration() }',
    '    catch (error) { issue893Metric.errors += 1; throw error }',
    '    finally {',
    '      const used = process.cpuUsage(cpu)',
    '      issue893Metric.cpuUs += used.user + used.system',
    '      issue893Metric.wallMs += performance.now() - wall',
    '    }',
  ].join('\n'))
}
let harness = readFileSync(join(root, 'scripts/dsh-desktop-renderer-e2e.mjs'), 'utf8')
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
const start = "  reportPhase('vision-toggle-ready')"
const end = '\n} catch (error) {\n  if (page && screenshotPath) {'
assert.equal(harness.split(start).length, 2)
assert.equal(harness.split(end).length, 2)
const beginAt = harness.indexOf(start) + start.length
const endAt = harness.indexOf(end)
assert.ok(endAt > beginAt)
harness = harness.slice(0, beginAt) + "\n" + [
  '  await page.waitForFunction(() => {',
  "    const node = document.querySelector('[data-vision-router-mode-toggle=\"true\"]')",
  "    return node && !node.disabled && node.getAttribute('aria-busy') !== 'true'",
  '  }, null, { timeout: 30000 })',
  '  const readyMs = performance.now() - startupStarted',
  '  const sample = async () => {',
  '    const target = new URL(authenticatedHostUrl)',
  '    const cookie = await exchangeHostCookie(authenticatedHostUrl)',
  "    target.pathname = '/dvr-e2e-893-profile-metrics'",
  "    target.search = ''",
  "    const response = await fetchHostProbe(target, { headers: { cookie }, redirect: 'manual' })",
  "    assert.ok(response.ok, 'missing real Host benchmark endpoint')",
  '    const data = await response.json()',
  "    assert.ok(data && Number.isSafeInteger(data.calls), 'instrumented Host module did not load')",
  '    return data',
  '  }',
  '  const ready = await sample()',
  '  await new Promise(resolve => setTimeout(resolve, 1000))',
  '  const afterOneSecond = await sample()',
  "  assert.equal(rendererErrors.length, 0, 'renderer must remain healthy during startup')",
  '  writeFileSync(process.env.DVR_893_SAMPLE, JSON.stringify({ dsh: dshVersion, platform: process.platform, electronNode, readyMs, ready, afterOneSecond }))',
  "  reportPhase('issue-893-profile-sampled')",
].join('\n') + harness.slice(endAt)

const results = []
try {
  writeFileSync(harnessPath, harness)
  const syntax = spawnSync(process.execPath, ['--check', harnessPath], { stdio: 'inherit' })
  assert.equal(syntax.status, 0)
  for (const [index, variant] of ['baseline', 'candidate', 'candidate', 'baseline'].entries()) {
    const raw = variant === 'baseline' ? baseline : original
    const patched = instrument(raw, variant)
    writeFileSync(sourcePath, patched)
    writeFileSync(builtPath, patched)
    const samplePath = join(temporary, 'sample-' + index + '.json')
    const child = spawnSync(process.execPath, ['--import', 'tsx', harnessPath], {
      cwd: host, env: { ...process.env, DVR_DESKTOP_CHECK_WHOLE_TURN_ROUTING: '1', DVR_893_SAMPLE: samplePath },
      stdio: 'inherit', timeout: 240000,
    })
    assert.equal(child.status, 0, 'real Desktop startup failed: ' + variant + ' ' + String(child.error ?? child.signal ?? ''))
    const sample = JSON.parse(readFileSync(samplePath, 'utf8'))
    for (const metric of [sample.ready, sample.afterOneSecond]) {
      assert.equal(metric.variant, variant)
      assert.equal(metric.sourceDigest, digest(raw))
      assert.ok(metric.calls > 0, 'real ConfigEditor fallback positive control')
      assert.equal(metric.errors, 0)
      assert.ok(Number.isFinite(metric.cpuUs) && metric.cpuUs >= 0)
      assert.ok(Number.isFinite(metric.wallMs) && metric.wallMs >= 0)
    }
    assert.ok(sample.afterOneSecond.calls >= sample.ready.calls)
    results.push({ variant, ...sample })
    console.log('ISSUE_893_SAMPLE ' + JSON.stringify({ variant, ...sample }))
  }
  const average = (variant, metric) => {
    const rows = results.filter(row => row.variant === variant)
    return rows.reduce((sum, row) => sum + metric(row), 0) / rows.length
  }
  const summary = Object.fromEntries(['baseline', 'candidate'].map(variant => [variant, {
    callsAtReady: average(variant, r => r.ready.calls),
    cpuUsAtReady: average(variant, r => r.ready.cpuUs),
    wallMsAtReady: average(variant, r => r.ready.wallMs),
    callsAfterOneSecond: average(variant, r => r.afterOneSecond.calls),
    cpuUsAfterOneSecond: average(variant, r => r.afterOneSecond.cpuUs),
    readyMs: average(variant, r => r.readyMs),
  }]))
  console.log('ISSUE_893_COMPARISON ' + JSON.stringify({ results, summary }))
  assert.ok(summary.candidate.callsAfterOneSecond < summary.baseline.callsAfterOneSecond, 'real cold Desktop startup must reduce configuration reads')
} finally {
  writeFileSync(sourcePath, original)
  writeFileSync(builtPath, built)
  rmSync(harnessPath, { force: true })
  rmSync(temporary, { force: true, recursive: true })
}

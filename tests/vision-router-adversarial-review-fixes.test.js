// Regression suite for the six findings of the 40-round adversarial review
// (.debug/adv/FINAL.md). Every test fails on the pre-fix code and passes after:
// one test per finding, plus the same-class sites that had to move with it.
//
// Run: node --test tests/vision-router-adversarial-review-fixes.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyVisionFailure } from '../lib/vision-resilience.js'
import { parseSettingsNumber } from '../lib/settings-number-contract.js'
import { canonicalProxyHost, proxyHostMatchesAny } from '../lib/proxy-routing.js'
import { blocksHaveRetainedImage } from '../lib/image-offload-compat.js'
import { markVisionRouterAdapter } from '../lib/native-image-coexistence.js'
import { redactDiagnosticText } from '../lib/diagnostic-redaction.js'
import { sanitizeLogText } from '../lib/file-logger.js'
import { createBackgroundBenchmarkStopStoreCore } from '../lib/vision-background-stop-store-core.js'

test('B1-F1: bracketed and bare IPv6 spellings canonicalize to one host', () => {
  assert.equal(canonicalProxyHost('[::1]'), '::1')
  assert.equal(canonicalProxyHost('::1'), '::1')
  assert.equal(canonicalProxyHost('[2001:DB8::1]'), '2001:db8::1')
  assert.equal(canonicalProxyHost('[]'), '')

  // The reported symptom: a configured `::1` never matched a URL-derived `[::1]`.
  assert.equal(proxyHostMatchesAny('[::1]', ['::1']), true)
  assert.equal(proxyHostMatchesAny('::1', ['[::1]']), true)
  assert.equal(proxyHostMatchesAny('[2001:db8::1]', ['[2001:DB8::1]']), true)

  // DNS behaviour is unchanged, including the suffix policy.
  assert.equal(proxyHostMatchesAny('api.example.com', ['example.com']), true)
  assert.equal(proxyHostMatchesAny('example.com.evil.com', ['example.com']), false)
  assert.equal(canonicalProxyHost('EXAMPLE.com.'), 'example.com')
})

test('E2-F1: loading a v3 stop cache rewrites the file when retention dropped a record', async () => {
  const now = 1_700_000_000_000
  const fresh = {
    suiteRevision: 5,
    fingerprint: `ep2_${'a'.repeat(32)}`,
    key: 'k1',
    provider: 'p',
    model: 'm',
    axis: 'ocr',
    errorClass: 'unavailable',
    recordedAt: now - 1_000,
    expiresAt: now + 60_000,
  }
  const expired = { ...fresh, key: 'k2', fingerprint: `ep2_${'b'.repeat(32)}`, expiresAt: now - 1 }

  const writes = []
  const fsOps = {
    readFile: async () => JSON.stringify({ version: 3, stops: [fresh, expired] }),
    mkdir: async () => {},
    writeFile: async (file, body) => writes.push({ file, body }),
    rename: async () => {},
  }
  const store = createBackgroundBenchmarkStopStoreCore({
    file: '/virtual/background-benchmark-stops.json',
    fsOps,
    now: () => now,
  })
  const list = await store.list()

  assert.equal(list.length, 1, 'only the retryable fresh stop survives')
  assert.equal(writes.length, 1, 'the stale record must be removed from disk, not only from memory')
  const persisted = JSON.parse(writes[0].body)
  assert.equal(persisted.version, 3)
  assert.deepEqual(persisted.stops.map((stop) => stop.key), ['k1'])

  // A file that needs no change must stay untouched.
  const cleanWrites = []
  const cleanStore = createBackgroundBenchmarkStopStoreCore({
    file: '/virtual/clean.json',
    fsOps: {
      readFile: async () => JSON.stringify({ version: 3, stops: [fresh] }),
      mkdir: async () => {},
      writeFile: async (file, body) => cleanWrites.push({ file, body }),
      rename: async () => {},
    },
    now: () => now,
  })
  assert.equal((await cleanStore.list()).length, 1)
  assert.equal(cleanWrites.length, 0, 'an unchanged cache must not be rewritten')
})

test('F1-F1: hostile error codes cannot reach prototype machinery', () => {
  // Pre-fix, `Object.prototype` was returned as the *kind* for these codes (an
  // object or a function) and a throwing toString() escaped the classifier.
  for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const result = classifyVisionFailure({ code, message: 'boom' })
    assert.equal(typeof result.kind === 'object' || typeof result.kind === 'function', false)
    assert.equal(result.kind, 'OTHER', `${code} must fall through to the shared OTHER kind`)
  }

  const throwing = { code: 'AUTH', toString() { throw new Error('nope') } }
  assert.equal(classifyVisionFailure(throwing).kind, 'AUTH')

  // Ordinary classification is unchanged (kinds are the uppercase constants).
  assert.equal(classifyVisionFailure({ code: 'RATE_LIMIT' }).kind, 'RATE_LIMIT')
  assert.equal(classifyVisionFailure({ status: 401 }).kind, 'AUTH')
  assert.equal(classifyVisionFailure({ message: 'ENOTFOUND api.example' }).kind, 'NETWORK')
})

test('F1-F1 (same class): settings keys resolve own properties only', () => {
  assert.equal(parseSettingsNumber('__proto__', '2000'), undefined)
  assert.equal(parseSettingsNumber('constructor', '2000'), undefined)
  assert.equal(parseSettingsNumber('toString', '2000'), undefined)
  assert.equal(parseSettingsNumber('nope', '2000'), undefined)

  assert.deepEqual(parseSettingsNumber('timeoutMs', '2000'), { value: 2000 })
  assert.deepEqual(parseSettingsNumber('timeoutMs', '', { allowClear: true }), { clear: true })
  assert.equal(parseSettingsNumber('timeoutMs', '999'), undefined)
})

test('J2-F2: deeply nested content cannot overflow the retained-image walker', () => {
  let content = [{ type: 'image' }]
  for (let depth = 0; depth < 10_000; depth += 1) content = [{ content }]

  // Pre-fix this threw RangeError: Maximum call stack size exceeded.
  assert.equal(blocksHaveRetainedImage(content), false)

  // Within the bound the walker still sees retained images at any depth.
  assert.equal(blocksHaveRetainedImage([{ type: 'image' }]), true)
  assert.equal(blocksHaveRetainedImage([{ type: 'image', offloaded: true }]), false)
  assert.equal(blocksHaveRetainedImage([{ content: [{ content: [{ type: 'image' }] }] }]), true)
})

test('J3-F1: a primitive marker is not ownership; an object marker is', async () => {
  // Imported lazily so this file still loads (and every other finding still
  // reports individually) against the pre-fix build, where the shared predicate
  // did not exist yet.
  const { isVisionRouterOwnedAdapter } = await import('../lib/native-image-coexistence.js')
  assert.equal(typeof isVisionRouterOwnedAdapter, 'function', 'the shared ownership predicate must be exported')

  const symbol = Symbol.for('dsh-vision-router.adapter-owner')

  // Pre-fix every one of these counted as "Vision Router's own adapter".
  for (const forged of ['anything', false, true, null, 0, 42, 'v']) {
    const adapter = { name: 'foreign' }
    adapter[symbol] = forged
    assert.equal(isVisionRouterOwnedAdapter(adapter), false, `${String(forged)} must not count as owned`)
  }

  // A genuine owner is an object marker, whether frozen or a plain record, and
  // whether it was written by this copy or another loaded one.
  const frozenToken = Object.freeze({})
  assert.equal(isVisionRouterOwnedAdapter(markVisionRouterAdapter({ name: 'dvr' }, frozenToken)), true)

  const plain = { name: 'dvr-plain' }
  plain[symbol] = { route: 'deepseek-vision' }
  assert.equal(isVisionRouterOwnedAdapter(plain), true, 'composition marks adapters with plain records')

  assert.equal(isVisionRouterOwnedAdapter(null), false)
  assert.equal(isVisionRouterOwnedAdapter('x'), false)
  assert.equal(isVisionRouterOwnedAdapter({}), false, 'the marker must sit on the adapter')
})

test('J2-F1: no credential shape survives either text redactor', async () => {
  // Lazy for the same reason as the ownership predicate: the shared pass is new.
  const { redactCredentialShapes } = await import('../lib/diagnostic-redaction.js')
  assert.equal(typeof redactCredentialShapes, 'function', 'the shared credential-shape pass must be exported')

  const ghp = `ghp_${'A'.repeat(36)}`
  const aws = 'AKIAIOSFODNN7EXAMPLE'
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const corpus = [
    'Authorization: Bearer sk-abcdefghijklmnop',
    'Authorization: Basic dXNlcjpwYXNz',
    `Authorization: token ${ghp}`,
    'x-api-key: AKIAIOSFODNN7EXAMPLE',
    `Cookie: session=${jwt}`,
    `upstream rejected ${ghp} for this request`,
    `key ${aws} is invalid`,
    'https://api.example/v1?api_key=supersecret&model=x',
    'https://user:pass@api.example/v1',
    'https://api.example/v1#token=supersecret',
    `token=${jwt}`,
    'api_key=supersecret',
    `Set-Cookie: sid=${jwt}; Path=/`,
  ]
  const secrets = [ghp, aws, jwt, 'sk-abcdefghijklmnop', 'dXNlcjpwYXNz', 'supersecret', 'pass']
  for (const line of corpus) {
    for (const [label, redact] of [['diagnostic', redactDiagnosticText], ['log', sanitizeLogText], ['shapes', redactCredentialShapes]]) {
      const out = redact(line)
      for (const secret of secrets) {
        assert.equal(out.includes(secret), false, `${label} leaked ${secret} from: ${line}`)
      }
    }
  }

  // Control characters are still flattened and benign text is untouched.
  assert.equal(redactDiagnosticText('line1\nX-Injected: evil'), 'line1 X-Injected: evil')
  assert.equal(sanitizeLogText('vision backend timed out after 60000ms'), 'vision backend timed out after 60000ms')
  assert.equal(redactDiagnosticText('x'.repeat(5000)).length, 400)
})

test('K6-O4 (same class): an explicit null options bag means "no options", not a crash', async () => {
  // Class-level follow-up of the review: four entry points took their options via
  // a default parameter (`= {}`), which covers `undefined` but not an explicit
  // `null`, so a null argument escaped as a raw TypeError instead of "no options".
  const { objectRecord } = await import('../lib/core-primitives.js')
  assert.equal(objectRecord(null), undefined)
  assert.equal(objectRecord(undefined), undefined)
  assert.equal(objectRecord(42), undefined)
  assert.equal(objectRecord('x'), undefined)
  assert.deepEqual(objectRecord({ a: 1 }), { a: 1 })

  const { createRemoteSettingsRiskClientBoundary } = await import('../lib/remote-settings-risk-client-boundary.js')
  const { createCoreVisionSurfaceRuntime } = await import('../lib/core-vision-surface.js')
  const { createDesktopScreenshotTool } = await import('../lib/desktop-screenshot-tool.js')

  for (const bad of [null, undefined, 42, 'x']) {
    const boundary = createRemoteSettingsRiskClientBoundary(bad)
    assert.equal(typeof boundary.wrapContext, 'function', `risk boundary must absorb ${String(bad)}`)
    const runtime = createCoreVisionSurfaceRuntime(bad)
    assert.deepEqual(Object.keys(runtime), Object.keys(createCoreVisionSurfaceRuntime()))
  }

  // The tool factory validates its required options and must answer with its own
  // named contract error, never with a raw destructuring crash.
  assert.throws(
    () => createDesktopScreenshotTool(null),
    (error) => /desktop screenshot tool/i.test(error.message) && !/destructur/i.test(error.message),
  )
  assert.throws(
    () => createDesktopScreenshotTool({ current: 'nope' }),
    (error) => /desktop screenshot tool/i.test(error.message),
  )

  // Behaviour with real options is unchanged: every option shape still projects
  // the same public surface key set (taken from the runtime itself, not guessed).
  const shapes = [{ config: { localOnlyVision: true } }, { config: {} }, {}, undefined, null]
  const keySets = shapes.map((options) => Object.keys(createCoreVisionSurfaceRuntime(options).current()).sort())
  assert.equal(keySets[0].length > 0, true)
  for (const keys of keySets) assert.deepEqual(keys, keySets[0])

  // The screenshot trigger really runs `screencapture` on macOS, so the null-input
  // assertion only runs where the platform branch is a no-op; CI is Linux.
  if (process.platform !== 'darwin') {
    const { triggerDesktopScreenshotPermission } = await import('../lib/local-vision-stabilizer.js')
    const result = await triggerDesktopScreenshotPermission(null)
    assert.equal(result.ok, true)
    assert.equal(result.requested, false)
  }
})

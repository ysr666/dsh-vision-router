import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  CAPABILITY_BENCHMARK_CLIENT,
  injectCapabilityBenchmarkClient,
} from '../lib/vision-capability-benchmark-client.js'

function count(source, needle) {
  return source.split(needle).length - 1
}

const FORBIDDEN_BROWSER_OWNERS = [
  '/_dsh/vision-router/capability-runtime',
  'RUNTIME_ENDPOINT',
  'fetchBackgroundStatus',
  'function backgroundRun(',
  'function backgroundDeferred(',
  'function backgroundExcluded(',
  'function measuredTextOnly(',
  'function backgroundEligible(',
  'function backgroundNeedsWork(',
  'legacyRenderControl',
  'legacyBackgroundPending',
  'vision-router-presentation-switch-v2',
]

test('C2-D final browser client consumes Host presentation directly with no second semantic owner', () => {
  for (const needle of FORBIDDEN_BROWSER_OWNERS) {
    assert.equal(CAPABILITY_BENCHMARK_CLIENT.includes(needle), false, needle)
  }

  assert.equal(count(CAPABILITY_BENCHMARK_CLIENT, 'function presentationBackground(candidate){'), 1)
  assert.equal(count(CAPABILITY_BENCHMARK_CLIENT, 'function renderControl(row, control, body){'), 1)
  assert.equal(count(CAPABILITY_BENCHMARK_CLIENT, 'function backgroundPending(body){'), 1)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /candidate&&candidate\.presentation/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /presentation&&presentation\.background/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /body\.background\.(?:excluded|deferred)/)

  for (const state of [
    'running',
    'measured-text-only',
    'deferred',
    'stopped',
    'measured-waiting',
    'measured',
    'paused',
    'awaiting-verification',
    'waiting',
    'declared-text-only',
    'unavailable',
    'policy-excluded',
  ]) {
    assert.equal(CAPABILITY_BENCHMARK_CLIENT.includes(`background.state==='${state}'`), true, state)
  }
})

test('C2-D manual benchmark protocol remains on the existing benchmark route', () => {
  assert.equal(count(CAPABILITY_BENCHMARK_CLIENT, "var ENDPOINT = '/_dsh/vision-router/capability-benchmark';"), 1)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /method:'POST'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /method:'DELETE'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.state==='running'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.state==='queued'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job&&job\.state==='failed'/)
})

test('C2-D modal and polling read Host candidate presentation state', () => {
  assert.match(
    CAPABILITY_BENCHMARK_CLIENT,
    /var candidateBackground=presentationBackground\(candidate\);\s*var isMeasuredTextOnly=!!candidateBackground&&candidateBackground\.state==='measured-text-only';/,
  )
  assert.match(
    CAPABILITY_BENCHMARK_CLIENT,
    /var background=presentationBackground\(body\.candidates\[i\]\);/,
  )
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /background\.deferred&&background\.deferred\.retryable===true/)
})

test('C2-D injects the final browser client exactly once', () => {
  const html = '<html><head></head><body></body></html>'
  const injected = injectCapabilityBenchmarkClient(html)
  assert.equal(count(injected, 'data-vision-router-capability-benchmark'), 1)
  for (const needle of FORBIDDEN_BROWSER_OWNERS) assert.equal(injected.includes(needle), false, needle)
  assert.equal(injectCapabilityBenchmarkClient(injected), injected)
})

test('C2-D production panel installs the final client and the switch shim is gone', async () => {
  const panel = await readFile(new URL('../lib/web/benchmark-panel.js', import.meta.url), 'utf8')
  assert.match(panel, /installCapabilityBenchmarkClient/)
  assert.doesNotMatch(panel, /installSwitchedCapabilityBenchmarkClient/)
  await assert.rejects(
    readFile(new URL('../lib/web/benchmark-client-switch.js', import.meta.url)),
    (error) => error?.code === 'ENOENT',
  )
})

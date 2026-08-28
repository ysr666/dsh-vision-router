import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { CAPABILITY_BENCHMARK_CLIENT } from '../lib/vision-capability-benchmark-client.js'
import {
  injectSwitchedCapabilityBenchmarkClient,
  switchCapabilityBenchmarkClientSource,
} from '../lib/web/benchmark-client-switch.js'

const SWITCH_SENTINEL = '/* vision-router-presentation-switch-v2 */'

function count(source, needle) {
  return source.split(needle).length - 1
}

test('C2-C production client consumes Host revision-2 presentation without a runtime side fetch', () => {
  const switched = switchCapabilityBenchmarkClientSource(CAPABILITY_BENCHMARK_CLIENT)

  assert.equal(count(switched, SWITCH_SENTINEL), 1)
  assert.equal(switched.includes('await fetchBackgroundStatus();'), false)
  assert.equal(switched.includes("var RUNTIME_ENDPOINT = '/_dsh/vision-router/capability-runtime';"), true)
  assert.equal(switched.includes('async function fetchBackgroundStatus(){'), true)

  assert.equal(count(switched, 'function legacyRenderControl(row, control, body){'), 1)
  assert.equal(count(switched, 'function renderControl(row, control, body){'), 1)
  assert.equal(count(switched, 'function legacyBackgroundPending(body){'), 1)
  assert.equal(count(switched, 'function backgroundPending(body){'), 1)
  assert.match(switched, /candidate&&candidate\.presentation/)
  assert.match(switched, /presentation&&presentation\.background/)

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
    'not-measured',
  ]) {
    assert.equal(switched.includes(`background.state==='${state}'`), true, state)
  }

  assert.equal(CAPABILITY_BENCHMARK_CLIENT.includes(SWITCH_SENTINEL), false)
  assert.equal(switchCapabilityBenchmarkClientSource(switched), switched)
})

test('C2-C keeps legacy browser decisions only as an explicit fallback oracle', () => {
  const switched = switchCapabilityBenchmarkClientSource(CAPABILITY_BENCHMARK_CLIENT)

  assert.equal(count(switched, 'function backgroundRun(body,key){'), 1)
  assert.equal(count(switched, 'function backgroundDeferred(body,key){'), 1)
  assert.equal(count(switched, 'function backgroundExcluded(body,key){'), 1)
  assert.equal(count(switched, 'function measuredTextOnly(body,key){'), 1)
  assert.equal(count(switched, 'function backgroundEligible(body,candidate){'), 1)
  assert.equal(count(switched, 'function backgroundNeedsWork(candidate){'), 1)
  assert.match(switched, /if\(!background\)return legacyRenderControl\(row,control,body\);/)
  assert.match(switched, /return sawPresentation\?false:legacyBackgroundPending\(body\);/)
  assert.match(switched, /candidateBackground\?candidateBackground\.state==='measured-text-only':measuredTextOnly/)
})

test('C2-C switch fails closed when a production anchor drifts', () => {
  const drifted = CAPABILITY_BENCHMARK_CLIENT.replace(
    '        body.background = await fetchBackgroundStatus();\n',
    '        body.background = await fetchBackgroundStatus(/* drift */);\n',
  )
  assert.throws(
    () => switchCapabilityBenchmarkClientSource(drifted),
    /missing redundant runtime fetch/,
  )
})

test('C2-C injected browser script is switched exactly once', () => {
  const html = '<html><head></head><body></body></html>'
  const injected = injectSwitchedCapabilityBenchmarkClient(html)
  assert.equal(count(injected, 'data-vision-router-capability-benchmark'), 1)
  assert.equal(count(injected, SWITCH_SENTINEL), 1)
  assert.equal(injected.includes('await fetchBackgroundStatus();'), false)
  assert.equal(injectSwitchedCapabilityBenchmarkClient(injected), injected)
})

test('C2-C production benchmark panel installs the switched client', async () => {
  const panel = await readFile(new URL('../lib/web/benchmark-panel.js', import.meta.url), 'utf8')
  assert.match(panel, /installSwitchedCapabilityBenchmarkClient/)
  assert.doesNotMatch(panel, /installCapabilityBenchmarkClient\(/)
})

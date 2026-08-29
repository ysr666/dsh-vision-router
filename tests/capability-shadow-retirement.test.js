import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const RETIRED_SHADOW_SURFACE = /vision-capability-shadow|buildCapabilityShadowPlan|installCapabilityShadowRuntime|collectCapabilityShadowCandidates|autoExecutionConfigFor/

async function missing(path) {
  await assert.rejects(
    readFile(new URL(path, import.meta.url), 'utf8'),
    (error) => error?.code === 'ENOENT',
  )
}

test('C3-A retires the capability-shadow shim and its historical test path', async () => {
  await missing('../lib/vision-capability-shadow.js')
  await missing('./vision-capability-shadow.test.js')
})

test('benchmark presentation consumes final routing evidence directly', async () => {
  const presentation = await readFile(
    new URL('../lib/vision-capability-benchmark-presentation.js', import.meta.url),
    'utf8',
  )
  assert.match(
    presentation,
    /import \{ collectVisionRoutingCandidates \} from '\.\/vision-routing-evidence\.js'/,
  )
  assert.match(presentation, /await collectVisionRoutingCandidates\(/)
  assert.doesNotMatch(presentation, RETIRED_SHADOW_SURFACE)
})

test('final routing parity suite imports the real runtime and evidence modules', async () => {
  const parity = await readFile(
    new URL('./vision-routing-runtime-parity.test.js', import.meta.url),
    'utf8',
  )
  assert.match(parity, /from '\.\.\/lib\/vision-routing-runtime\.js'/)
  assert.match(parity, /from '\.\.\/lib\/vision-routing-evidence\.js'/)
  assert.doesNotMatch(parity, RETIRED_SHADOW_SURFACE)
})

test('routing tests no longer depend on the retired shadow surface', async () => {
  for (const path of [
    './vision-routing-runtime-parity.test.js',
    './vision-execution-order-plan-parity.test.js',
    './vision-routing-evidence-parity.test.js',
    './vision-runtime-performance.test.js',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, RETIRED_SHADOW_SURFACE, path)
  }
})

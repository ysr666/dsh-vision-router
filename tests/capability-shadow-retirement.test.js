import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const RETIRED_SHADOW_SURFACE = /vision-capability-shadow|buildCapabilityShadowPlan|installCapabilityShadowRuntime|collectCapabilityShadowCandidates|autoExecutionConfigFor/
const RETIRED_SHADOW_IMPORT = /(?:from\s+['"][^'"]*vision-capability-shadow\.js['"]|import\s*\(\s*['"][^'"]*vision-capability-shadow\.js['"]\s*\))/

async function missing(path) {
  await assert.rejects(
    readFile(new URL(path, import.meta.url), 'utf8'),
    (error) => error?.code === 'ENOENT',
  )
}

async function sourceFiles(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const entry of entries) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root)
    if (entry.isDirectory()) {
      out.push(...await sourceFiles(child))
    } else if (/\.(?:c?js|mjs)$/.test(entry.name)) {
      out.push(child)
    }
  }
  return out
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

test('no production, test, or script module imports the retired shadow shim', async () => {
  const roots = [
    new URL('../lib/', import.meta.url),
    new URL('./', import.meta.url),
    new URL('../scripts/', import.meta.url),
  ]
  const offenders = []
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, 'utf8')
      if (RETIRED_SHADOW_IMPORT.test(source)) offenders.push(file.pathname)
    }
  }
  assert.deepEqual(offenders, [])
})

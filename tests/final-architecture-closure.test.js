import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root)
    if (entry.isDirectory()) out.push(...await sourceFiles(child))
    else if (/\.(?:c?js|mjs)$/.test(entry.name)) out.push(child)
  }
  return out
}

const OWNER_CONTRACTS = Object.freeze([
  ['Authority', 'lib/vision-routing-authority.js', /export function resolveVisionRoutingAuthority\(/],
  ['Evidence', 'lib/vision-routing-evidence.js', /export async function collectVisionRoutingCandidates\(/],
  ['Planner', 'lib/vision-capability-router.js', /export function rankVisionCandidates\(/],
  ['ExecutionOrder', 'lib/vision-execution-order.js', /export function withVisionExecutionOrder\(/],
  ['SessionVisionIndex', 'lib/session-vision-index.js', /export function createSessionVisionIndex\(/],
  ['SessionVisionStateStore', 'lib/session-vision-state.js', /export function createSessionVisionStateStore\(/],
  ['VisionArtifactStore', 'lib/vision-artifact-store.js', /export function createVisionArtifactStore\(/],
  ['VisionProviderTransport', 'lib/vision-provider-transport.js', /export function createVisionProviderTransport\(/],
  ['Host product presentation', 'lib/vision-product-presentation.js', /export function projectVisionProductCandidate\(/],
])

const TABLETOP_SCENARIOS = Object.freeze([
  {
    name: 'PDF',
    additions: ['capability', 'evidence', 'operation', 'presentation'],
  },
  {
    name: 'video',
    additions: ['capability', 'evidence', 'operation', 'presentation'],
  },
  {
    name: 'CAD screenshot',
    additions: ['capability', 'evidence', 'operation'],
  },
  {
    name: 'GUI agent',
    additions: ['capability', 'evidence', 'operation', 'presentation'],
  },
  {
    name: '1+X structured-first/free-follow-up',
    additions: ['capability', 'evidence', 'operation'],
  },
])

const ALLOWED_EXTENSION_SURFACES = new Set([
  'capability',
  'evidence',
  'operation',
  'presentation',
])

const FORBIDDEN_NEW_INFRASTRUCTURE = Object.freeze([
  'settings-proxy',
  'ctx-wrapper',
  'global-registry',
  'session-cache',
  'host-patch',
  'lifecycle-exception',
])

test('final single-owner modules remain explicit extension boundaries', async () => {
  for (const [owner, path, marker] of OWNER_CONTRACTS) {
    const source = await text(path)
    assert.match(source, marker, `${owner} must remain explicit at ${path}`)
  }
})

test('future PDF/video/CAD/GUI/1+X tabletop stays inside capability-evidence-operation-presentation surfaces', () => {
  for (const scenario of TABLETOP_SCENARIOS) {
    assert.ok(scenario.additions.length > 0, `${scenario.name} must name its extension surfaces`)
    for (const addition of scenario.additions) {
      assert.equal(
        ALLOWED_EXTENSION_SURFACES.has(addition),
        true,
        `${scenario.name} requires unapproved architecture surface ${addition}`,
      )
      assert.equal(
        FORBIDDEN_NEW_INFRASTRUCTURE.includes(addition),
        false,
        `${scenario.name} must not require ${addition}`,
      )
    }
  }
})

test('production has no hidden current-owner locator and only the inventoried transport registry', async () => {
  const files = await sourceFiles(new URL('../lib/', import.meta.url))
  const currentOwners = []
  const installedRegistries = []
  const retiredSessionOwners = []

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const path = file.pathname.replace(/^.*\/lib\//, 'lib/')
    if (/^(?:export\s+)?(?:let|var)\s+current[A-Z][A-Za-z0-9_$]*\s*(?:=|;)/m.test(source)) {
      currentOwners.push(path)
    }
    if (/^const installed\s*=\s*\[\s*\]\s*$/m.test(source)) installedRegistries.push(path)
    if (/\bcurrentSessionVisionStateStore\b/.test(source)) retiredSessionOwners.push(path)
  }

  assert.deepEqual(currentOwners, [], 'module-global current* runtime owners must not return')
  assert.deepEqual(retiredSessionOwners, [], 'retired Session current-owner locator must stay absent')
  assert.deepEqual(
    installedRegistries,
    ['lib/vision-provider-transport.js'],
    'only the explicitly inventoried VisionProviderTransport compatibility registry is allowed',
  )

  const inventory = await text('docs/architecture/compat-inventory.md')
  const sectionStart = inventory.indexOf('## `lib/vision-provider-transport.js` process/profile registry')
  assert.ok(sectionStart >= 0, 'the one allowed runtime registry must be inventoried')
  const sectionEnd = inventory.indexOf('\n## ', sectionStart + 4)
  const section = inventory.slice(sectionStart, sectionEnd < 0 ? inventory.length : sectionEnd)
  assert.match(section, /\*\*Removal condition:\*\*/)
  assert.match(section, /currentVisionProviderTransport\(\)/)
})

test('Architecture Closure permanently carries every final ownership gate', async () => {
  const workflow = await text('.github/workflows/architecture-closure.yml')
  for (const gate of [
    'tests/architecture-contract-baseline.test.js',
    'tests/compat-inventory-completeness.test.js',
    'tests/settings-impersonation-closure.test.js',
    'tests/presentation-switch.test.js',
    'tests/capability-shadow-retirement.test.js',
    'tests/session-runtime-core-wiring.test.js',
    'tests/final-architecture-closure.test.js',
  ]) {
    assert.ok(workflow.includes(gate), `${gate} must remain in Architecture Closure`)
  }
})

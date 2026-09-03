import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const manifestPath = new URL('../package.json', import.meta.url)

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

async function discoverTests(directory = new URL('./', import.meta.url), prefix = 'tests') {
  const paths = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      paths.push(...await discoverTests(new URL(`${entry.name}/`, directory), relative))
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      paths.push(relative)
    }
  }
  return paths.sort()
}

// These historical contracts had no stable CI owner. Keep the package.json
// command untouched for this closure patch, but execute the tests from this
// already-default manifest file so `pnpm test` and the release workflow both
// cover them immediately. A future discovery-runner migration can move these
// back into ordinary automatic discovery without changing the contract below.
const DEFAULT_TEST_IMPORTS = Object.freeze([
  'tests/auto-wrap-model-removal.test.js',
  'tests/guard-stop-surface-shadow.test.js',
  'tests/settings-card-race-safety.test.js',
  'tests/settings-guide-replay-safety.test.js',
  'tests/settings-ia-targeted-adversarial.test.js',
  'tests/v2-release-acceptance-regressions.test.js',
  'tests/vision-turn-budget-client-prelude.test.js',
  'tests/wrapper-scope-client-prelude.test.js',
])

for (const path of DEFAULT_TEST_IMPORTS) {
  await import(new URL(`./${path.slice('tests/'.length)}`, import.meta.url))
}

// A test may stay outside the default `pnpm test` process only when a stable,
// PR-triggered workflow owns the exact file. The reasons are intentionally
// grouped by execution environment/domain instead of becoming a generic
// quarantine list.
const DEFAULT_TEST_EXCLUSIONS = Object.freeze([
  { path: 'tests/alpha1-client-host-compat.test.js', owner: '.github/workflows/dsh-alpha-source-contract.yml', reason: 'exact DSH alpha source compatibility matrix' },
  { path: 'tests/alpha1-settings-factory-lifecycle.test.js', owner: '.github/workflows/dsh-alpha-source-contract.yml', reason: 'exact DSH alpha source compatibility matrix' },
  { path: 'tests/alpha1-web-auth-boundary.test.js', owner: '.github/workflows/dsh-alpha-source-contract.yml', reason: 'exact DSH alpha source compatibility matrix' },
  { path: 'tests/browser-p1-acceptance.test.js', owner: '.github/workflows/browser-p1-acceptance.yml', reason: 'real Chromium acceptance requires a browser executable' },

  { path: 'tests/architecture-contract-baseline.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/capability-shadow-retirement.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/compat-inventory-completeness.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/core-vision-surface-parity.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/final-architecture-closure.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/presentation-convergence-parity.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/presentation-switch.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/session-runtime-core-wiring.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/session-vision-runtime-parity.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },
  { path: 'tests/settings-impersonation-closure.test.js', owner: '.github/workflows/architecture-closure.yml', reason: 'architecture closure contract matrix' },

  { path: 'tests/vision-execution-order-apply.test.js', owner: '.github/workflows/p1-routing-parity.yml', reason: 'always-on PR routing/authority parity matrix' },
  { path: 'tests/vision-execution-order-core-wiring.test.js', owner: '.github/workflows/p1-routing-parity.yml', reason: 'always-on PR routing/authority parity matrix' },
  { path: 'tests/vision-execution-order-plan-parity.test.js', owner: '.github/workflows/p1-routing-parity.yml', reason: 'always-on PR routing/authority parity matrix' },
  { path: 'tests/vision-execution-order.test.js', owner: '.github/workflows/p1-routing-parity.yml', reason: 'always-on PR routing/authority parity matrix' },
  { path: 'tests/vision-routing-evidence-parity.test.js', owner: '.github/workflows/p1-routing-parity.yml', reason: 'always-on PR routing/authority parity matrix' },
  { path: 'tests/vision-routing-runtime-parity.test.js', owner: '.github/workflows/p1-routing-parity.yml', reason: 'always-on PR routing/authority parity matrix' },

  { path: 'tests/legacy-global-proxy-boundary.test.js', owner: '.github/workflows/p2-data-boundary.yml', reason: 'provider/data-boundary Node 22/24 matrix' },
  { path: 'tests/p2-exit-gate.test.js', owner: '.github/workflows/p2-data-boundary.yml', reason: 'provider/data-boundary Node 22/24 matrix' },
  { path: 'tests/session-surface-policy.test.js', owner: '.github/workflows/p2-data-boundary.yml', reason: 'session/data-boundary Node 22/24 matrix' },
  { path: 'tests/session-vision-index.test.js', owner: '.github/workflows/p2-data-boundary.yml', reason: 'session/data-boundary Node 22/24 matrix' },
  { path: 'tests/vision-artifact-store.test.js', owner: '.github/workflows/p2-data-boundary.yml', reason: 'artifact/data-boundary Node 22/24 matrix' },
  { path: 'tests/vision-provider-transport.test.js', owner: '.github/workflows/p2-data-boundary.yml', reason: 'provider/data-boundary Node 22/24 matrix' },

  { path: 'tests/dsh-support-window.test.js', owner: '.github/workflows/p3-compat-convergence.yml', reason: 'compatibility convergence Node 22/24 matrix' },
  { path: 'tests/p3-entry-composition.test.js', owner: '.github/workflows/p3-compat-convergence.yml', reason: 'compatibility convergence Node 22/24 matrix' },
  { path: 'tests/p3-web-modularization.test.js', owner: '.github/workflows/p3-compat-convergence.yml', reason: 'compatibility convergence Node 22/24 matrix' },
])

test('host-provided DSH packages publish the active Host floor while retaining an installable legacy dev fixture', async () => {
  const pkg = await manifest()
  const hostPeers = [
    '@deepseek-ai/dsh-anonymous-user-id',
    '@deepseek-ai/dsh-llm-deepseek',
  ]

  for (const name of hostPeers) {
    assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a regular dependency`)
    const peer = pkg.peerDependencies?.[name]
    assert.equal(typeof peer, 'string', `${name} must be a peerDependency`)
    assert.match(peer, /\^0\.1\.0-rc\.8/, `${name} must publish the DVR 2.1 rc8 Host floor`)
    assert.match(peer, /\^0\.1\.1-rc\.1/, `${name} must admit the released DSH 0.1.1 train`)
    assert.equal(typeof pkg.devDependencies?.[name], 'string', `${name} must remain available for tests`)
    assert.match(pkg.devDependencies[name], /\^0\.1\.0-rc\.6/)
  }
})

test('host-provided peers are optional so profile installs never warn about missing peers', async () => {
  const pkg = await manifest()
  const optionalPeers = [
    '@deepseek-ai/dsh-anonymous-user-id',
    '@deepseek-ai/dsh-llm-deepseek',
    'sharp',
  ]
  for (const name of optionalPeers) {
    assert.equal(typeof pkg.peerDependencies?.[name], 'string', `${name} must remain a peerDependency`)
    assert.equal(
      pkg.peerDependenciesMeta?.[name]?.optional,
      true,
      `${name} must be marked optional in peerDependenciesMeta`,
    )
  }
})

test('schemastery remains a runtime dependency', async () => {
  const pkg = await manifest()
  assert.equal(typeof pkg.dependencies?.['@deepseek-ai/schemastery'], 'string')
  assert.equal(pkg.devDependencies?.['@deepseek-ai/schemastery'], undefined)
})

test('undici stays below v8 and is lazy-loaded for plugin proxy use', async () => {
  const pkg = await manifest()
  assert.match(pkg.dependencies?.undici ?? '', /^\^7\./)

  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /import\(['"]undici['"]\)/)
  assert.doesNotMatch(source, /^\s*import\s+.*from\s+['"]undici['"]/m)
})

test('default test manifest is closed-world: every test is run or explicitly owned elsewhere', async () => {
  const pkg = await manifest()
  const defaultScript = String(pkg.scripts?.test ?? '')
  const listed = new Set(defaultScript.match(/tests\/[A-Za-z0-9._/-]+\.test\.js/g) ?? [])
  const discovered = new Set(await discoverTests())
  const imported = new Set()
  const excluded = new Map()

  for (const path of DEFAULT_TEST_IMPORTS) {
    assert.equal(imported.has(path), false, `${path}: duplicate default import`)
    imported.add(path)
    assert.equal(discovered.has(path), true, `${path}: stale default import`)
    assert.equal(listed.has(path), false, `${path}: now listed directly; remove the compatibility import`)
  }

  for (const entry of DEFAULT_TEST_EXCLUSIONS) {
    assert.equal(typeof entry?.path, 'string', 'every default-test exclusion needs a path')
    assert.equal(typeof entry?.owner, 'string', `${entry?.path ?? '<unknown>'}: exclusion needs an owner`)
    assert.equal(typeof entry?.reason, 'string', `${entry?.path ?? '<unknown>'}: exclusion needs a reason`)
    assert.equal(excluded.has(entry.path), false, `${entry.path}: duplicate default-test exclusion`)
    assert.equal(imported.has(entry.path), false, `${entry.path}: cannot be both imported and excluded`)
    assert.equal(listed.has(entry.path), false, `${entry.path}: now listed directly; remove the workflow exclusion`)
    excluded.set(entry.path, entry)
    assert.equal(discovered.has(entry.path), true, `${entry.path}: stale default-test exclusion`)
  }

  const staleListed = [...listed].filter((path) => !discovered.has(path)).sort()
  assert.deepEqual(staleListed, [], `default test script references missing tests: ${staleListed.join(', ')}`)

  const missing = [...discovered]
    .filter((path) => !listed.has(path) && !imported.has(path) && !excluded.has(path))
    .sort()
  assert.deepEqual(
    missing,
    [],
    `tests can never silently escape CI; add them to scripts.test/default imports or document a stable CI owner: ${missing.join(', ')}`,
  )
})

test('all GitHub Actions dependencies are pinned to immutable commit SHAs', async () => {
  const workflowDir = new URL('../.github/workflows/', import.meta.url)
  const names = await readdir(workflowDir)
  for (const name of names.filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))) {
    const source = await readFile(new URL(name, workflowDir), 'utf8')
    const uses = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)].map((match) => match[1])
    for (const spec of uses) {
      if (spec.startsWith('./') || spec.startsWith('docker://')) continue
      const at = spec.lastIndexOf('@')
      assert.notEqual(at, -1, `${name}: action ${spec} must include an immutable ref`)
      const ref = spec.slice(at + 1)
      assert.match(ref, /^[0-9a-f]{40}$/i, `${name}: action ${spec} must be pinned to a 40-char commit SHA`)
    }
  }
})

test('large-image stress policy cannot regress to a one-off development branch gate', async () => {
  const workflow = await readFile(new URL('../.github/workflows/resource-stress.yml', import.meta.url), 'utf8')
  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /push:/)
  assert.match(workflow, /branches:\s*\[main\]/)
  assert.match(workflow, /workflow_dispatch:/)
})

test('Dependabot maintains pinned GitHub Actions references', async () => {
  const config = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')
  assert.match(config, /package-ecosystem:\s*"github-actions"/)
})

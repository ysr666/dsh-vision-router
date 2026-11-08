import { test } from 'node:test'
import assert from 'node:assert/strict'
import semver from 'semver'
import { execFileSync } from 'node:child_process'
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
  'tests/client-script-carrier.test.js',
  'tests/guard-stop-surface-shadow.test.js',
  'tests/settings-card-race-safety.test.js',
  'tests/settings-guide-replay-safety.test.js',
  'tests/settings-ia-targeted-adversarial.test.js',
  'tests/v2-release-acceptance-regressions.test.js',
  'tests/vision-turn-budget-client-prelude.test.js',
  'tests/vision-quality-round2-baseline.test.js',
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
  { path: 'tests/linux-desktop-screenshot-runtime.test.js', owner: '.github/workflows/adversarial-compat-hardening.yml', reason: 'real Linux X11 desktop capture requires Xvfb plus import/scrot' },

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

test('canonical repository source never tracks generated runtime artifacts', () => {
  const root = new URL('../', import.meta.url)
  const tracked = execFileSync(
    'git',
    ['ls-files', '--', 'entry.js', 'index.js', 'lib'],
    { cwd: root, encoding: 'utf8' },
  ).trim()

  assert.equal(
    tracked,
    '',
    'entry.js, index.js and lib/** are package build artifacts; canonical runtime source belongs under src/** only',
  )
})

test('3.2 Host engine and sole legacy peer gate retire conflicting transitive peers', async () => {
  const pkg = await manifest()
  const hostRange = '>=0.2.1-rc.5 <0.3.0-0'
  assert.equal(pkg.engines?.dsh, hostRange)
  for (const name of [
    '@deepseek-ai/dsh-anonymous-user-id',
    '@deepseek-ai/dsh-llm-deepseek',
    '@deepseek-ai/dsh-storage-domain',
  ]) {
    assert.equal(pkg.dependencies?.[name], undefined, name + ' must be Host-owned')
    if (name === '@deepseek-ai/dsh-llm-deepseek') {
      assert.equal(pkg.peerDependencies?.[name], hostRange,
        'legacy 0.2.0 Hosts only check DSH peers and must refuse 3.2')
      assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true)
    } else {
      assert.equal(pkg.peerDependencies?.[name], undefined,
        name + ' adds peer graph conflicts without providing legacy refusal protection')
      assert.equal(pkg.peerDependenciesMeta?.[name], undefined)
    }
    assert.equal(pkg.devDependencies?.[name], '0.2.1-rc.5')
  }
  assert.deepEqual(Object.keys(pkg.peerDependencies || {}).sort(), ['@deepseek-ai/dsh-llm-deepseek', 'sharp'])
})

test('a legacy peer-only Host still rejects the retired DSH generations', async () => {
  const pkg = await manifest()
  const peers = Object.entries(pkg.peerDependencies || {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  assert.deepEqual(peers, [['@deepseek-ai/dsh-llm-deepseek', pkg.engines.dsh]])
  // Immutable official 0.2.0-rc.2 Host comparator only checks DSH peers,
  // using semver.satisfies(version, range, { includePrerelease: true }).
  const guard = peers[0][1]
  for (const old of ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.4']) {
    assert.equal(semver.satisfies(old, guard, { includePrerelease: true }), false,
      old + ' must be rejected even by the old peer-only Host')
  }
  for (const supported of ['0.2.1-rc.5', '0.2.2-alpha.3', '0.2.2-rc.1']) {
    assert.equal(semver.satisfies(supported, guard, { includePrerelease: true }), true,
      supported + ' must be admitted when the legacy peer remains')
  }
})

test('client package graph does not revive the retired dsh-client-runtime row', async () => {
  const pkg = await manifest()
  const inject = Array.isArray(pkg.dsh?.client?.inject) ? pkg.dsh.client.inject : []
  const doctorRuntime = await readFile(new URL('../lib/doctor-runtime.js', import.meta.url), 'utf8')

  assert.equal(
    inject.includes('@deepseek-ai/dsh-client-runtime'),
    false,
    'DSH 0.2 client graph has no dsh-client-runtime package row',
  )
  assert.doesNotMatch(
    doctorRuntime,
    /@deepseek-ai\/dsh-client-runtime/,
    'Doctor must not diagnose a Host package that no longer exists',
  )
})

test('both remaining peers are optional; the DSH peer is a legacy refusal guard', async () => {
  const pkg = await manifest()
  assert.deepEqual(Object.keys(pkg.peerDependenciesMeta || {}).sort(), ['@deepseek-ai/dsh-llm-deepseek', 'sharp'])
  assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh-llm-deepseek'].optional, true)
  assert.equal(typeof pkg.peerDependencies.sharp, 'string')
  assert.equal(pkg.peerDependenciesMeta.sharp.optional, true)
})

test('development sharp is patched without raising the supported Host peer floor', async () => {
  const pkg = await manifest()
  const lock = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')

  assert.equal(pkg.peerDependencies?.sharp, '>=0.35.3 <1', 'rc8/stable/preview Host sharp 0.35.3 must remain installable')
  assert.equal(pkg.devDependencies?.sharp, '^0.35.4')
  assert.doesNotMatch(lock, /(?:^|\s)sharp@0\.35\.3(?=[:(])/m)
})

test('schemastery remains a runtime dependency', async () => {
  const pkg = await manifest()
  assert.equal(typeof pkg.dependencies?.['@deepseek-ai/schemastery'], 'string')
  assert.equal(pkg.devDependencies?.['@deepseek-ai/schemastery'], undefined)
})

test('public surfaces disclose remote image egress and strict local-only requirements', async () => {
  const pkg = await manifest()
  const [readme, readmeZh, settings, legacySettings] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh.md', import.meta.url), 'utf8'),
    readFile(new URL('../lib/settings-ia-client-prelude.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/client.js', import.meta.url), 'utf8'),
  ])

  assert.match(pkg.description, /Remote vision providers/)
  assert.match(pkg.description, /default free fallback/)
  assert.match(readme, /Data leaves your machine by default/)
  assert.match(readme, /strict local-only workflow/)
  assert.match(readmeZh, /默认配置会让数据出网/)
  assert.match(readmeZh, /严格纯本地/)
  assert.match(settings, /数据流向/)
  assert.match(settings, /remote OVHcloud service/)
  assert.match(settings, /Result text may still go to a cloud chat model/)
  assert.match(settings, /Results may still go to a cloud chat model/)
  assert.match(settings, /Vision result destination/)
  assert.match(legacySettings, /Derived result text/)
  assert.match(legacySettings, /严格纯本地还需同时选择本地聊天模型/)
})

test('undici stays below v8 and is lazy-loaded only by scoped proxy transports', async () => {
  const pkg = await manifest()
  assert.match(pkg.dependencies?.undici ?? '', /^\^7\./)

  const [core, providerTransport, legacyBoundary] = await Promise.all([
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/vision-provider-transport.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/legacy-global-proxy-boundary.js', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(core, /import\(['"]undici['"]\)/)
  assert.doesNotMatch(core, /new ProxyAgent\(/)
  assert.match(providerTransport, /import\(['"]undici['"]\)/)
  assert.match(legacyBoundary, /import\(['"]undici['"]\)/)
  for (const source of [core, providerTransport, legacyBoundary]) {
    assert.doesNotMatch(source, /^\s*import\s+.*from\s+['"]undici['"]/m)
  }
})

test('default test manifest is closed-world: every test is run or explicitly owned elsewhere', async () => {
  const pkg = await manifest()
  const defaultScript = String(pkg.scripts?.test ?? '')
  const listedPaths = defaultScript.match(/tests\/[A-Za-z0-9._/-]+\.test\.js/g) ?? []
  const listed = new Set(listedPaths)
  const discovered = new Set(await discoverTests())
  const imported = new Set()
  const excluded = new Map()
  const workflowSources = new Map()

  const duplicateListed = [...new Set(listedPaths.filter((path, index) => listedPaths.indexOf(path) !== index))].sort()
  assert.deepEqual(duplicateListed, [], `default test script lists tests more than once: ${duplicateListed.join(', ')}`)

  for (const path of DEFAULT_TEST_IMPORTS) {
    assert.equal(imported.has(path), false, `${path}: duplicate default import`)
    imported.add(path)
    assert.equal(discovered.has(path), true, `${path}: stale default import`)
    assert.equal(listed.has(path), false, `${path}: now listed directly; remove the compatibility import`)
  }

  for (const entry of DEFAULT_TEST_EXCLUSIONS) {
    assert.equal(typeof entry?.path, 'string', 'every default-test exclusion needs a path')
    assert.match(entry.path, /^tests\/.+\.test\.js$/, `${entry.path}: exclusion path must be a test file`)
    assert.equal(typeof entry?.owner, 'string', `${entry.path}: exclusion needs an owner`)
    assert.match(entry.owner, /^\.github\/workflows\/.+\.ya?ml$/, `${entry.path}: owner must be a workflow file`)
    assert.equal(typeof entry?.reason, 'string', `${entry.path}: exclusion needs a reason`)
    assert.ok(entry.reason.trim().length > 0, `${entry.path}: exclusion reason must not be blank`)
    assert.equal(excluded.has(entry.path), false, `${entry.path}: duplicate default-test exclusion`)
    assert.equal(imported.has(entry.path), false, `${entry.path}: cannot be both imported and excluded`)
    assert.equal(listed.has(entry.path), false, `${entry.path}: now listed directly; remove the workflow exclusion`)
    excluded.set(entry.path, entry)
    assert.equal(discovered.has(entry.path), true, `${entry.path}: stale default-test exclusion`)

    let workflow = workflowSources.get(entry.owner)
    if (workflow === undefined) {
      workflow = await readFile(new URL(`../${entry.owner}`, import.meta.url), 'utf8')
      workflowSources.set(entry.owner, workflow)
      assert.match(workflow, /^\s{0,2}pull_request\s*:/m, `${entry.owner}: specialist owner must run on pull requests`)
      assert.notEqual(workflow.indexOf('node --test'), -1, `${entry.owner}: specialist owner must execute Node tests`)
    }
    const commandStart = workflow.indexOf('node --test')
    assert.ok(
      workflow.lastIndexOf(entry.path) > commandStart,
      `${entry.path}: ${entry.owner} does not execute the claimed test`,
    )
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

test('alpha source contract follows the presentation implementation on PRs and main pushes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/dsh-alpha-source-contract.yml', import.meta.url), 'utf8')
  const pullStart = workflow.indexOf('  pull_request:')
  const pushStart = workflow.indexOf('  push:')
  const dispatchStart = workflow.indexOf('  workflow_dispatch:')
  assert.ok(pullStart !== -1 && pushStart > pullStart && dispatchStart > pushStart, 'alpha source workflow trigger sections must stay explicit')

  const implementationPath = "- 'lib/client-presentation-boundary-main.js'"
  const pullTrigger = workflow.slice(pullStart, pushStart)
  const pushTrigger = workflow.slice(pushStart, dispatchStart)
  assert.match(pullTrigger, /lib\/client-presentation-boundary-main\.js/, `${implementationPath} must trigger exact-alpha PR contracts`)
  assert.match(pushTrigger, /lib\/client-presentation-boundary-main\.js/, `${implementationPath} must trigger exact-alpha main-push contracts`)
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

test('workflow action sources stay within the repository execution allow-list', async () => {
  const workflowDir = new URL('../.github/workflows/', import.meta.url)
  const names = await readdir(workflowDir)
  const allowedThirdParty = new Set([
    'hashgraph-online/ai-plugin-scanner-action',
    'ossf/scorecard-action',
    'pnpm/action-setup',
  ])

  for (const name of names.filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))) {
    const source = await readFile(new URL(name, workflowDir), 'utf8')
    const uses = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)].map((match) => match[1])
    for (const spec of uses) {
      if (spec.startsWith('./') || spec.startsWith('docker://')) continue
      const actionPath = spec.slice(0, spec.lastIndexOf('@'))
      const [owner, repo] = actionPath.split('/')
      const repository = `${owner}/${repo}`
      const allowed = owner === 'actions' || owner === 'github' || allowedThirdParty.has(repository)
      assert.equal(allowed, true, `${name}: action source ${repository} is not allowed by the repository Actions policy`)
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


test('3.2 new DSH Host fixture avoids the vulnerable transitive zod 4.4.3', async () => {
  const [workspace, lock] = await Promise.all([
    readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
  ])
  assert.match(workspace, /^  zod: 4\.6\.7$/m)
  assert.match(lock, /zod@4\.6\.7:/)
  assert.doesNotMatch(lock, /zod@4\.4\.3|zod: 4\.4\.3/,
    'do not reintroduce vulnerable GHSA-mrhx-c7xc-m3w5 via dev DSH Host fixtures')
})

test('floating Alpha Host CI cannot restore or seed a shared build cache', async () => {
  const gate = await readFile(new URL('../.github/workflows/dsh-alpha-settings-host-gate.yml', import.meta.url), 'utf8')
  assert.match(gate, /schedule:/)
  assert.match(gate, /workflow_dispatch:/)
  assert.match(gate, /ref: 05b1cae8db6e674c5685101494d4eec24652424a/)
  assert.doesNotMatch(gate, /ref: \$\{\{ steps\.pin\.outputs\.sha \}\}/)
  assert.equal(gate.split('Reject an Alpha pin change without a reviewed immutable checkout update').length - 1, 3)
  assert.doesNotMatch(gate, /actions\/cache\/(?:restore|save)@|dsh-build-cache|dsh-cache-key/)
  assert.doesNotMatch(gate, /^\s*cache:\s*pnpm/m)
  assert.match(gate, /- name: Build exact macOS Desktop runtime/)
  assert.match(gate, /- name: Build the alpha Host runtime/)
  assert.match(gate, /- name: Build exact Desktop runtime/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const manifestPath = new URL('../package.json', import.meta.url)

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

test('host-provided DSH packages are peers while development stays on an installable released line', async () => {
  const pkg = await manifest()
  const hostPeers = [
    '@deepseek-ai/dsh-anonymous-user-id',
    '@deepseek-ai/dsh-llm-deepseek',
  ]

  for (const name of hostPeers) {
    assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a regular dependency`)
    const peer = pkg.peerDependencies?.[name]
    assert.equal(typeof peer, 'string', `${name} must be a peerDependency`)
    assert.match(peer, /\^0\.1\.0-rc\.6/, `${name} must keep the supported 0.1.0 prerelease line`)
    assert.match(peer, /\^0\.1\.1-rc\.1/, `${name} must admit the DSH 0.1.1-rc.1 contract`)
    // 0.1.1-rc.1 can land in the source/tag before every npm package is
    // published. Keep CI's development fixture on an actually installable
    // 0.1.0 prerelease until the full rc.1 package set exists; the optional
    // peer is the compatibility declaration consumed by a real Host.
    assert.equal(typeof pkg.devDependencies?.[name], 'string', `${name} must remain available for tests`)
    assert.match(pkg.devDependencies[name], /\^0\.1\.0-rc\.6/)
  }
})

test('host-provided peers are optional so profile installs never warn about missing peers', async () => {
  const pkg = await manifest()
  // The two DSH packages are resolved by the host's own module graph, and
  // sharp falls back to the host instance — pnpm at the profile level cannot
  // see any of them, so a mandatory peer would print "Issues with peer
  // dependencies found" on every user install. Optional peers keep the
  // prefer-host semantics without the warning.
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
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/schemastery'], undefined)
  assert.ok(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-connection'))
  assert.ok(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-api-remotes'))
})


test('undici stays below v8 and is lazy-loaded for plugin proxy use', async () => {
  const pkg = await manifest()
  assert.equal(pkg.dependencies?.undici, '^7.29.0')

  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s+.*from\s+['"]undici['"]/m)
  assert.match(source, /import\(['"]undici['"]\)/)
})

test('all GitHub Actions dependencies are pinned to immutable commit SHAs', async () => {
  const workflowsDir = new URL('../.github/workflows/', import.meta.url)
  const workflows = (await readdir(workflowsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  assert.ok(workflows.length > 0, 'repository must contain at least one GitHub Actions workflow')

  let actionRefCount = 0
  for (const name of workflows) {
    const source = await readFile(new URL(name, workflowsDir), 'utf8')
    // YAML steps may spell this either as `- uses: ...` or as `- name: ...`
    // followed by an indented `uses: ...`. Match the capability line itself,
    // not one particular presentation shape. Local actions do not carry an
    // external ref and are intentionally ignored by this dependency check.
    const refs = [...source.matchAll(/^\s*(?:-\s*)?uses:\s+[^@\s]+@([^\s#]+)/gm)].map((match) => match[1])
    actionRefCount += refs.length
    for (const ref of refs) {
      assert.match(ref, /^[a-f0-9]{40}$/i, `${name} contains mutable action ref ${ref}`)
    }
  }

  assert.ok(actionRefCount > 0, 'workflow scan must find at least one external action reference')
})

test('large-image stress policy cannot regress to a one-off development branch gate', async () => {
  const source = await readFile(new URL('../.github/workflows/resource-stress.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /github\.head_ref/)
  assert.doesNotMatch(source, /issue-208-resource-governor/)
  assert.match(source, /pull_request:/)
  assert.match(source, /push:/)
  assert.match(source, /schedule:/)
  assert.match(source, /scripts\/image-resource-stress\.mjs/)
  assert.match(source, /STRESS_IMAGE_WIDTH:\s*'10000'/)
})

test('Dependabot maintains pinned GitHub Actions references', async () => {
  const source = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')
  assert.match(source, /package-ecosystem:\s*github-actions/)
  assert.match(source, /interval:\s*weekly/)
})
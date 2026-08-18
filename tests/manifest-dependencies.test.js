import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifestPath = new URL('../package.json', import.meta.url)

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

test('host-provided DSH packages are peers and mirrored for development', async () => {
  const pkg = await manifest()
  const hostPeers = [
    '@deepseek-ai/dsh-anonymous-user-id',
    '@deepseek-ai/dsh-llm-deepseek',
  ]

  for (const name of hostPeers) {
    assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a regular dependency`)
    assert.equal(typeof pkg.peerDependencies?.[name], 'string', `${name} must be a peerDependency`)
    assert.equal(
      pkg.devDependencies?.[name],
      pkg.peerDependencies?.[name],
      `${name} devDependency must mirror the peer range`,
    )
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
  const workflows = ['ci.yml', 'release.yml', 'resource-stress.yml', 'star-history.yml']
  for (const name of workflows) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    const refs = [...source.matchAll(/^\s*-\s+uses:\s+[^@\s]+@([^\s#]+)/gm)].map((match) => match[1])
    assert.ok(refs.length > 0, `${name} must contain at least one external action`)
    for (const ref of refs) {
      assert.match(ref, /^[a-f0-9]{40}$/i, `${name} contains mutable action ref ${ref}`)
    }
  }
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

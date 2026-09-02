import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const manifestPath = new URL('../package.json', import.meta.url)

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

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
    // Keep one explicit rc.6 development fixture as a best-effort historical
    // compatibility fence. It is not the public DVR 2.1 support floor; the
    // optional peer declaration above is what profile installs consume.
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
  assert.equal(pkg.devDependencies?.['@deepseek-ai/schemastery'], undefined)
})

test('undici stays below v8 and is lazy-loaded for plugin proxy use', async () => {
  const pkg = await manifest()
  assert.match(pkg.dependencies?.undici ?? '', /^\^7\./)
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /await import\(['"]undici['"]\)/)
  assert.doesNotMatch(source, /^import .* from ['"]undici['"]/m)
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

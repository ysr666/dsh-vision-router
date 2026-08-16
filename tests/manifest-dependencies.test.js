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

test('schemastery remains a runtime dependency', async () => {
  const pkg = await manifest()
  assert.equal(typeof pkg.dependencies?.['@deepseek-ai/schemastery'], 'string')
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/schemastery'], undefined)
})

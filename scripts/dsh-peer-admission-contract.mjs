import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = resolve(process.env.DSH_SOURCE_ROOT || '')
const dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')
if (!process.env.DVR_SOURCE_ROOT) throw new Error('DVR_SOURCE_ROOT is required')

const manifest = JSON.parse(await readFile(join(dvrRoot, 'package.json'), 'utf8'))
const compatibilityModule = pathToFileURL(join(
  dshRoot,
  'packages/boot/app-boot/src/plugin-compatibility.ts',
)).href
const { evaluatePluginCompatibility } = await import(compatibilityModule)

const declaredDshPeers = Object.keys(manifest.peerDependencies ?? {})
  .filter((name) => name.startsWith('@deepseek-ai/dsh-'))
  .sort()

assert.ok(
  declaredDshPeers.length > 0,
  'DVR manifest must declare at least one DSH Host peer for train admission',
)

const admitted = [
  // DVR 2.3 supports the 0.1.x line continuously from the first 0.1.5
  // release candidate; later 0.1.x releases are not enumerated exceptions.
  '0.1.5-rc.1',
  '0.1.5-rc.3',
  '0.1.6-alpha.1',
  '0.1.7-rc.2',
  '0.1.99',
  // The 0.2.x train is admitted from the exact rc.2 boundary that DVR
  // validates across source, browser, and Desktop contracts.
  '0.2.0-rc.2',
  '0.2.0',
  '0.2.1-alpha.1',
  '0.2.1-rc.1',
  '0.2.1',
  '0.2.99-rc.1',
  '0.2.99',
]
for (const runtimeVersion of admitted) {
  assert.equal(
    evaluatePluginCompatibility(manifest, {}, runtimeVersion),
    undefined,
    `DVR manifest must be admitted by DSH ${runtimeVersion}`,
  )
}

const rejected = [
  '0.1.4',
  '0.1.5-beta.1',
  '0.2.0-beta.1',
  '0.2.0-rc.0',
  '0.2.0-rc.1',
  '0.3.0-alpha.1',
  '0.3.0-beta.1',
  '0.3.0-rc.1',
  '0.3.0',
  '1.0.0',
]
for (const runtimeVersion of rejected) {
  const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion)
  assert.ok(issue, `DVR manifest must not pre-admit DSH ${runtimeVersion}`)
  assert.deepEqual(
    Object.keys(issue.peers).sort(),
    declaredDshPeers,
    `DSH ${runtimeVersion} refusal must be caused only by DVR's declared DSH peers`,
  )
}

console.log(JSON.stringify({
  ok: true,
  admitted,
  rejected,
  declaredDshPeers,
}))

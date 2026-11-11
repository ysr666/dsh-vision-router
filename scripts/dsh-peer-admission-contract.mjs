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

// Supported DSH 0.2.1-rc.5+ evaluates engines.dsh as the sole
// compatibility authority. Two redundant DSH peers were dropped after an actual
// pnpm strict-peer conflict. One minimal peer remains because retired DSH
// 0.2.0 ignores engines.dsh; this refusal guard must not
// regress without a deliberate new compatibility decision.
const declaredDshPeers = Object.keys(manifest.peerDependencies ?? {})
  .filter((name) => name.startsWith('@deepseek-ai/dsh-'))
  .sort()
assert.deepEqual(declaredDshPeers, ['@deepseek-ai/dsh-llm-deepseek'],
  'one legacy peer must reject retired DSH 0.2.0 Hosts which ignore engines.dsh')
assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(),
  ['@deepseek-ai/dsh-llm-deepseek', 'sharp'],
  'retain exactly one DSH legacy refusal guard and one optional sharp peer')

const declaredDshRange = manifest.engines?.dsh
assert.equal(declaredDshRange, '>=0.2.1-rc.5 <0.3.0-0',
  'engines.dsh is now the canonical DSH 3.2 admission window')

assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-llm-deepseek'], declaredDshRange,
  'legacy DSH peer refusal guard must match the new canonical minimum')
assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-llm-deepseek']?.optional, true,
  'legacy refusal guard must not pull an unnecessary runtime package')

const admitted = [
  '0.2.1-rc.5',
  '0.2.1',
  '0.2.2-alpha.3',
  '0.2.2-rc.1',
  '0.2.2-rc.2',
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
  '0.1.5-rc.1', '0.1.5-rc.3', '0.1.7-rc.2',
  '0.2.0-rc.2', '0.2.0',
  '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.4',
  '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', '1.0.0',
]
for (const runtimeVersion of rejected) {
  const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion)
  assert.ok(issue, 'DSH ' + runtimeVersion + ' must be rejected')
  assert.deepEqual(issue.requirements,
    { 'engines.dsh': declaredDshRange },
    'DSH ' + runtimeVersion + ': only engines.dsh may refuse on supported Hosts')
}

// Engine precedence is explicit: even a fabricated incompatible peer must
// not alter admission on the exact rc5, rc1 or supported alpha Host.
const conflictingPeerManifest = {
  ...manifest,
  peerDependencies: {
    ...manifest.peerDependencies,
    '@deepseek-ai/dsh-anonymous-user-id': '<0.1.0',
  },
}
for (const version of ['0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-alpha.3']) {
  assert.equal(evaluatePluginCompatibility(conflictingPeerManifest, {}, version), undefined,
    'supported Host ' + version + ' must prefer engines.dsh over synthetic peers')
  const badEngineManifest = {
    ...conflictingPeerManifest,
    engines: { ...manifest.engines, dsh: '<0.1.0' },
  }
  const issue = evaluatePluginCompatibility(badEngineManifest, {}, version)
  assert.deepEqual(issue?.requirements, { 'engines.dsh': '<0.1.0' },
    'supported Host ' + version + ' must reject conflicting engines.dsh')
}

console.log(JSON.stringify({
  ok: true,
  admitted,
  rejected,
  declaredDshPeers,
}))

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

const admitted = [
  '0.1.7-rc.2',
  // DSH evaluates peer ranges with includePrerelease=true. The lower-bound
  // bridge >=0.2.0-rc.1 <0.2.0 admits the published 0.2.0 release candidates
  // before the final release; the retained ^0.2.0 range owns the stable 0.2
  // train and DSH's existing later-0.2 prerelease semantics. 0.3 stays excluded.
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.0',
  '0.2.1-rc.1',
  '0.2.1',
  '0.2.99',
]
for (const runtimeVersion of admitted) {
  assert.equal(
    evaluatePluginCompatibility(manifest, {}, runtimeVersion),
    undefined,
    `DVR manifest must be admitted by DSH ${runtimeVersion}`,
  )
}

for (const runtimeVersion of ['0.2.0-beta.1', '0.2.0-rc.0', '0.3.0-rc.1', '0.3.0', '1.0.0']) {
  const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion)
  assert.ok(issue, `DVR manifest must not pre-admit DSH ${runtimeVersion}`)
  assert.deepEqual(
    Object.keys(issue.peers).sort(),
    ['@deepseek-ai/dsh-anonymous-user-id', '@deepseek-ai/dsh-llm-deepseek'],
    `DSH ${runtimeVersion} refusal must be caused only by DVR's declared DSH peers`,
  )
}

console.log(JSON.stringify({
  ok: true,
  admitted,
  rejected: ['0.2.0-beta.1', '0.2.0-rc.0', '0.3.0-rc.1', '0.3.0', '1.0.0'],
}))

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
  '0.2.0',
  '0.2.1',
  '0.2.99',
  // DSH deliberately evaluates peer ranges with includePrerelease=true.
  // Declaring the whole 0.2.x family therefore also admits its prereleases.
  '0.2.1-rc.1',
]
for (const runtimeVersion of admitted) {
  assert.equal(
    evaluatePluginCompatibility(manifest, {}, runtimeVersion),
    undefined,
    `DVR manifest must be admitted by DSH ${runtimeVersion}`,
  )
}

for (const runtimeVersion of ['0.3.0-rc.1', '0.3.0', '1.0.0']) {
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
  rejected: ['0.3.0-rc.1', '0.3.0', '1.0.0'],
}))

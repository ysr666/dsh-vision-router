import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

async function packageJson() {
  return JSON.parse(await text('package.json'))
}

test('package root and runtime support contract stay stable during architecture closure', async () => {
  const pkg = await packageJson()
  assert.equal(pkg.name, 'dsh-vision-router')
  assert.equal(pkg.main, 'lib/public-entry.js')
  assert.equal(pkg.exports?.['.'], './lib/public-entry.js')
  assert.equal(pkg.exports?.['./client'], './lib/client.js')
  assert.equal(pkg.exports?.['./package.json'], './package.json')
  assert.equal(pkg.exports?.['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.engines?.node, '^22.19.0 || >=24.0.0')
})

test('public entry remains schema/export only and delegates runtime composition once', async () => {
  const source = await text('entry.js')
  const publicConfig = await text('lib/public-config.js')
  assert.match(source, /import \{ applyVisionRuntimeComposition \} from '\.\/lib\/runtime-composition\.js'/)
  assert.match(source, /composePublicVisionConfig/)
  assert.match(source, /export \{ SETTINGS_CONTRACT_REVISION \}/)
  assert.match(publicConfig, /export const SETTINGS_CONTRACT_REVISION = 7/)
  assert.match(source, /export const Config = composePublicVisionConfig\(core\.Config\)/)
  assert.doesNotMatch(source, /Config\.set\(/)
  assert.match(
    source,
    /export function apply\(ctx, config = \{\}, runtime = \{\}\) \{\s*return applyVisionRuntimeComposition\(ctx, config, core, runtime\)\s*\}/,
  )
  assert.equal(
    (source.match(/applyVisionRuntimeComposition\(ctx, config, core, runtime\)/g) ?? []).length,
    1,
    'public entry must have exactly one production composition call',
  )
})

test('2.0.x routing and background-authority defaults stay unchanged', async () => {
  const publicConfig = await text('lib/public-config.js')
  assert.match(publicConfig, /coreConfig\.set\('routingMode', z\.union\(\['ordered', 'auto'\]\)\.default\('ordered'\)\)/)
  assert.match(
    publicConfig,
    /z\.union\(\['balanced', 'quality', 'speed', 'local'\]\)\.default\('balanced'\)/,
  )
  assert.match(
    publicConfig,
    /z\.union\(\['local-free', 'all', 'off'\]\)\.default\('off'\)/,
  )
  assert.match(publicConfig, /coreConfig\.set\('allowRemoteSettings', z\.boolean\(\)\.default\(false\)\)/)
})

test('legacy route identity and default provider chain remain compatible', async () => {
  const core = await text('index.js')
  assert.match(core, /export const name = 'vision-router'/)
  assert.match(core, /provider: z\.string\(\)\.default\('vision-http'\)/)
  assert.match(core, /model: z\.string\(\)\.default\('ovh\/Qwen3\.5-397B-A17B'\)/)
  assert.match(core, /wrapperRoute: z\.string\(\)\.default\('deepseek-vision'\)/)
  assert.match(core, /chainRoute: z\.string\(\)\.default\('vision-chain'\)/)
  assert.match(core, /routing: z\.boolean\(\)\.default\(false\)/)
})

test('closure preserves direct Planner-to-ExecutionOrder core consumption', async () => {
  const core = await text('index.js')
  assert.match(
    core,
    /return applyVisionExecutionOrder\(base, currentVisionExecutionOrder\(\)\)/,
    'whole-turn routing must consume the scoped execution order after building its eligible base',
  )
  assert.match(
    core,
    /return applyVisionExecutionOrder\(out, currentVisionExecutionOrder\(\)\)/,
    'tool routing must consume the scoped execution order after capability filtering',
  )
})

test('published support-window docs remain the authority for compatibility retirement', async () => {
  const [support, retirement] = await Promise.all([
    text('docs/architecture/dsh-support-window.md'),
    text('docs/architecture/p3-compat-retirement.md'),
  ])
  assert.match(support, /2\.0\.x/)
  assert.match(support, /0\.1\.0-rc\.6/)
  assert.match(support, /\| `2\.2\.x` \| `0\.1\.0-rc\.8`/)
  assert.match(
    support,
    /\| `2\.3\.x` \| \*\*DSH `0\.1\.5` train\*\* \| `0\.1\.5-rc\.3` \| \*\*exact `0\.2\.0-rc\.2`\*\* \|/,
  )
  assert.match(support, /Exact supported 0\.2\.x boundary[^\n]*0\.2\.0-rc\.2/)
  assert.match(support, /Next\/rc drift canary[^\n]*dist-tag `next`/)
  assert.match(support, /Alpha\/pre-release drift canary[^\n]*dist-tag `alpha`/)
  assert.match(support, /peer-admitted supported 0\.2\.x train/i)
  assert.match(support, /Historical release notes[^\n]*not rewritten/i)
  assert.match(retirement, /NO COMPAT DELETION IS CURRENTLY AUTHORIZED/)
})


async function productionRuntimeFiles() {
  const files = ['entry.js', 'index.js']

  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, directory), relative)
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(relative)
      }
    }
  }

  await walk(new URL('../lib/', import.meta.url), 'lib')
  return files
}

test('3.0 R0 records the current transitive package-root export topology', async () => {
  const [publicEntry, entry, core] = await Promise.all([
    text('lib/public-entry.js'),
    text('entry.js'),
    text('index.js'),
  ])
  assert.match(publicEntry, /export \* from '\.\.\/entry\.js'/)
  assert.match(entry, /export \* from '\.\/index\.js'/)
  assert.match(core, /export \* from '\.\/lib\/vision-resilience\.js'/)
})

test('production runtime never depends on DSH private source entry points', async () => {
  const forbidden = [
    /@deepseek-ai\/[^'"\s]+\/src\//,
    /deepseek-harness\/packages\/[^'"\s]+\/src\//,
  ]
  for (const path of await productionRuntimeFiles()) {
    const source = await text(path)
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        source,
        pattern,
        `${path} must depend on package-exported DSH contracts, not private source paths`,
      )
    }
  }
})

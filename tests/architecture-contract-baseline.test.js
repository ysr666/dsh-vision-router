import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
  assert.match(source, /import \{ applyVisionRuntimeComposition \} from '\.\/lib\/runtime-composition\.js'/)
  assert.match(source, /export const SETTINGS_CONTRACT_REVISION = 7/)
  assert.match(source, /export const Config = core\.Config/)
  assert.match(
    source,
    /export function apply\(ctx, config = \{\}\) \{\s*return applyVisionRuntimeComposition\(ctx, config, core\)\s*\}/,
  )
  assert.equal(
    (source.match(/applyVisionRuntimeComposition\(ctx, config, core\)/g) ?? []).length,
    1,
    'public entry must have exactly one production composition call',
  )
})

test('2.0.x routing and background-authority defaults stay unchanged', async () => {
  const entry = await text('entry.js')
  assert.match(entry, /core\.Config\.set\('routingMode', z\.union\(\['ordered', 'auto'\]\)\.default\('ordered'\)\)/)
  assert.match(
    entry,
    /z\.union\(\['balanced', 'quality', 'speed', 'local'\]\)\.default\('balanced'\)/,
  )
  assert.match(
    entry,
    /z\.union\(\['local-free', 'all', 'off'\]\)\.default\('off'\)/,
  )
  assert.match(entry, /core\.Config\.set\('allowRemoteSettings', z\.boolean\(\)\.default\(false\)\)/)
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
  assert.match(support, /0\.1\.0-rc\.8/)
  assert.match(support, /0\.1\.1-rc\.2/)
  assert.match(retirement, /NO COMPAT DELETION IS CURRENTLY AUTHORIZED/)
})

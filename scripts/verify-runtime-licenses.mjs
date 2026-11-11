import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
const pkg = JSON.parse(read('package.json'))
const VTRACER = '1.0.0-alpha.4'
const EXPECTED_WASM_SHA256 = '63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45'
const EXPECTED_NPM_INTEGRITY = 'sha512-Hhi+vfG4ealLH1m9alrWo1lM00cWFfur4zeLEcNtzrYUjeEYTgukLNfvOXmuaGe2adugu+jl9o9IUzqHuqFO9g=='
const ALLOWED_SPDX_TOKENS = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'Unlicense', 'Zlib', '0BSD', 'Unicode-3.0', 'OR', 'AND',
])
function assertPermissive(expression, name) {
  assert.ok(typeof expression === 'string' && expression.length > 0, 'no license for ' + name)
  const tokens = expression.match(/0BSD|[A-Za-z][A-Za-z0-9.-]*/g) ?? []
  assert.ok(tokens.length > 0, 'invalid SPDX expression for ' + name)
  for (const token of tokens) {
    assert.ok(ALLOWED_SPDX_TOKENS.has(token), 'unapproved license token ' + token + ' in ' + name)
  }
}
assert.equal(pkg.dependencies?.['@visioncortex/vtracer'], VTRACER)
assert.equal(pkg.dependencies?.potrace, undefined)
const lock = read('pnpm-lock.yaml')
for (const forbidden of ['potrace@', 'jimp@', '@jimp/core@', 'global@4.4.0']) {
  assert.equal(lock.includes(forbidden), false, 'forbidden legacy dependency ' + forbidden)
}
assert.ok(lock.includes(EXPECTED_NPM_INTEGRITY), 'npm VTracer integrity must stay pinned')
const installed = require('@visioncortex/vtracer/package.json')
assert.equal(installed.version, VTRACER)
assert.equal(installed.license, 'MIT OR Apache-2.0')
const wasm = path.join(path.dirname(require.resolve('@visioncortex/vtracer/package.json')), 'pkg/vtracer_wasm_bg.wasm')
assert.ok(existsSync(wasm) && statSync(wasm).size > 100_000)
assert.equal(createHash('sha256').update(readFileSync(wasm)).digest('hex'), EXPECTED_WASM_SHA256)
const inventory = JSON.parse(read('docs/compliance/vtracer-alpha4-rust-inventory.json'))
assert.equal(inventory.tag, '2500df76b5aea0ac22d15296b22722442f825c5b')
assert.equal(inventory.packages.length, 66, 'review changed Rust dependency closure')
for (const item of inventory.packages) assertPermissive(item.license, item.name)
for (const notice of [
  'THIRD_PARTY_NOTICES.md',
  'assets/licenses/vtracer-MIT.txt',
  'assets/licenses/apache-2.0.txt',
  'assets/licenses/unicode-ident-Unicode-3.0.txt',
  'assets/licenses/roots-BSD-2-Clause.txt',
  'assets/licenses/moxcms-BSD-3-Clause.txt',
  'assets/licenses/zlib-rs-Zlib.txt',
]) assert.ok(existsSync(path.join(ROOT, notice)) && statSync(path.join(ROOT, notice)).size > 400, 'notice missing: ' + notice)
const scan = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  shell: process.platform === 'win32',
  windowsHide: true,
})
assert.equal(scan.status, 0, 'pnpm license listing failed: ' + scan.stderr)
const grouped = JSON.parse(scan.stdout)
let npmCount = 0
for (const [group, items] of Object.entries(grouped)) {
  assertPermissive(group, 'npm license group')
  for (const item of items) {
    assertPermissive(item.license || group, item.name)
    npmCount++
  }
}
assert.ok(npmCount >= 20, 'unexpectedly incomplete npm license scan')
console.log('LICENSE_GATE_OK npm_packages=' + npmCount +
  ' rust_resolved_nodes=' + inventory.packages.length +
  ' wasm_sha256=' + EXPECTED_WASM_SHA256)

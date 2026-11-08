// Optional-peer load-time contract (issue #719 class).
//
// Historical incident: the generated activation path shipped two **static** imports of
// packages package.json declares as optional peers
// (peerDependenciesMeta.*.optional === true). Nothing used the bindings, but Node
// resolves every static import before executing the module, so a profile that had not
// installed the optional peers could not load the activation path at all: the plugin
// never activated and the Host refused to start (#719).
//
// Two layers, because either one alone has a hole:
//
//   1. a static scan of the canonical source tree and of the generated runtime tree -
//      fast, localises the offender, and also covers lazily-reachable modules that the
//      load probe below never executes;
//   2. a real load probe - a child process in which every optional peer is made
//      unresolvable (tests/fixtures/block-optional-peers.mjs), importing the packaged
//      activation entries. This is the check that actually reproduces #719; the probe
//      ships its own negative control so it cannot silently stop blocking.
//
// Type-only imports are erased by the compiler and are deliberately not flagged;
// whether the erasure really happened is decided by the generated-tree scan (with
// verbatimModuleSyntax a type-only import can survive as a bare import{} from 'x',
// which is still a load-time edge).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SOURCE_ROOT = new URL('../src/', import.meta.url)
const RUNTIME_ROOT = new URL('../lib/', import.meta.url)
const PROBE = fileURLToPath(new URL('./fixtures/activation-load-probe.mjs', import.meta.url))
const PROBE_CONTROL = fileURLToPath(new URL('./fixtures/static-optional-peer-import.fixture.mjs', import.meta.url))
const ACTIVATION_ENTRIES = ['../lib/public-entry.js', '../index.js']
const MANIFEST = new URL('../package.json', import.meta.url)
const SOURCE_FILE = /\.(?:m?[jt]sx?)$/

async function filesUnder(directory) {
  const out = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) out.push(...await filesUnder(absolute))
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) out.push(absolute)
  }
  return out
}

/** Comments are not code: a commented-out import must not be flagged. */
const stripBlockComments = (source) => source.replace(/\*[\s\S]*?\*\//g, ' ')

/** An all-type specifier list is erased by the compiler. */
const isTypeOnlyClause = (clause) => {
  const text = clause.trim()
  if (/^type\b/.test(text)) return true
  if (!/^\{[\s\S]*\}$/.test(text)) return false
  const names = text.slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean)
  return names.length > 0 && names.every((name) => /^type\s+[^,]+$/.test(name))
}

const STATIC_IMPORT = /^[ \t]*(?:import|export)(?![ \t]*\()(?![ \t]*['"])[ \t]*(?:(?!\bfrom\b)[\s\S]){0,300}?\bfrom[ \t]*['"](?<specifier>[^'"]+)['"]/gm
const BARE_IMPORT = /^[ \t]*import[ \t]*['"](?<specifier>[^'"]+)['"]/gm
const ALIAS_ASSIGNMENT = /(?:const|let|var)[ \t]+(?<name>[A-Za-z_$][\w$]*)[ \t]*=[ \t]*createRequire[ \t]*\(/g
const CALL_WITH_LITERAL = /([A-Za-z_$][\w$]*)[ \t]*\([ \t]*['"](?<specifier>[^'"]+)['"]/g
const CREATEREQUIRE_CALL = /createRequire[ \t]*\([^)]*\)[ \t]*\([ \t]*['"](?<specifier>[^'"]+)['"]/g

/** Every literal specifier reached by a runtime-static import / re-export / require. */
export function staticSpecifiers(source) {
  const code = stripBlockComments(source)
  const found = []
  for (const match of code.matchAll(STATIC_IMPORT)) {
    const clause = match[0].replace(/^[ \t]*(?:import|export)/, '').replace(/from[\s\S]*$/, '')
    if (isTypeOnlyClause(clause)) continue
    found.push(match.groups.specifier)
  }
  for (const match of code.matchAll(BARE_IMPORT)) found.push(match.groups.specifier)
  const callees = new Set(['require'])
  for (const match of code.matchAll(ALIAS_ASSIGNMENT)) callees.add(match.groups.name)
  for (const match of code.matchAll(CALL_WITH_LITERAL)) {
    if (!callees.has(match[1])) continue
    found.push(match.groups.specifier)
  }
  for (const match of code.matchAll(CREATEREQUIRE_CALL)) found.push(match.groups.specifier)
  return found
}

/** An optional peer is referenced by bare name or by one of its subpaths. */
export function optionalPeerOf(specifier, optionalPeers) {
  return optionalPeers.find((peer) => specifier === peer || specifier.startsWith(peer + '/'))
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
// 3.2 retires legacy DSH peer declarations because engines.dsh alone gates
// supported Hosts. Keep Host-provided packages in the static-import tripwire:
// they must never turn into activation-time runtime imports by accident.
const HOST_PROVIDED_MODULES = Object.freeze([
  '@deepseek-ai/dsh-anonymous-user-id',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-storage-domain',
])
const optionalPeers = [...new Set([
  ...Object.entries(manifest.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name),
  ...HOST_PROVIDED_MODULES,
])].sort()

const offendersIn = async (directory) => {
  const found = []
  for (const file of await filesUnder(directory)) {
    const source = await readFile(file, 'utf8')
    for (const specifier of staticSpecifiers(source)) {
      if (!optionalPeerOf(specifier, optionalPeers)) continue
      const relative = fileURLToPath(file).replace(/\\/g, '/')
      const root = directory === SOURCE_ROOT ? '/src/' : '/lib/'
      found.push(relative.slice(relative.indexOf(root) + 1) + " -> '" + specifier + "'")
    }
  }
  return found.sort()
}

test('retired DSH peers remain guarded against static runtime imports', () => {
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), ['sharp'])
  for (const peer of HOST_PROVIDED_MODULES) {
    assert.equal(optionalPeers.includes(peer), true,
      peer + ' must stay guarded after removing peer dependency declarations')
    assert.equal(manifest.peerDependencies?.[peer], undefined)
  }
  assert.equal(manifest.peerDependenciesMeta.sharp.optional, true)
})

test('negative controls: the scanner flags runtime edges and ignores legal lazy/type forms', () => {
  const flagged = [
    "import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'",
    'import {',
    '  getOrCreateAnonymousUserId,',
    "} from '@deepseek-ai/dsh-anonymous-user-id'",
    "import 'sharp'",
    "export { x } from '@deepseek-ai/dsh-storage-domain'",
    "export * as ns from '@deepseek-ai/dsh-storage-domain'",
    'const req = createRequire(import.meta.url)',
    "const sharpPeer = req('sharp')",
    "const peer = createRequire(import.meta.url)('@deepseek-ai/dsh-llm-deepseek')",
    "const loaded = require('sharp')",
  ].join('\n')
  assert.deepEqual(
    [...new Set(staticSpecifiers(flagged).map((specifier) => optionalPeerOf(specifier, optionalPeers)).filter(Boolean))].sort(),
    ['@deepseek-ai/dsh-anonymous-user-id', '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-storage-domain', 'sharp'],
    'multi-line, bare, re-export, createRequire-alias, direct createRequire and literal require forms must all be flagged',
  )
  const legal = [
    "import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'",
    "export type { KvTable } from '@deepseek-ai/dsh-storage-domain'",
    "import { type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'",
    '/* import { DeepSeekAdapter } from "@deepseek-ai/dsh-llm-deepseek" */',
    "const lazy = await import('sharp')",
    "const { getOrCreateAnonymousUserId } = await import('@deepseek-ai/dsh-anonymous-user-id')",
    "const adapter = await import('@deepseek-ai/dsh-llm-deepseek')",
  ].join('\n')
  assert.deepEqual(
    staticSpecifiers(legal).map((specifier) => optionalPeerOf(specifier, optionalPeers)).filter(Boolean),
    [],
    'dynamic import, type-only imports and commented-out imports must stay allowed',
  )
})

test('no canonical source file statically imports an optional peer', async () => {
  const files = await filesUnder(SOURCE_ROOT)
  assert.ok(files.length > 100, 'src/ discovery returned too few files: ' + files.length)
  const found = await offendersIn(SOURCE_ROOT)
  assert.deepEqual(found, [], 'an optional peer may only be reached through a lazy import: ' + found.join(', '))
})

test('the generated runtime tree keeps the same contract', async (t) => {
  const built = await stat(RUNTIME_ROOT).then(() => true, () => false)
  if (!built) {
    assert.match(String(manifest.scripts?.pretest ?? ''), /build/, 'lib/ is missing and no pretest build hook would produce it')
    t.diagnostic('lib/ is not built yet; the source-tree contract above still applies')
    return
  }
  const files = await filesUnder(RUNTIME_ROOT)
  assert.ok(files.length > 100, 'lib/ discovery returned too few files: ' + files.length)
  const found = await offendersIn(RUNTIME_ROOT)
  assert.deepEqual(found, [], 'the generated activation path statically imports optional peers: ' + found.join(', '))
})

test('the packaged activation entries load with every optional peer unresolvable', async (t) => {
  const built = await stat(RUNTIME_ROOT).then(() => true, () => false)
  if (!built) {
    assert.match(String(manifest.scripts?.pretest ?? ''), /build/, 'lib/ is missing and no pretest build hook would produce it')
    t.diagnostic('lib/ is not built yet; the load probe is skipped in this invocation')
    return
  }
  for (const entry of ACTIVATION_ENTRIES) {
    const target = fileURLToPath(new URL(entry, import.meta.url))
    const probe = spawnSync(process.execPath, [PROBE, target], { encoding: 'utf8' })
    const detail = String(probe.stderr || probe.stdout).trim().split('\n')[0]
    assert.equal(probe.status, 0, entry + ' must load while the optional peers are missing (issue #719): ' + detail)
    assert.match(probe.stdout, /LOADED \d+ exports/, entry + ' did not report a successful load')
  }
  // The probe is only evidence if it really blocks: a module that does import an
  // optional peer must fail to load under the very same hooks.
  const control = spawnSync(process.execPath, [PROBE, PROBE_CONTROL], { encoding: 'utf8' })
  assert.notEqual(control.status, 0, 'the probe did not block an optional peer, so the checks above prove nothing')
  assert.match(control.stderr, /ERR_MODULE_NOT_FOUND/, 'the probe must fail with a module-resolution error')
})

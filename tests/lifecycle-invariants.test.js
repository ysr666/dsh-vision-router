import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findViolations, scanSource } from '../scripts/lint-lifecycle-invariants.mjs'

function violationsFor(source, file = 'src/lib/fixture.js') {
  return findViolations(source, file)
}

test('L1: call-time globalThis.fetch invocation is a violation', () => {
  const source = [
    'export function createThing({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {',
    '  return fetchImpl',
    '}',
  ].join('\n')
  const found = violationsFor(source)
  assert.equal(found.length, 1)
  assert.equal(found[0].rule, 'L1-sealed-process-global')
  assert.match(found[0].detail, /invoked at call time/)
})

test('L1: module-time capture is accepted in every supported spelling', () => {
  const accepted = [
    "const moduleFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined",
    'const moduleFetch = globalThis.fetch.bind(globalThis)',
    'export function createThing({ fetchImpl = moduleFetch } = {}) { return fetchImpl }',
    'type HostFetchInit = Parameters<typeof globalThis.fetch>[1]',
  ]
  for (const source of accepted) {
    assert.deepEqual(violationsFor(source), [], `expected accepted: ${source}`)
  }
})

test('L1: reading the global inside a function body is a violation', () => {
  const source = [
    'export function probe(options = {}) {',
    '  const impl = options.fetchImpl ?? globalThis.fetch',
    '  return impl',
    '}',
  ].join('\n')
  const found = violationsFor(source)
  assert.equal(found.length, 1)
  assert.equal(found[0].rule, 'L1-sealed-process-global')
  assert.match(found[0].detail, /inside a function body/)
})

test('L1: a documented exemption is honoured', () => {
  const source = [
    'export async function probe({',
    '  // CLI diagnostic: observes the current process transport on purpose.',
    '  // diagnostics-lint: sealed-process-global',
    '  fetchImpl = globalThis.fetch,',
    '} = {}) { return fetchImpl }',
  ].join('\n')
  assert.deepEqual(violationsFor(source), [])
})

test('L2: bare optional-capability read is a violation', () => {
  const source = [
    'export function attach(ctx) {',
    '  const attachments = ctx.attachments',
    '  return attachments',
    '}',
  ].join('\n')
  const found = violationsFor(source)
  assert.equal(found.length, 1)
  assert.equal(found[0].rule, 'L2-optional-capability-direct-read')
  assert.match(found[0].detail, /bare ctx\.attachments read/)
})

test('L2: Context#get probe and typeof guard are accepted', () => {
  const accepted = [
    "const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined",
    "if (typeof ctx.attachments !== 'undefined') { use(ctx.attachments) }",
    "if (typeof ctx.storageDomain?.open !== 'function') return undefined",
  ]
  for (const source of accepted) {
    assert.deepEqual(violationsFor(source), [], `expected accepted: ${source}`)
  }
})

test('L2: declared-dependency files and callback contexts are out of scope', () => {
  const source = 'export function install(ctx) { return ctx.llm.registerAdapter([], {}) }'
  assert.deepEqual(violationsFor(source, 'src/index.js'), [])
  const injected = 'ctx.inject([\'webServer\'], (webCtx) => { webCtx.effect(() => webCtx.webServer.register({})) })'
  assert.deepEqual(violationsFor(injected), [])
})

test('the shipped source tree satisfies both invariants', async () => {
  const violations = await scanSource()
  assert.deepEqual(violations, [], `lifecycle invariant violations:\n${violations.map((v) => `${v.file}:${v.line} ${v.rule}`).join('\n')}`)
})

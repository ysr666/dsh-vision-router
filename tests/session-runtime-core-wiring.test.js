import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('runtime composition creates one explicit SessionVisionRuntime and gives the same owner to boundary and core', async () => {
  const runtime = await source('lib/runtime-composition.js')

  assert.match(runtime, /const sessionVisionRuntime = createSessionVisionRuntime\(/)
  assert.match(
    runtime,
    /installSessionVisionIndexBoundary\([\s\S]*?index: sessionVisionRuntime\.index/,
  )
  assert.match(
    runtime,
    /core\.apply\([\s\S]*?\{ sessionVision: sessionVisionRuntime \}[\s\S]*?\)/,
  )
  assert.equal(
    (runtime.match(/createSessionVisionRuntime\(/g) ?? []).length,
    1,
    'composition must create exactly one SessionVisionRuntime',
  )
})

test('session state and index expose no hidden current owner or lookup monkey-patch seam', async () => {
  const state = await source('lib/session-vision-state.js')
  const index = await source('lib/session-vision-index.js')

  assert.doesNotMatch(state, /currentSessionVisionStateStore|\blet currentStore\b/)
  assert.doesNotMatch(index, /currentSessionVisionStateStore|legacyLookupDelegation|adoptStore/)
  assert.doesNotMatch(index, /store\.lookupAttachment\s*=(?!=)/)
  assert.match(index, /stateStore \?\? createSessionVisionStateStore\(\)/)
})

test('core delegates Session indexing, recovery and surface repair to SessionVisionIndex only', async () => {
  const core = await source('index.js')

  assert.match(core, /import \{ createSessionVisionIndex \} from '.\/lib\/session-vision-index\.js'/)
  assert.match(
    core,
    /const sessionVisionIndex = sessionVisionRuntime\?\.index \?\? createSessionVisionIndex\(/,
  )
  assert.match(
    core,
    /const lookupAttachment = \(session, id\) => sessionVisionIndex\.lookupAttachment\(session, id\)/,
  )
  assert.doesNotMatch(core, /const scanSessionEventLog\s*=/)
  assert.doesNotMatch(core, /const sanitizeSessionToolResults\s*=/)
  assert.doesNotMatch(core, /const sanitizeSessionGuardStops\s*=/)
  assert.doesNotMatch(core, /const sessionSurfaceScans\s*=/)
  assert.doesNotMatch(core, /const guardStopSurfaceScans\s*=/)
})

test('core accepts the optional internal runtime without breaking two-argument direct callers', async () => {
  const core = await source('index.js')

  assert.match(core, /export function apply\(ctx, config = \{\}, runtime = \{\}\) \{/)
  assert.match(core, /const sessionVisionRuntime = runtime\?\.sessionVision/)
  assert.match(
    core,
    /const visionState = sessionVisionRuntime\?\.stateStore \?\? createSessionVisionStateStore\(\{/,
    'core must use the explicit composition-owned store when supplied and preserve the legacy fallback otherwise',
  )
  assert.match(
    core,
    /if \(sessionVisionRuntime\?\.index === undefined\) \{\s*decision = await sessionVisionIndex\.prepareDecision\(payload, decision\)\s*\}/,
    'two-argument direct callers must keep the same Session behavior through the local index fallback',
  )
})

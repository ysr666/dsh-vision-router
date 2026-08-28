import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const core = await readFile(new URL('../index.js', import.meta.url), 'utf8')
const state = await readFile(new URL('../lib/session-vision-state.js', import.meta.url), 'utf8')
const index = await readFile(new URL('../lib/session-vision-index.js', import.meta.url), 'utf8')

test('SessionVisionStateStore is an ownership-pure factory with no current-store locator', () => {
  assert.doesNotMatch(state, /\blet currentStore\b/)
  assert.doesNotMatch(state, /currentSessionVisionStateStore/)
  assert.doesNotMatch(state, /currentStore\s*=\s*store/)
})

test('SessionVisionIndex never discovers or monkey-patches a store', () => {
  assert.doesNotMatch(index, /currentSessionVisionStateStore/)
  assert.doesNotMatch(index, /legacyLookupDelegation/)
  assert.doesNotMatch(index, /\badoptStore\b/)
  assert.doesNotMatch(index, /store\.lookupAttachment\s*=/)
  assert.match(index, /session vision index requires an explicit state store/)
})

test('core delegates Session indexing, durable recovery and surface repair to one index implementation', () => {
  assert.match(core, /import \{ createSessionVisionIndex \} from '\.\/lib\/session-vision-index\.js'/)
  assert.match(
    core,
    /const visionIndex = sessionVisionRuntime\?\.index \?\? createSessionVisionIndex\(/,
  )
  assert.match(
    core,
    /const lookupAttachment = \(session, id\) => visionIndex\.lookupAttachment\(session, id\)/,
  )
  assert.match(
    core,
    /if \(sessionVisionRuntime === undefined\) \{[\s\S]*?visionIndex\.recordAttachments\(session, rawImageRefs\.attachments\)[\s\S]*?visionIndex\.scanEventLog\(session\)[\s\S]*?\}/,
    'direct two-argument core callers must record and scan through SessionVisionIndex before inbox sanitization',
  )
  assert.match(
    core,
    /if \(sessionVisionRuntime === undefined\) \{[\s\S]*?await visionIndex\.repairToolResultSurface\(session\)[\s\S]*?await visionIndex\.repairGuardStopSurface\(session\)[\s\S]*?\}/,
    'direct two-argument core callers must repair the historical surface through SessionVisionIndex',
  )

  assert.doesNotMatch(core, /const scanSessionEventLog =/)
  assert.doesNotMatch(core, /const sanitizeSessionToolResults =/)
  assert.doesNotMatch(core, /const sanitizeSessionGuardStops =/)
  assert.doesNotMatch(core, /const sessionSurfaceScans = new WeakMap/)
  assert.doesNotMatch(core, /const guardStopSurfaceScans = new WeakMap/)
  assert.doesNotMatch(core, /await sanitizeSessionToolResults\(/)
  assert.doesNotMatch(core, /await sanitizeSessionGuardStops\(/)
})

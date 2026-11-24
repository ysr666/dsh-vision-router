import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  installSessionImageStabilizeCommand,
  inspectHistoricalProjectionEvents,
  assessProjectionDowngrade,
} from '../lib/session-image-stabilize-command.js'
import {
  committedStableProjectionWitnessMode,
  createStableProjectionWitness,
} from '../lib/session-image-projection-mode.js'

function fixture({
  events = [{ type: 'request/header' }, { type: 'assistant/message', data: { message: { role: 'assistant' } } }],
  flushResult = true,
  mode = 'legacy',
  headerVersion = 4,
  maintenanceBusy = false,
} = {}) {
  const log = [...events]
  const original = log.slice()
  const actions = { appends: [], flushes: 0, maintenance: 0 }
  const durabilityHolds = new Set()
  let flushBehavior = flushResult
  const session = {
    id: 'old-image-session',
    header: { isSeeded: true, version: headerVersion },
    firstLiveSeq: 2,
    requestHeader() { return {} },
    snapshotEvents() { return log },
    append(type, data, opts) {
      actions.appends.push({ type, data, opts })
      const event = { type, data }
      log.push(event)
      return event
    },
  }
  const agent = {
    id: session.id, session, status: maintenanceBusy ? 'running' : 'idle',
    runMaintenance(task) {
      actions.maintenance++
      if (this.status !== 'idle') throw new Error('busy')
      this.status = 'maintenance'
      return Promise.resolve(task(new AbortController().signal)).finally(() => {
        this.status = 'idle'
      })
    },
  }
  const handlers = new Map()
  installSessionImageStabilizeCommand({
    inject(deps, mount) {
      assert.deepEqual(deps, ['commands', 'sessions'])
      mount({
        commands: { register(def) { handlers.set(def.name, def) } },
        sessions: { async flush(s) {
          assert.equal(s, session)
          actions.flushes++
          const result = typeof flushBehavior === 'function'
            ? flushBehavior(actions.flushes) : flushBehavior
          if (result instanceof Error) throw result
          return result
        } },
      })
    },
  }, {
    get() { return mode },
    async resolve() { return mode },
    markUnverifiedDurability(id) { durabilityHolds.add(id) },
    markVerifiedDurability(id) { durabilityHolds.delete(id) },
    isDurabilityUnverified(id) { return durabilityHolds.has(id) },
  })
  const definition = handlers.get('vision-history-stabilize')
  assert.ok(definition)
  const call = (rawInput = 'CONFIRM', attachments = [], signal = new AbortController().signal) =>
    definition.handler({ agent, rawInput, attachments, signal })
  return {
    session, agent, log, original, actions, call, durabilityHolds,
    setFlush(value) { flushBehavior = value },
  }
}

test('#865: existing Session cannot migrate by default or by accidental slash invocation', async () => {
  const f = fixture()
  const result = await f.call('')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /first subsequent model request may rebuild/)
  assert.match(result.text, /Do NOT downgrade/)
  assert.equal(f.actions.appends.length, 0)
  assert.equal(f.actions.flushes, 0)
  assert.equal((await f.call('CONFIRM', [{ type: 'image' }])).kind, 'error')
  assert.equal(f.actions.appends.length, 0)
})

test('#865: explicit old legacy Session v2 stabilization is additive, durable and idempotent', async () => {
  const f = fixture()
  const result = await f.call()
  assert.equal(result.kind, 'success')
  assert.equal(f.actions.maintenance, 1)
  assert.equal(f.actions.flushes, 2, 'must check persistence owner before and after append')
  assert.equal(f.actions.appends.length, 1)
  const e = f.actions.appends[0]
  assert.equal(e.type, 'user/message')
  assert.deepEqual(e.opts, { surfaceOp: 'append' })
  assert.equal(committedStableProjectionWitnessMode(e.data), 'stable-v2')
  assert.deepEqual(f.log.slice(0, f.original.length), f.original,
    'all old Session raw records/attachments preserved without alteration')
  assert.equal(inspectHistoricalProjectionEvents(f.log).status, 'stable-v2')
  assert.deepEqual(assessProjectionDowngrade(f.log, 'stable-v1'),
    { decision: 'block', reason: 'target-cannot-read-v2' })
  assert.deepEqual(assessProjectionDowngrade(f.log, 'stable-v2'),
    { decision: 'allow', reason: 'format-recognized' })
  const again = await f.call()
  assert.equal(again.kind, 'success')
  assert.match(again.text, /no duplicate witness/)
  assert.equal(f.actions.appends.length, 1, 'retries must not append another format witness')
})

test('#865: V3 Session gets the verified legacy plugin-source body, not a forged V4 source', async () => {
  const f = fixture({ headerVersion: 3 })
  assert.equal((await f.call()).kind, 'success')
  assert.deepEqual(f.actions.appends[0].data.source, { kind: 'plugin', plugin: 'dsh-vision-router' })
  assert.equal(committedStableProjectionWitnessMode(f.actions.appends[0].data), 'stable-v2')
})

test('#865: running Agent cannot change format during an in-flight request', async () => {
  const f = fixture({ maintenanceBusy: true })
  assert.equal((await f.call()).kind, 'error')
  assert.equal(f.actions.appends.length, 0)
  assert.equal(f.actions.flushes, 0)
})

test('#865: no persistence acknowledgement means no Session mutation, never fake success', async () => {
  const f = fixture({ flushResult: false })
  const result = await f.call()
  assert.equal(result.kind, 'error')
  assert.match(result.text, /durable Session storage/)
  assert.equal(f.actions.appends.length, 0)
  assert.equal(f.actions.flushes, 1)
})

test('#865: a failed postappend flush returns error and a later retry does not duplicate the witness', async () => {
  // First pre-check succeeds; the post-append durable checkpoint fails.
  // The witness is already in memory, so a retry must only flush it.
  const f = fixture({ flushResult: count =>
    count === 2 ? new Error('disk failed after append') : true })
  const first = await f.call()
  assert.equal(first.kind, 'error')
  assert.equal(f.actions.appends.length, 1)
  assert.equal(inspectHistoricalProjectionEvents(f.log).status, 'stable-v2')
  assert.equal(f.actions.flushes, 2)
  assert.equal(f.durabilityHolds.has(f.session.id), true,
    'an unflushed in-memory v2 witness must fence later model requests')
  f.setFlush(true)
  const second = await f.call()
  assert.equal(second.kind, 'success')
  assert.equal(f.actions.appends.length, 1)
  assert.equal(f.actions.flushes, 4)
  assert.equal(f.durabilityHolds.has(f.session.id), false,
    'only confirmed retry removes the unverified-durability fence')
})

test('#865: prior v1 and contradictory witness histories cannot silently switch', async () => {
  const v1 = createStableProjectionWitness('old-image-session', { kind: 'plugin:dsh-vision-router' }, 'stable')
  const v2 = createStableProjectionWitness('old-image-session', { kind: 'plugin:dsh-vision-router' }, 'stable-v2')
  const old = [{ type: 'request/header' }, { type: 'user/message', data: v1 }]
  const f = fixture({ events: old })
  assert.equal((await f.call()).kind, 'error')
  assert.equal(f.actions.appends.length, 0)
  assert.equal(inspectHistoricalProjectionEvents(old).status, 'stable-v1')
  const conflict = [...old, { type: 'user/message', data: v2 }]
  assert.deepEqual(assessProjectionDowngrade(conflict, 'stable-v2'),
    { decision: 'block', reason: 'unverified-session-format' })
  assert.equal((await fixture({ events: conflict }).call()).kind, 'error')
  assert.deepEqual(assessProjectionDowngrade(old, 'stable-v1'),
    { decision: 'allow', reason: 'format-recognized' })
  assert.deepEqual(assessProjectionDowngrade(old, 'legacy-only'),
    { decision: 'block', reason: 'target-cannot-read-v1' })
})

test('#865: an unverified witness family fails closed, unwitnessed history is UNKNOWN on downgrade', async () => {
  const bad = {
    ...createStableProjectionWitness('old-image-session', { kind: 'plugin:dsh-vision-router' }, 'stable-v2'),
    id: 'vision-router-projection-stable-v99-' + 'f'.repeat(40),
  }
  const log = [{ type: 'request/header' }, { type: 'user/message', data: bad }]
  assert.equal(inspectHistoricalProjectionEvents(log).status, 'unknown')
  assert.equal((await fixture({ events: log }).call()).kind, 'error')
  assert.deepEqual(assessProjectionDowngrade([{ type: 'request/header' }], 'legacy-only'),
    { decision: 'unknown', reason: 'no-committed-format-proof' })
  assert.throws(() => assessProjectionDowngrade([], 'guessed-old-version'), /unknown target/)
})

test('#865: cold-restored hidden v1 sidecar blocks a silent migration despite no witness and empty cache', async () => {
  const f = fixture({ mode: 'stable' })
  const result = await f.call()
  assert.equal(result.kind, 'error')
  assert.match(result.text, /v1\/unknown history cannot be migrated/)
  assert.equal(f.actions.appends.length, 0)
  assert.equal(f.actions.flushes, 0)
})

test('#865: absent historical mode store cannot pretend an unwitnessed conversation is legacy', async () => {
  const f = fixture({ mode: 'unknown' })
  assert.equal((await f.call()).kind, 'error')
  assert.equal(f.actions.appends.length, 0)
})

test('#865: current live stable-v1 sidecar also prevents a conflicting explicit migration', async () => {
  const f = fixture({ mode: 'stable' })
  assert.equal((await f.call()).kind, 'error')
  assert.equal(f.actions.appends.length, 0)
})

test('#865: aborted command never begins maintenance or writes a witness', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  assert.equal((await f.call('CONFIRM', [], controller.signal)).kind, 'error')
  assert.equal(f.actions.maintenance, 0)
  assert.equal(f.actions.appends.length, 0)
})

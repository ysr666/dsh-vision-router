import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(process.env.DSH_SOURCE_ROOT || '')
const expected = process.env.DSH_EXPECTED_COMMIT || ''
assert.match(expected, /^[a-f0-9]{40}$/, 'the RC3 exact source commit is required')
assert.equal(execFileSync('git', ['-C',root,'rev-parse','HEAD'], {encoding:'utf8'}).trim(), expected)
const host = (file) => readFileSync(join(root,file),'utf8')
const agent = host('packages/core/agent-loop/src/agent.ts')
const inbox = host('packages/core/agent-loop/src/inbox.ts')
const model = host('packages/core/agent/src/model-selection.ts')
const projection = host('packages/session/session-projection/src/index.ts')
const session = host('packages/core/session/src/index.ts')
const compactionConfig = host('packages/compaction/compaction-basic/src/config.ts')

const strictlyOrdered = (source, markers, label) => {
  let cursor = -1
  for (const marker of markers) {
    const index = source.indexOf(marker, cursor + 1)
    assert.ok(index >= 0, label + ': missing or out-of-order ' + marker)
    cursor = index
  }
}

// The only safe non-blocking transition is after inbox splice commits but
// before wakeDriver starts preStep. These are source-observed timing contracts.
strictlyOrdered(agent, [
  'send(message: UserMessage',
  'this.inbox.splice(resolvedTarget',
  'if (wakeup) this.wakeDriver',
], 'send -> inbox -> wake')
strictlyOrdered(inbox, [
  "this.session.append('agent/inbox/spliced'",
  "this.dispatch.emit('agent/inbox/inserted'",
], 'durable append -> nonreentrant Agent notification')
strictlyOrdered(agent, [
  'this.setPhase({',
  "kind: 'running'",
  'this.loopCtx.agents.withInitiator(this, () => this.kick())',
], 'running notification -> Agent kick')
strictlyOrdered(agent, [
  'private async preStep(',
  'this.inbox.claim(',
  'this.model.current()',
  'this.loopCtx.tools.resolve(',
  'this.loopCtx.systemPrompt.assemble(',
  "'agent/pre-step'",
], 'pre-step model is fixed before tools and prompts')
assert.match(agent, /this\.dispatch\.serial\('agent\/turn-stopping'/)
assert.match(agent, /proposedConfig\.provider !== selection\.provider \|\| proposedConfig\.model !== selection\.model/)
assert.match(agent, /use agent\.model\.select\(\) before step preparation/)
assert.match(model, /select\(selection: Readonly<ModelSelection>\): void/)
assert.match(model, /this\.session\.append\('model\/selection'/)
assert.match(projection, /stateOf\(session: Session/)
assert.match(session, /session append cannot reenter while another append is being published/)
// RC3 rejects switching even with an empty history when 32k windows cannot
// fit the Host's default 65,536-token headroom. Pin that documented premise;
// the ordinary dynamic E2E uses an appropriately sized synthetic adapter.
const headroom = /config\.headroomTokens\s*\?\?\s*([0-9_]+)/.exec(compactionConfig)
assert.ok(headroom, 'RC3 compaction default headroom contract missing')
const tokens = Number(headroom[1].replaceAll('_', ''))
assert.equal(tokens, 65_536)
assert.ok(32_768 - 2048 - tokens <= 0, 'default 32k destination must be rejected')
assert.ok(32_768 - 2048 - 4096 > 0, 'small model can be supported by an explicit Host per-model headroom policy')

assert.match(session, /invokeContainedSessionObservers\(entry\.emitCtx, 'session\/event'/)

const batchStart = session.indexOf('  #appendEvents(inputs: readonly SessionEventInput[])')
assert.ok(batchStart >= 0, 'RC3 must support atomic Session.append([...])')
const batchEnd = session.indexOf('\n  static {', batchStart)
assert.ok(batchEnd > batchStart, 'RC3 batch publication boundary missing')
const batch = session.slice(batchStart, batchEnd)
strictlyOrdered(batch, [
  'const publications =',
  'for (const event of events) this.log.push(event)',
  'acceptSurface()',
  'for (const { event, args, callbacks } of publications)',
  'this.batchPublication = event',
  "invokeContainedSessionObservers(entry.emitCtx, 'session/event'",
], 'RC3 complete batch commit -> individual post-commit event observer')
assert.match(batch, /entry\.appending = false/, 'RC3 must release non-reentrant publication guard')

console.log(JSON.stringify({ok:true,hostSha:expected, modelFixedBeforeTools:true,inboxNotificationAfterCommit:true,nonreentrantSelection:true}))

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(process.env.DSH_SOURCE_ROOT || '')
const expected = process.env.DSH_EXPECTED_COMMIT || ''
assert.match(expected, /^[a-f0-9]{40}$/, 'the RC1 exact source commit is required')
assert.equal(execFileSync('git', ['-C',root,'rev-parse','HEAD'], {encoding:'utf8'}).trim(), expected)
const host = (file) => readFileSync(join(root,file),'utf8')
const agent = host('packages/core/agent-loop/src/agent.ts')
const inbox = host('packages/core/agent-loop/src/inbox.ts')
const model = host('packages/core/agent/src/model-selection.ts')
const projection = host('packages/session/session-projection/src/index.ts')
const session = host('packages/core/session/src/index.ts')

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
assert.match(session, /invokeContainedSessionObservers\(entry\.emitCtx, 'session\/event'/)
console.log(JSON.stringify({ok:true,hostSha:expected, modelFixedBeforeTools:true,inboxNotificationAfterCommit:true,nonreentrantSelection:true}))

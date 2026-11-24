import test from 'node:test'
import assert from 'node:assert/strict'
import { compareFinalWireRequests } from '../scripts/issue-865-final-wire-diff.mjs'

const upstream = { provider: 'real-upstream-provider', model: 'real-upstream-model' }
const message = (role, text) => ({ role, content: [{ type: 'text', text }] })
const old = [
  message('system', 'SECRET SYSTEM PREFIX'),
  message('user', 'SECRET OLD IMAGE MARKER'),
  message('assistant', 'SECRET OLD ASSISTANT'),
]
const fixture = (messages = old, overrides = {}) => ({
  wire: {
    model: upstream.model,
    tools: [{ name: 'secret_vision_tool', description: 'secret tool documentation' }],
    messages, max_tokens: 1000,
    ...overrides,
  },
  upstream,
})

test('#865: append-only final DSH DeepSeek Messages history preserves old serialized prefix', () => {
  const d = compareFinalWireRequests(fixture(), fixture([
    ...old, message('user', 'SECRET NEW CONTINUATION'),
  ]))
  assert.equal(d.localSerializedPrefixPreserved, true)
  assert.equal(d.firstDifferentHistoricalIndex, null)
  assert.equal(d.commonHistoricalMessages, 3)
  assert.equal(d.after.appendedMessages, 1)
  assert.deepEqual(d.changedDimensions, [])
  assert.equal(d.before.historyHmacSha256, d.after.oldHistoryPrefixHmacSha256)
  const printed = JSON.stringify(d)
  for (const secret of ['SECRET', 'secret_vision_tool', upstream.provider, upstream.model]) {
    assert.ok(!printed.includes(secret), 'must not echo request/model/tool text: ' + secret)
  }
})

test('#865: tool-policy switch is not disguised as a stable cache prefix', () => {
  const next = fixture([...old, message('user', 'continue')], {
    tools: [{ name: 'foreign_only', description: 'never print me' }],
  })
  const d = compareFinalWireRequests(fixture(), next)
  assert.equal(d.changes.tools, true)
  assert.equal(d.changes.history, false)
  assert.equal(d.localSerializedPrefixPreserved, false)
  assert.equal(d.after.appendedMessages, 1)
  assert.ok(d.changedDimensions.includes('tools'))
  assert.ok(!JSON.stringify(d).includes('foreign_only'))
})

test('#865: changed historical image, not just appended OCR evidence, is reported as first difference', () => {
  const latest = old.map((m, i) => i === 1 ? message('user', 'DIFFERENT IMAGE DESCRIPTION') : m)
  const d = compareFinalWireRequests(fixture(), fixture([...latest, message('user', 'later')]))
  assert.equal(d.changes.history, true)
  assert.equal(d.firstDifferentHistoricalIndex, 1)
  assert.equal(d.firstDifferentHistoricalKind, 'history')
  assert.equal(d.commonHistoricalMessages, 1)
  assert.equal(d.after.appendedMessages, null)
  assert.equal(d.localSerializedPrefixPreserved, false)
  assert.ok(!JSON.stringify(d).includes('DIFFERENT'))
})

test('#865: prompt, model and reasoning changes are independent causes, not one vague cache miss', () => {
  const d = compareFinalWireRequests(fixture(), fixture(old, {
    model: 'another-model',
    thinking: { type: 'enabled' },
    system: 'ANOTHER SECRET SYSTEM',
  }))
  assert.equal(d.changes.model, true)
  assert.equal(d.changes.system, true)
  assert.equal(d.changes.reasoning, true)
  assert.equal(d.changes.history, false)
  assert.equal(d.localSerializedPrefixPreserved, false)
  assert.ok(!JSON.stringify(d).includes('ANOTHER'))
})

test('#865: reordering serialized header keys is a real wire-byte change', () => {
  const a = fixture()
  const b = {
    upstream,
    wire: {
      tools: a.wire.tools,
      model: a.wire.model,
      max_tokens: a.wire.max_tokens,
      messages: a.wire.messages,
    },
  }
  const d = compareFinalWireRequests(a, b)
  assert.equal(d.changes.otherHeader, true)
  assert.equal(d.localSerializedPrefixPreserved, false)
  assert.notEqual(d.before.headerHmacSha256, d.after.headerHmacSha256)
})

test('#865: HMAC report digests use an unexported per-comparison key', () => {
  const a = compareFinalWireRequests(fixture(), fixture())
  const b = compareFinalWireRequests(fixture(), fixture())
  assert.equal(a.before.historyHmacSha256, a.after.oldHistoryPrefixHmacSha256)
  assert.notEqual(a.before.historyHmacSha256, b.before.historyHmacSha256,
    'low-entropy prompts must not yield a stable publicly dictionary-searchable hash')
})

test('#865: same wire on a different actual upstream provider is NOT considered cache-preserving', () => {
  const d = compareFinalWireRequests(fixture(), {
    ...fixture(),
    upstream: { provider: 'other-upstream', model: upstream.model },
  })
  assert.equal(d.changes.upstream, true)
  assert.equal(d.localSerializedPrefixPreserved, false)
  assert.equal(d.upstreamComparable, true)
  assert.ok(!JSON.stringify(d).includes('other-upstream'))
})

test('#865: unknown upstream identity stays UNKNOWN rather than inventing a cache continuity proof', () => {
  const before = { wire: fixture().wire }
  const d = compareFinalWireRequests(before, fixture())
  assert.equal(d.changes.upstream, null)
  assert.equal(d.upstreamComparable, false)
  assert.equal(d.localSerializedPrefixPreserved, true, 'only wire-shape equality is proved')
})

test('#865: DeepSeek incremental tool removal inside a developer block is attributed to tools', () => {
  const removed = [
    message('system', 'context'),
    { role: 'developer', content: [{ type: 'tool_removal', toolName: 'private_tool' }] },
    message('user', 'continue'),
  ]
  const changed = [
    removed[0], { role: 'developer', content: [{ type: 'tool_addition', toolName: 'private_tool' }] },
    removed[2],
  ]
  const d = compareFinalWireRequests(fixture(removed), fixture(changed))
  assert.equal(d.changes.tools, true)
  assert.equal(d.changes.history, true)
  assert.equal(d.firstDifferentHistoricalIndex, 1)
  assert.equal(d.firstDifferentHistoricalKind, 'tools')
})

test('#865: malformed final request or upstream identity must fail without fallback guesses', () => {
  assert.throws(() => compareFinalWireRequests({}, fixture()), /expected/)
  assert.throws(() => compareFinalWireRequests(fixture(), { wire: { messages: ['bad'] } }), /malformed/)
  assert.throws(() => compareFinalWireRequests(fixture(), {
    wire: fixture().wire, upstream: { provider: 'just-a-provider' },
  }), /upstream/)
})

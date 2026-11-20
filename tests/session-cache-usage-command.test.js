import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeSessionCacheUsage, installSessionCacheUsageCommand } from '../lib/session-cache-usage-command.js'
function response(turn, usage, source = { kind: 'model', provider: 'SECRET_ACCOUNT', model: 'PRIVATE_MODEL' }) {
  return { type: 'assistant/message', data: { turn, step: 1, usage,
    message: { source, content: [{ type: 'text', text: 'NEVER_EXPORT_CHAT_CONTENT' }] } } }
}
test('explicit disjoint cache counts reconcile; missing fields are not zero; routes are anonymous', () => {
  const events = [
    response(1, { inputTokens: 22, cacheReadTokens: 1100, outputTokens: 8, totalTokens: 1130 }),
    response(2, { inputTokens: 22, outputTokens: 8, totalTokens: 30 }),
    response(3, { inputTokens: 100, cacheReadTokens: 0, outputTokens: 8, totalTokens: 108 }),
    response(4, { inputTokens: 100, cacheReadTokens: 80, outputTokens: 8, totalTokens: 108 },
      { kind: 'model', provider: 'SECRET_ACCOUNT-vision', model: 'PRIVATE_MODEL' }),
    response(5, { inputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10, outputTokens: 8, totalTokens: 108 }),
    response(6, { inputTokens: -5, cacheReadTokens: NaN, outputTokens: 8, totalTokens: 108 }),
    response(7, undefined),
    response(8, { inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: -1, outputTokens: 8, totalTokens: 108 }),
    { ...response(9, { inputTokens: 10 }), data: { ...response(9).data, interrupted: true } },
    { type: 'assistant/attempt', data: { stream: ['NEVER_EXPORT_ATTEMPT'] } },
  ]
  const result = summarizeSessionCacheUsage(events)
  assert.equal(result.rows.length, 8)
  assert.equal(result.rows[0].hitPercent, 98)
  assert.equal(result.rows[1].read, undefined)
  assert.equal(result.rows[1].hitPercent, undefined)
  assert.equal(result.rows[2].hitPercent, 0)
  assert.equal(result.rows[3].hitPercent, undefined)
  assert.equal(result.rows[3].route, 'R2')
  assert.equal(result.rows[4].hitPercent, 70)
  assert.equal(result.rows[5].input, undefined)
  assert.equal(result.rows[6].total, undefined)
  assert.equal(result.rows[7].hitPercent, undefined)
  assert.doesNotMatch(JSON.stringify(result), /SECRET_ACCOUNT|PRIVATE_MODEL|NEVER_EXPORT/)
})
test('bounds recent entries and scan without serializing full history', () => {
  const rows = Array.from({ length: 25 }, (_, i) => response(i, { inputTokens: i }))
  assert.equal(summarizeSessionCacheUsage(rows).rows[0].turn, 5)
  assert.equal(summarizeSessionCacheUsage(rows).rows.length, 20)
  assert.equal(summarizeSessionCacheUsage(rows).truncated, true)
  const tail = Array.from({ length: 10000 }, () => ({ type: 'tool/result' }))
  assert.deepEqual(summarizeSessionCacheUsage([response(1), ...tail]), { rows: [], truncated: true })
  assert.equal(summarizeSessionCacheUsage(undefined), undefined)
})
test('manual command reads only the authorized live Session and calls no model', () => {
  let command
  installSessionCacheUsageCommand({ inject(names, apply) {
    assert.deepEqual(names, ['commands'])
    apply({ commands: { register(value) { command = value } } })
  } })
  assert.equal(command.name, 'vision-cache')
  let reads = 0
  const session = { id: 'session', snapshotEvents() {
    reads++
    return [response(1, { inputTokens: 10, cacheReadTokens: 90, outputTokens: 7, totalTokens: 107 })]
  } }
  const agent = { id: 'session', session, model: { select() { throw Error('never change model') } } }
  const report = command.handler({ agent, rawInput: '' })
  assert.equal(report.kind, 'success')
  assert.match(report.text, /1\/1 \| R1 \| 10 \| 90 \| \? \| 7 \| 107 \| 90.0%/)
  assert.doesNotMatch(report.text, /SECRET_ACCOUNT|PRIVATE_MODEL|NEVER_EXPORT/)
  assert.equal(command.handler({ agent: { ...agent, id: 'other' } }).kind, 'error')
  assert.equal(command.handler({ agent, rawInput: 'other-session' }).kind, 'error')
  assert.equal(command.handler({ agent, attachments: [{}] }).kind, 'error')
  assert.equal(command.handler({ agent, signal: AbortSignal.abort() }).kind, 'error')
  assert.equal(reads, 1)
})

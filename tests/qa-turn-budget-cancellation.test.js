import assert from 'node:assert/strict'
import test from 'node:test'

import {
  currentVisionTurnBudgetSignal,
  runWithVisionTurnBudget,
} from '../lib/turn-budget-context.js'

test('nested structured deadlines preserve the outer agent cancellation signal', async () => {
  const agent = new AbortController()
  const structured = new AbortController()

  await runWithVisionTurnBudget({ signal: agent.signal }, async () => {
    await runWithVisionTurnBudget({ deadlineAt: Date.now() + 60_000, signal: structured.signal }, async () => {
      const combined = currentVisionTurnBudgetSignal()
      assert.ok(combined)
      assert.equal(combined.aborted, false)
      agent.abort()
      await Promise.resolve()
      assert.equal(combined.aborted, true, 'inner structured budget must not hide user cancellation')
      assert.equal(structured.signal.aborted, false, 'child deadline itself should remain independent')
    })
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  currentVisionTurnBudget,
  currentVisionTurnBudgetSignal,
  runWithVisionTurnBudget,
} from '../lib/turn-budget-context.js'

test('nested structured deadlines preserve outer cancellation and the earliest deadline', async () => {
  const agent = new AbortController()
  const structured = new AbortController()
  const parentDeadline = Date.now() + 10_000

  await runWithVisionTurnBudget({ deadlineAt: parentDeadline, signal: agent.signal }, async () => {
    await runWithVisionTurnBudget({ deadlineAt: parentDeadline + 50_000, signal: structured.signal }, async () => {
      const budget = currentVisionTurnBudget()
      const combined = currentVisionTurnBudgetSignal()
      assert.equal(budget.deadlineAt, parentDeadline, 'inner budget may not extend an earlier parent deadline')
      assert.ok(combined)
      assert.equal(combined.aborted, false)
      agent.abort()
      await Promise.resolve()
      assert.equal(combined.aborted, true, 'inner structured budget must not hide user cancellation')
      assert.equal(structured.signal.aborted, false, 'child deadline itself should remain independent')
    })
  })
})

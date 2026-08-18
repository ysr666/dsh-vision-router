import { AsyncLocalStorage } from 'node:async_hooks'

const turnBudgetScope = new AsyncLocalStorage()

/** Run one async tool execution inside an ambient turn-level budget. */
export function runWithVisionTurnBudget(budget, fn) {
  if (typeof fn !== 'function') throw new TypeError('runWithVisionTurnBudget: fn must be a function')
  return turnBudgetScope.run(budget, fn)
}

export function currentVisionTurnBudget() {
  return turnBudgetScope.getStore()
}

export function currentVisionTurnBudgetSignal() {
  return turnBudgetScope.getStore()?.signal
}

export function remainingVisionTurnBudgetMs(now = Date.now) {
  const budget = turnBudgetScope.getStore()
  if (!budget || !Number.isFinite(Number(budget.deadlineAt))) return undefined
  const clock = typeof now === 'function' ? now : Date.now
  return Math.max(0, Number(budget.deadlineAt) - Number(clock()))
}

import { AsyncLocalStorage } from 'node:async_hooks'

const turnBudgetScope = new AsyncLocalStorage()

function usableSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' ? value : undefined
}

/**
 * Run one async tool execution inside an ambient turn-level budget.
 * Nested budgets keep their own deadline metadata but may not discard a parent
 * cancellation signal (for example the agent execution signal installed by the
 * outer Vision Router tool boundary before Structured 1+x starts its deadline).
 */
export function runWithVisionTurnBudget(budget, fn) {
  if (typeof fn !== 'function') throw new TypeError('runWithVisionTurnBudget: fn must be a function')
  const parent = turnBudgetScope.getStore()
  const parentSignal = usableSignal(parent?.signal)
  const childSignal = usableSignal(budget?.signal)
  let next = budget
  if (parentSignal && childSignal && parentSignal !== childSignal) {
    next = { ...(budget ?? {}), signal: AbortSignal.any([parentSignal, childSignal]) }
  } else if (parentSignal && !childSignal) {
    next = { ...(budget ?? {}), signal: parentSignal }
  }
  return turnBudgetScope.run(next, fn)
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

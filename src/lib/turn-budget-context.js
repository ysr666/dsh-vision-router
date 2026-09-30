import { AsyncLocalStorage } from 'node:async_hooks'

const turnBudgetScope = new AsyncLocalStorage()

function usableSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' ? value : undefined
}

function finiteDeadline(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * Run one async tool execution inside an ambient turn-level budget.
 * Nested budgets may tighten the parent, but may not discard an earlier parent
 * deadline, cancellation signal or artifact-run identity.
 */
export function runWithVisionTurnBudget(budget, fn) {
  if (typeof fn !== 'function') throw new TypeError('runWithVisionTurnBudget: fn must be a function')
  const parent = turnBudgetScope.getStore()
  const parentSignal = usableSignal(parent?.signal)
  const childSignal = usableSignal(budget?.signal)
  const parentDeadline = finiteDeadline(parent?.deadlineAt)
  const childDeadline = finiteDeadline(budget?.deadlineAt)
  let next = budget
  if (parentSignal && childSignal && parentSignal !== childSignal) {
    next = { ...(next ?? {}), signal: AbortSignal.any([parentSignal, childSignal]) }
  } else if (parentSignal && !childSignal) {
    next = { ...(next ?? {}), signal: parentSignal }
  }
  if (parentDeadline !== undefined && (childDeadline === undefined || parentDeadline < childDeadline)) {
    next = { ...(next ?? {}), deadlineAt: parentDeadline }
  }
  if (
    typeof parent?.artifactRunId === 'string' &&
    parent.artifactRunId !== '' &&
    !(typeof next?.artifactRunId === 'string' && next.artifactRunId !== '')
  ) {
    next = { ...(next ?? {}), artifactRunId: parent.artifactRunId }
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

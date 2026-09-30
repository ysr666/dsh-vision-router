import { AsyncLocalStorage } from 'node:async_hooks'

export interface VisionTurnBudget {
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly artifactRunId?: string
  readonly [key: string]: unknown
}

const turnBudgetScope = new AsyncLocalStorage<VisionTurnBudget | undefined>()

function usableSignal(value: unknown): AbortSignal | undefined {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { aborted?: unknown }).aborted === 'boolean'
    ? value as AbortSignal
    : undefined
}

function finiteDeadline(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function objectBudget(value: unknown): VisionTurnBudget | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as VisionTurnBudget
    : undefined
}

/**
 * Run one async tool execution inside an ambient turn-level budget.
 * Nested budgets may tighten the parent, but may not discard an earlier parent
 * deadline, cancellation signal or artifact-run identity.
 */
export function runWithVisionTurnBudget<T>(
  budget: VisionTurnBudget | undefined,
  fn: () => T,
): T {
  if (typeof fn !== 'function') throw new TypeError('runWithVisionTurnBudget: fn must be a function')
  const parent = turnBudgetScope.getStore()
  const parentSignal = usableSignal(parent?.signal)
  const childSignal = usableSignal(budget?.signal)
  const parentDeadline = finiteDeadline(parent?.deadlineAt)
  const childDeadline = finiteDeadline(budget?.deadlineAt)
  let next = objectBudget(budget)

  if (parentSignal && childSignal && parentSignal !== childSignal) {
    next = { ...(next ?? {}), signal: AbortSignal.any([parentSignal, childSignal]) }
  } else if (parentSignal && !childSignal) {
    next = { ...(next ?? {}), signal: parentSignal }
  }

  if (parentDeadline !== undefined && (childDeadline === undefined || parentDeadline < childDeadline)) {
    next = { ...(next ?? {}), deadlineAt: parentDeadline }
  }

  if (
    typeof parent?.artifactRunId === 'string'
    && parent.artifactRunId !== ''
    && !(typeof next?.artifactRunId === 'string' && next.artifactRunId !== '')
  ) {
    next = { ...(next ?? {}), artifactRunId: parent.artifactRunId }
  }

  return turnBudgetScope.run(next, fn)
}

export function currentVisionTurnBudget(): VisionTurnBudget | undefined {
  return turnBudgetScope.getStore()
}

export function currentVisionTurnBudgetSignal(): AbortSignal | undefined {
  return usableSignal(turnBudgetScope.getStore()?.signal)
}

export function remainingVisionTurnBudgetMs(
  now: unknown = Date.now,
): number | undefined {
  const budget = turnBudgetScope.getStore()
  const deadlineAt = finiteDeadline(budget?.deadlineAt)
  if (deadlineAt === undefined) return undefined
  const clock = typeof now === 'function'
    ? now as () => unknown
    : Date.now
  return Math.max(0, deadlineAt - Number(clock()))
}

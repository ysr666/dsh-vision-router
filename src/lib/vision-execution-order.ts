import { AsyncLocalStorage } from 'node:async_hooks'

export interface VisionRouteIdentity {
  readonly provider: string
  readonly model: string
}

interface VisionExecutionOrderScope {
  readonly order: readonly VisionRouteIdentity[]
}

const executionOrderScope = new AsyncLocalStorage<VisionExecutionOrderScope>()

function normalizedPair(pair: unknown): Readonly<VisionRouteIdentity> {
  const value = pair !== null && typeof pair === 'object'
    ? pair as { provider?: unknown; model?: unknown }
    : {}
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') {
    throw new TypeError('vision execution order entries require non-empty provider and model')
  }
  return Object.freeze({ provider, model })
}

function normalizedOrder(order: unknown): readonly Readonly<VisionRouteIdentity>[] {
  if (!Array.isArray(order)) throw new TypeError('vision execution order must be an array')
  return Object.freeze(order.map(normalizedPair))
}

/**
 * Run one Router-owned visual execution with an explicit provider/model order.
 *
 * The scope deliberately carries ONLY detached `{ provider, model }` pairs.
 * It contains no settings snapshot, credentials, authority, scores, evidence,
 * Host services, or mutable caller objects.
 */
export function withVisionExecutionOrder<T>(
  order: unknown,
  fn: () => T,
): T {
  if (typeof fn !== 'function') throw new TypeError('withVisionExecutionOrder requires a function')
  const scopedOrder = normalizedOrder(order)
  return executionOrderScope.run({ order: scopedOrder }, fn)
}

/**
 * Current Router-owned visual order for this async call chain, or undefined
 * outside an explicit visual execution scope.
 */
export function currentVisionExecutionOrder(): readonly VisionRouteIdentity[] | undefined {
  return executionOrderScope.getStore()?.order
}

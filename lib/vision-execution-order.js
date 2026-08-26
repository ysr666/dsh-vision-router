import { AsyncLocalStorage } from 'node:async_hooks'

const executionOrderScope = new AsyncLocalStorage()

function normalizedPair(pair) {
  const provider = typeof pair?.provider === 'string' ? pair.provider.trim() : ''
  const model = typeof pair?.model === 'string' ? pair.model.trim() : ''
  if (provider === '' || model === '') {
    throw new TypeError('vision execution order entries require non-empty provider and model')
  }
  return Object.freeze({ provider, model })
}

function normalizedOrder(order) {
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
export function withVisionExecutionOrder(order, fn) {
  if (typeof fn !== 'function') throw new TypeError('withVisionExecutionOrder requires a function')
  const scopedOrder = normalizedOrder(order)
  return executionOrderScope.run({ order: scopedOrder }, fn)
}

/**
 * Current Router-owned visual order for this async call chain, or undefined
 * outside an explicit visual execution scope.
 */
export function currentVisionExecutionOrder() {
  return executionOrderScope.getStore()?.order
}

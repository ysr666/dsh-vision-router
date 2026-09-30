import type { VisionRouteIdentity } from './vision-execution-order.js'

function pairIdentity(pair: unknown): string | undefined {
  const value = pair !== null && typeof pair === 'object'
    ? pair as { provider?: unknown; model?: unknown }
    : {}
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  return provider !== '' && model !== '' ? `${provider}\u0000${model}` : undefined
}

/**
 * Apply an explicit P1 execution order to a base pair list without changing
 * the base set of executable routes.
 *
 * This is intentionally a stable reorder, not replacement:
 * - a scoped pair not present in `basePairs` is ignored (cannot invent a route);
 * - every base pair omitted by the planner is appended in its original order
 *   (cannot delete configured/local/discovered fallback);
 * - duplicate base/scoped identities collapse to the first base occurrence;
 * - no scoped order means byte-for-shape legacy behavior: a detached copy of
 *   the base list in the same order.
 *
 * The caller remains responsible for constructing `basePairs` with its normal
 * adapter/HTTP/local availability rules. This helper owns ordering only.
 */
export function applyVisionExecutionOrder<T>(
  basePairs: readonly T[],
  scopedOrder: readonly VisionRouteIdentity[] | undefined,
): T[]
export function applyVisionExecutionOrder(
  basePairs: unknown,
  scopedOrder: unknown,
): unknown[]
export function applyVisionExecutionOrder(
  basePairs: unknown,
  scopedOrder: unknown,
): unknown[] {
  const base = Array.isArray(basePairs)
    ? basePairs.filter((pair) => pairIdentity(pair) !== undefined)
    : []
  const baseById = new Map<string, unknown>()
  for (const pair of base) {
    const id = pairIdentity(pair)
    if (id !== undefined && !baseById.has(id)) baseById.set(id, pair)
  }

  if (!Array.isArray(scopedOrder) || scopedOrder.length === 0) {
    return [...baseById.values()]
  }

  const out: unknown[] = []
  const seen = new Set<string>()
  const addBasePair = (pair: unknown): void => {
    const id = pairIdentity(pair)
    if (id === undefined || seen.has(id)) return
    seen.add(id)
    out.push(pair)
  }

  for (const requested of scopedOrder) {
    const id = pairIdentity(requested)
    if (id === undefined) continue
    const pair = baseById.get(id)
    if (pair !== undefined) addBasePair(pair)
  }
  for (const pair of baseById.values()) addBasePair(pair)
  return out
}

export function sameVisionPairOrder(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (pairIdentity(left[index]) !== pairIdentity(right[index])) return false
  }
  return true
}

function pairIdentity(pair) {
  const provider = typeof pair?.provider === 'string' ? pair.provider.trim() : ''
  const model = typeof pair?.model === 'string' ? pair.model.trim() : ''
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
export function applyVisionExecutionOrder(basePairs, scopedOrder) {
  const base = Array.isArray(basePairs)
    ? basePairs.filter((pair) => pairIdentity(pair) !== undefined)
    : []
  const baseById = new Map()
  for (const pair of base) {
    const id = pairIdentity(pair)
    if (!baseById.has(id)) baseById.set(id, pair)
  }

  if (!Array.isArray(scopedOrder) || scopedOrder.length === 0) {
    return [...baseById.values()]
  }

  const out = []
  const seen = new Set()
  const addBasePair = (pair) => {
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

export function sameVisionPairOrder(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (pairIdentity(left[index]) !== pairIdentity(right[index])) return false
  }
  return true
}

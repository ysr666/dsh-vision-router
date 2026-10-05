/**
 * Single owner of the Vision Router adapter ownership marker.
 *
 * Three modules used to interpret the same process-wide symbol on their own, and
 * two of them treated "the marker is not undefined" as ownership — so a foreign
 * adapter that wrote `'anything'`, `false`, `null` or `0` onto the shared symbol
 * was classified as Vision Router's own adapter. The marker value is a token this
 * package freezes, so ownership means "a frozen owner token is present".
 *
 * The symbol stays `Symbol.for(...)` so separately loaded copies of this package
 * still recognize each other's adapters; the rule about its *value* lives here
 * once.
 *
 * Residual risk, stated rather than hidden: in-process code able to run arbitrary
 * JavaScript can still freeze a look-alike token. Removing that needs one shared
 * authority instead of a process-wide symbol, which is a larger design change.
 */
export const VISION_ROUTER_ADAPTER_OWNER = Symbol.for('dsh-vision-router.adapter-owner')

/** Read the marker without letting a hostile proxy/getter escape. */
export function readVisionRouterAdapterOwner(adapter: unknown): unknown {
  if (adapter === null || (typeof adapter !== 'object' && typeof adapter !== 'function')) {
    return undefined
  }
  try {
    return (adapter as Record<symbol, unknown>)[VISION_ROUTER_ADAPTER_OWNER]
  } catch {
    return undefined
  }
}

/**
 * True when the adapter carries an owner marker object.
 *
 * The marker's value has always been an object — the registration chain mints
 * `Object.freeze({})`, and composition/tests mark adapters with plain records
 * such as `{ route: 'deepseek-vision' }`. Requiring "an object" therefore keeps
 * every genuine owner (including ones marked by another loaded copy) and rejects
 * the values a foreign adapter can write by accident or in one line: `'anything'`,
 * `false`, `null`, `0` and any other primitive.
 *
 * A first version of this fix also demanded `Object.isFrozen(owner)`. The
 * repository's own issue-276/289/374/512 suites mark adapters with plain objects,
 * so that extra requirement classified genuine owners as foreign and broke
 * delegation; it was reverted here instead of being worked around in the tests.
 *
 * Residual risk, stated rather than hidden: in-process code able to run arbitrary
 * JavaScript can still assign `{}` and be treated as an owner. Removing that needs
 * one shared authority instead of a process-wide symbol, which is a larger design
 * change than this fix.
 */
export function isVisionRouterOwnedAdapter(adapter: unknown): boolean {
  const owner = readVisionRouterAdapterOwner(adapter)
  return typeof owner === 'object' && owner !== null
}

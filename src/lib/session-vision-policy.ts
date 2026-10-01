export const SESSION_VISION_POLICY_REVISION = 1 as const

export type SessionVisionPolicySource = 'user' | 'delegation'

export type SessionVisionPolicy =
  | Readonly<{
      revision: typeof SESSION_VISION_POLICY_REVISION
      enabled: boolean
      source: 'user'
      inheritedFrom?: never
    }>
  | Readonly<{
      revision: typeof SESSION_VISION_POLICY_REVISION
      enabled: boolean
      source: 'delegation'
      inheritedFrom: string
    }>

export interface SessionVisionPolicyTable {
  get(key: string): unknown
  put(key: string, value: Readonly<SessionVisionPolicy>): Promise<unknown>
  delete(key: string): Promise<unknown>
}

export interface SessionVisionPolicyStore {
  get(sessionId: string): Readonly<SessionVisionPolicy> | undefined
  set(sessionId: string, policy: SessionVisionPolicy): Promise<Readonly<SessionVisionPolicy>>
  delete(sessionId: string): Promise<void>
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function normalizedSessionId(value: unknown): string {
  const id = nonEmptyString(value)
  if (id === undefined) throw new TypeError('session vision policy requires a non-empty session id')
  return id
}

export function parseSessionVisionPolicy(value: unknown): Readonly<SessionVisionPolicy> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<PropertyKey, unknown>
  if (record.revision !== SESSION_VISION_POLICY_REVISION) return undefined
  if (typeof record.enabled !== 'boolean') return undefined
  if (record.source !== 'user' && record.source !== 'delegation') return undefined

  if (record.source === 'user') {
    if (record.inheritedFrom !== undefined) return undefined
    return Object.freeze({
      revision: SESSION_VISION_POLICY_REVISION,
      enabled: record.enabled,
      source: 'user',
    })
  }

  const inheritedFrom = nonEmptyString(record.inheritedFrom)
  if (inheritedFrom === undefined) return undefined
  return Object.freeze({
    revision: SESSION_VISION_POLICY_REVISION,
    enabled: record.enabled,
    source: 'delegation',
    inheritedFrom,
  })
}

export function userSessionVisionPolicy(enabled: boolean): Readonly<SessionVisionPolicy> {
  return Object.freeze({
    revision: SESSION_VISION_POLICY_REVISION,
    enabled,
    source: 'user',
  })
}

export function delegatedSessionVisionPolicy(
  enabled: boolean,
  parentSessionId: string,
): Readonly<SessionVisionPolicy> {
  return Object.freeze({
    revision: SESSION_VISION_POLICY_REVISION,
    enabled,
    source: 'delegation',
    inheritedFrom: normalizedSessionId(parentSessionId),
  })
}

/**
 * Own Session-scoped DVR intent independently of provider/model routing.
 *
 * The injected table is deliberately narrower than DSH storage-domain. This
 * module owns DVR policy semantics; the Host boundary that opens a durable
 * domain is a separate composition concern. A malformed persisted row fails
 * closed as absent policy so route-derived compatibility can remain the
 * migration fallback until the durable policy rollout is complete.
 */
export function createSessionVisionPolicyStore(
  table: SessionVisionPolicyTable,
): SessionVisionPolicyStore {
  return {
    get(sessionId) {
      const key = normalizedSessionId(sessionId)
      return parseSessionVisionPolicy(table.get(key))
    },

    async set(sessionId, policy) {
      const key = normalizedSessionId(sessionId)
      const normalized = parseSessionVisionPolicy(policy)
      if (normalized === undefined) {
        throw new TypeError('invalid session vision policy')
      }
      await table.put(key, normalized)
      return normalized
    },

    async delete(sessionId) {
      await table.delete(normalizedSessionId(sessionId))
    },
  }
}


/**
 * Process-scoped policy backend used while no durable Host sidecar is bound.
 *
 * The Map is closure-owned by the returned store, never process-global. It is
 * intentionally replaceable by a durable table without changing policy,
 * delegation, or authority semantics.
 */
export function createVolatileSessionVisionPolicyStore(): SessionVisionPolicyStore {
  const rows = new Map<string, Readonly<SessionVisionPolicy>>()
  return createSessionVisionPolicyStore({
    get(key) {
      return rows.get(key)
    },
    async put(key, value) {
      rows.set(key, value)
    },
    async delete(key) {
      rows.delete(key)
    },
  })
}

import { z } from 'zod'
import type {
  Domain,
  DomainSpec,
  KvTable,
} from '@deepseek-ai/dsh-storage-domain'

import {
  SESSION_VISION_POLICY_REVISION,
  parseSessionVisionPolicy,
  type SessionVisionPolicy,
  type SessionVisionPolicyStore,
} from './session-vision-policy.js'

const policySchema = z.discriminatedUnion('source', [
  z.object({
    revision: z.literal(SESSION_VISION_POLICY_REVISION),
    enabled: z.boolean(),
    source: z.literal('user'),
  }).strict(),
  z.object({
    revision: z.literal(SESSION_VISION_POLICY_REVISION),
    enabled: z.boolean(),
    source: z.literal('delegation'),
    inheritedFrom: z.string().trim().min(1),
  }).strict(),
])

/**
 * Plugin-owned Session sidecar. The shape intentionally satisfies DSH's
 * public DomainSpec contract without importing storage-domain at runtime:
 * older Hosts may not mount that optional capability at all.
 */
export const sessionVisionPolicyDomainSpec = {
  name: 'vision_router_session_policy',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    policies: {
      valueSchema: policySchema,
    },
  },
} as const satisfies DomainSpec

interface StorageDomainFacilityLike {
  open(spec: DomainSpec): Promise<Domain<DomainSpec>>
}

interface SessionVisionPolicyDomainContext {
  readonly storageDomain?: StorageDomainFacilityLike
  get?(name: string): unknown
  effect?(setup: () => (() => Promise<void> | void) | void, label?: string): unknown
  readonly logger?: {
    warn?(message: string, ...args: unknown[]): void
  }
}

export interface SessionVisionPolicyRuntimeStore extends SessionVisionPolicyStore {
  /** Whether this process still has a usable durable sidecar. */
  readonly durable: boolean
}

function normalizedSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('session vision policy requires a non-empty session id')
  }
  return value.trim()
}

function storageDomainOf(ctx: SessionVisionPolicyDomainContext): StorageDomainFacilityLike | undefined {
  // storageDomain is optional across the supported Host window. Reading the
  // Cordis service property without inject() turns capability detection into a
  // hard dependency; Context#get is the non-owning, live lookup seam here.
  try {
    const candidate = ctx.get?.('storageDomain') as StorageDomainFacilityLike | undefined
    return candidate && typeof candidate.open === 'function' ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Create a synchronous-read policy store with lazy official DSH sidecar
 * hydration. No storage capability means ordinary volatile operation.
 *
 * Once a storage failure is observed, this store degrades to volatile for the
 * rest of its lifetime. Vision availability must not depend on auxiliary
 * persistence health; a later process can retry the durable seam from scratch.
 */
export function createSessionVisionPolicyRuntimeStore(
  ctx: SessionVisionPolicyDomainContext,
): SessionVisionPolicyRuntimeStore {
  const cache = new Map<string, Readonly<SessionVisionPolicy>>()
  let domainPromise: Promise<Domain<DomainSpec>> | undefined
  let durableDisabled = false
  let warned = false
  let closeRegistered = false

  const warnDegraded = (error: unknown) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn?.(
        'vision-router: Session Vision policy persistence unavailable; using process-local fallback: %s',
        error instanceof Error ? error.message : String(error),
      )
    } catch {}
  }

  const disableDurability = (error: unknown) => {
    durableDisabled = true
    domainPromise = undefined
    warnDegraded(error)
  }

  const openDomain = async (): Promise<Domain<DomainSpec> | undefined> => {
    if (durableDisabled) return undefined
    const facility = storageDomainOf(ctx)
    if (facility === undefined) return undefined
    if (domainPromise === undefined) {
      domainPromise = facility.open(sessionVisionPolicyDomainSpec)
        .then((domain) => {
          if (!closeRegistered && typeof ctx.effect === 'function') {
            closeRegistered = true
            try {
              ctx.effect(
                () => () => domain.close(),
                'vision-router: Session Vision policy domain lifecycle',
              )
            } catch {
              // The facility itself closes leftovers on unmount.
            }
          }
          return domain
        })
        .catch((error) => {
          disableDurability(error)
          return undefined as never
        })
    }
    return await domainPromise
  }

  const table = async (): Promise<KvTable<string, SessionVisionPolicy> | undefined> => {
    const domain = await openDomain()
    if (domain === undefined) return undefined
    return domain.table('policies') as unknown as KvTable<string, SessionVisionPolicy>
  }

  return {
    get durable() {
      return !durableDisabled && storageDomainOf(ctx) !== undefined
    },

    get(sessionId) {
      return cache.get(normalizedSessionId(sessionId))
    },

    async hydrate(sessionId) {
      const key = normalizedSessionId(sessionId)
      const existing = cache.get(key)
      if (existing !== undefined) return existing
      try {
        const handle = await table()
        if (handle === undefined) return undefined
        const policy = parseSessionVisionPolicy(handle.get(key))
        if (policy !== undefined) cache.set(key, policy)
        return policy
      } catch (error) {
        disableDurability(error)
        return undefined
      }
    },

    async set(sessionId, policy) {
      const key = normalizedSessionId(sessionId)
      const normalized = parseSessionVisionPolicy(policy)
      if (normalized === undefined) throw new TypeError('invalid session vision policy')
      try {
        const handle = await table()
        if (handle !== undefined) await handle.put(key, normalized)
      } catch (error) {
        disableDurability(error)
      }
      cache.set(key, normalized)
      return normalized
    },

    async delete(sessionId) {
      const key = normalizedSessionId(sessionId)
      try {
        const handle = await table()
        if (handle !== undefined) await handle.delete(key)
      } catch (error) {
        disableDurability(error)
      }
      cache.delete(key)
    },
  }
}

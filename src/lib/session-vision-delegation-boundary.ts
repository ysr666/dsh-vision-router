import {
  materializeDelegatedSessionVisionPolicy,
  type ResolveSessionVisionAuthority,
  type SessionVisionDelegationAgent,
} from './session-vision-delegation.js'
import type { SessionVisionPolicyStore } from './session-vision-policy.js'

export interface SessionVisionDelegationAgentRegistry<A extends SessionVisionDelegationAgent> {
  currentInitiator(): A | undefined
  isOwnedBy(id: string, owner: A): boolean
}

export interface SessionVisionDelegationContext<A extends SessionVisionDelegationAgent> {
  readonly agents: SessionVisionDelegationAgentRegistry<A>
  on(
    event: 'agent/created',
    listener: (event: Readonly<{ agent: A }>) => Promise<void> | void,
  ): unknown
}

/**
 * Materialize inherited DVR authority for exact runtime-owned child Agents.
 *
 * DSH awaits serial `agent/created` listeners before releasing queued work,
 * so the snapshot is durable before the child can assemble its first prompt.
 * Runtime ownership is revalidated with `agents.isOwnedBy`; ambient initiator
 * presence alone is never treated as delegation authority.
 */
export function installSessionVisionDelegationBoundary<
  A extends SessionVisionDelegationAgent,
>(
  ctx: SessionVisionDelegationContext<A>,
  store: SessionVisionPolicyStore,
  resolveParentAuthority: ResolveSessionVisionAuthority<A>,
): void {
  ctx.on('agent/created', async ({ agent: child }) => {
    const parent = ctx.agents.currentInitiator()
    if (parent === undefined || parent.id === child.id) return
    if (!ctx.agents.isOwnedBy(child.id, parent)) return

    await materializeDelegatedSessionVisionPolicy(
      store,
      parent,
      child,
      resolveParentAuthority,
    )
  })
}

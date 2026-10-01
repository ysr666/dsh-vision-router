import { materializeDelegatedSessionVisionPolicy, } from './session-vision-delegation.js';
/**
 * Materialize inherited DVR authority for exact runtime-owned child Agents.
 *
 * DSH awaits serial `agent/created` listeners before releasing queued work,
 * so the snapshot is durable before the child can assemble its first prompt.
 * Runtime ownership is revalidated with `agents.isOwnedBy`; ambient initiator
 * presence alone is never treated as delegation authority.
 */
export function installSessionVisionDelegationBoundary(ctx, store, resolveParentAuthority) {
    ctx.on('agent/created', async ({ agent: child }) => {
        const parent = ctx.agents.currentInitiator();
        if (parent === undefined || parent.id === child.id)
            return;
        if (!ctx.agents.isOwnedBy(child.id, parent))
            return;
        await materializeDelegatedSessionVisionPolicy(store, parent, child, resolveParentAuthority);
    });
}

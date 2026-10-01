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
    const currentInitiator = ctx.agents?.currentInitiator;
    const isOwnedBy = ctx.agents?.isOwnedBy;
    const on = ctx.on;
    if (typeof currentInitiator !== 'function'
        || typeof isOwnedBy !== 'function'
        || typeof on !== 'function') {
        return false;
    }
    on.call(ctx, 'agent/created', async ({ agent: child }) => {
        if (typeof store.hydrate === 'function') {
            await store.hydrate(child.id);
        }
        const parent = currentInitiator.call(ctx.agents);
        if (parent === undefined || parent.id === child.id)
            return;
        if (!isOwnedBy.call(ctx.agents, child.id, parent))
            return;
        if (typeof store.hydrate === 'function') {
            await store.hydrate(parent.id);
        }
        await materializeDelegatedSessionVisionPolicy(store, parent, child, resolveParentAuthority);
    });
    return true;
}

import { delegatedSessionVisionPolicy, } from './session-vision-policy.js';
/**
 * Materialize one child-local DVR policy snapshot at the delegation boundary.
 *
 * Child-local durable truth wins when it already exists. Otherwise the direct
 * parent's durable policy wins over route-derived compatibility authority, and
 * the resulting enabled bit is copied into the child as a delegation snapshot.
 * Later parent changes therefore cannot retroactively mutate an existing child.
 */
export async function materializeDelegatedSessionVisionPolicy(store, parent, child, resolveParentAuthority) {
    if (parent.id === child.id) {
        throw new TypeError('Session Vision delegation requires distinct parent and child ids');
    }
    const existing = store.get(child.id);
    if (existing !== undefined) {
        return Object.freeze({ status: 'existing', policy: existing });
    }
    const parentPolicy = store.get(parent.id);
    const enabled = parentPolicy?.enabled ?? resolveParentAuthority(parent).enabled;
    const policy = await store.set(child.id, delegatedSessionVisionPolicy(enabled, parent.id));
    return Object.freeze({ status: 'materialized', policy });
}

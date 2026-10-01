import { z } from 'zod';
import { SESSION_VISION_POLICY_REVISION, parseSessionVisionPolicy, } from './session-vision-policy.js';
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
]);
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
};
function normalizedSessionId(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('session vision policy requires a non-empty session id');
    }
    return value.trim();
}
function storageDomainOf(ctx) {
    if (ctx.storageDomain && typeof ctx.storageDomain.open === 'function')
        return ctx.storageDomain;
    try {
        const candidate = ctx.get?.('storageDomain');
        return candidate && typeof candidate.open === 'function' ? candidate : undefined;
    }
    catch {
        return undefined;
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
export function createSessionVisionPolicyRuntimeStore(ctx) {
    const cache = new Map();
    let domainPromise;
    let durableDisabled = false;
    let warned = false;
    let closeRegistered = false;
    const warnDegraded = (error) => {
        if (warned)
            return;
        warned = true;
        try {
            ctx.logger?.warn?.('vision-router: Session Vision policy persistence unavailable; using process-local fallback: %s', error instanceof Error ? error.message : String(error));
        }
        catch { }
    };
    const disableDurability = (error) => {
        durableDisabled = true;
        domainPromise = undefined;
        warnDegraded(error);
    };
    const openDomain = async () => {
        if (durableDisabled)
            return undefined;
        const facility = storageDomainOf(ctx);
        if (facility === undefined)
            return undefined;
        if (domainPromise === undefined) {
            domainPromise = facility.open(sessionVisionPolicyDomainSpec)
                .then((domain) => {
                if (!closeRegistered && typeof ctx.effect === 'function') {
                    closeRegistered = true;
                    try {
                        ctx.effect(() => () => domain.close(), 'vision-router: Session Vision policy domain lifecycle');
                    }
                    catch {
                        // The facility itself closes leftovers on unmount.
                    }
                }
                return domain;
            })
                .catch((error) => {
                disableDurability(error);
                return undefined;
            });
        }
        return await domainPromise;
    };
    const table = async () => {
        const domain = await openDomain();
        if (domain === undefined)
            return undefined;
        return domain.table('policies');
    };
    return {
        get durable() {
            return !durableDisabled && storageDomainOf(ctx) !== undefined;
        },
        get(sessionId) {
            return cache.get(normalizedSessionId(sessionId));
        },
        async hydrate(sessionId) {
            const key = normalizedSessionId(sessionId);
            const existing = cache.get(key);
            if (existing !== undefined)
                return existing;
            try {
                const handle = await table();
                if (handle === undefined)
                    return undefined;
                const policy = parseSessionVisionPolicy(handle.get(key));
                if (policy !== undefined)
                    cache.set(key, policy);
                return policy;
            }
            catch (error) {
                disableDurability(error);
                return undefined;
            }
        },
        async set(sessionId, policy) {
            const key = normalizedSessionId(sessionId);
            const normalized = parseSessionVisionPolicy(policy);
            if (normalized === undefined)
                throw new TypeError('invalid session vision policy');
            try {
                const handle = await table();
                if (handle !== undefined)
                    await handle.put(key, normalized);
            }
            catch (error) {
                disableDurability(error);
            }
            cache.set(key, normalized);
            return normalized;
        },
        async delete(sessionId) {
            const key = normalizedSessionId(sessionId);
            try {
                const handle = await table();
                if (handle !== undefined)
                    await handle.delete(key);
            }
            catch (error) {
                disableDurability(error);
            }
            cache.delete(key);
        },
    };
}

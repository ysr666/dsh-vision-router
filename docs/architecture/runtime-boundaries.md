# Runtime boundaries

This document freezes the ownership boundaries that must remain true during the dsh-vision-router 2.x convergence work. P0 does not redesign routing behavior; it makes the existing product contract explicit so later refactors cannot accidentally move authority or lifecycle ownership.

## Dependency direction

The intended runtime direction is:

```text
Authority -> Evidence -> Planner -> Execution
                    \-> Presentation (read-only projection)
Session / Storage / Compat are supporting boundaries, not alternate policy owners.
```

Execution may consume a plan and live authority. It must not synthesize broader authority than the plan was allowed to use. Presentation may render state. It must not re-derive routing eligibility independently.

## Authority

**Owns:** authorization to perform behavior with user/resource/security consequences.

Examples:
- whether Auto routing is currently authorized;
- whether background capability measurement is allowed;
- whether paid background work is allowed;
- whether remote settings mutation is allowed.

Rules:
- absence of authority is denial, not an invitation to infer intent;
- authority is checked at the point where work begins and, for revocable operations, again before publication/continuation;
- evidence, planner scores, cached state, UI state, or compatibility shims may never grant authority.

## Evidence

**Owns:** observed model/provider capability facts and their scope, freshness and persistence policy.

Rules:
- evidence says what has been observed, not what the user authorized;
- durable capability evidence is kept separate from process-local runtime performance;
- negative evidence and uncertainty must remain distinguishable;
- evidence collection may not mutate settings or route order merely to make planning easier.

## Planner

**Owns:** pure selection/ranking from authorized candidates plus evidence and preference inputs.

Rules:
- no provider network I/O;
- no persistence writes;
- no settings mutation;
- no Host service registration;
- no authority expansion;
- output is data describing an execution choice/order, not a disguised settings object.

The existing `vision-capability-router.js` is the productized planner. P1 converges how its output reaches execution; P0 does not create a second planner.

## Execution

**Owns:** performing the selected visual work under deadlines, fallback, breaker, cancellation and provider/runtime contracts.

Rules:
- consumes authorized candidates/plan; cannot add a provider that was not already eligible;
- cannot reinterpret planner output as permission;
- preserves native multimodal non-intervention when the Host/model owns image input;
- cancellation and authority revocation must not publish stale work;
- compatibility adaptation stays narrow to the Host seam actually missing.

## Session

**Owns:** durable conversation/session facts that need to survive process restart, plus explicitly bounded process-local projections used to execute the current session safely.

Rules:
- durable Host/session facts and process-local caches are different lifetimes;
- a process-local store is not a second source of truth for durable conversation identity;
- restart/resume correctness is part of the product contract;
- do not replace `SessionVisionStateStore` in P0/P1 merely for architectural symmetry.

## Storage

**Owns:** attachment/artifact placement, retention and deletion safety.

Two classes must remain distinct:
- **Host-owned attachments:** durable identities/content governed by the DSH attachment service;
- **Vision Router derived artifacts:** temporary or managed outputs created by plugin operations.

Rules:
- never delete unknown/user-owned entries;
- no P0 artifact layout migration;
- storage cleanup may use only plugin-owned namespaces/provenance;
- `.run-meta.json` is not introduced as part of P0.

## Compat

**Owns:** the smallest translation necessary when a supported Host contract lacks a seam required by the product contract.

Rules:
- capability detection first; version-persona branching last resort;
- every major shim records Reason, Host gap, First needed for, Feature detection, Removal condition and Tests;
- compat may preserve existing semantics but must not invent new routing authority;
- a shim is removed only after the supported Host window and tests prove the native seam covers it.

See `dsh-compatibility-matrix.md` for the inventory and exit criteria.

## Presentation

**Owns:** user-visible projection and interaction surfaces.

Rules:
- UI does not own route eligibility, authority, breaker state, credential validity or evidence validity;
- presentation consumes structured product/runtime state instead of recreating routing rules in browser code;
- P0 does not split the Web UI; it only freezes this ownership rule for later P3 work.

## P0 invariants

The following are deliberate stop conditions for any P0 change:

- Auto or Ordered routing behavior changes;
- authority becomes broader than before;
- native multimodal requests are newly intercepted;
- session restart/resume semantics change;
- artifact layout or cleanup scope changes;
- background scheduler is migrated to `ctx.jobs`;
- `vision-capability-shadow.js` execution flow is split or rewritten.

P0 is complete when the Host contract gates, compatibility inventory, Doctor capability snapshot, runtime-boundary documentation and logical test groups are all present while the existing behavior remains unchanged.

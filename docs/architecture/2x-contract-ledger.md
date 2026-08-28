# 2.x Architecture Closure Contract Ledger

Status: **normative for Post-P3 closure**

Baseline main: `1f78443a75e76a8fbba5d90a305e8c53db93bb7f`

This ledger freezes the externally observable and cross-boundary contracts that the 2.x Architecture Closure is not allowed to change while ownership is being simplified.

The closure is a structural migration, not a product feature release. A cleaner dependency graph is not a valid reason to change user-visible behavior, Host persistence, routing semantics, authority, provider order, failure policy, or compatibility support.

## Closure method

Every semantic-owner migration follows the same order:

1. **Characterize** the existing behavior and public/Host contract.
2. **Add** the new internal path without deleting the old path.
3. **Compare** old and new decisions in tests; the old path remains the parity oracle.
4. **Switch** production ownership only after parity is complete.
5. **Delete** the old implementation and rerun the same gates after deletion.
6. **Merge**, then rerun the relevant gates on `main`.

A green test run while the old path can still silently rescue the new path is not deletion proof.

## External contract — frozen during Closure

| Surface | Frozen contract |
|---|---|
| package entry | package root continues to resolve through `lib/public-entry.js` |
| plugin identity | `vision-router` remains the plugin name |
| settings namespace | `vision-router` remains the Host settings namespace |
| settings contract revision | existing 2.0.x field meanings/defaults remain unchanged unless a separate product change is approved |
| routing mode | `ordered` remains the safe default; `auto` requires live authority |
| routing preference | `balanced`, `quality`, `speed`, `local` retain their existing meaning |
| background measurement | `off`, `local-free`, `all` remain separate authority states; absence does not grant work |
| route identity | existing wrapper/chain/provider route names and aliases remain compatible |
| tools | existing tool names, argument schemas, result shapes and error classes remain compatible |
| native multimodal | native image ownership remains non-intervention for automatic Router orchestration; explicit Router tools are not disabled merely because a model is native multimodal |
| fallback | execution may reorder only already-eligible candidates; it may not invent a provider or delete a configured/local/discovered fallback |
| session persistence | no new Host Session event type or durable index format is introduced by Closure |
| session surface repair | existing `surfaceOp: { op: 'replace' }` and `sourceEventSeqs` semantics remain compatible |
| attachment identity | durable attachment ids remain Host/session identities; no cross-session lookup is introduced |
| artifact publication | existing public derived-artifact paths/return values remain compatible; managed run cleanup remains confined to Router-owned provenance/namespaces |
| proxy setting | existing proxy/proxyHosts behavior remains compatible; Router-owned HTTP stays independent of process-global fetch mutation |
| Doctor | Closure does not turn advisory architecture/support diagnostics into new failure exit codes |
| support window | DVR 2.0.x continues to support the published minimum/previous/current DSH window; rc.6 support is not removed by a patch-level closure |
| runtime platforms | Node 22/24 and the existing Ubuntu/macOS/Windows host-sharp contract remain supported |

## Internal ownership target

Closure may change implementation only toward this dependency direction:

```text
Authority -> Evidence -> Planner -> Execution
                    \-> Host product projection -> Presentation

SessionVisionRuntime
  |- SessionVisionStateStore   (bounded process-local state)
  `- SessionVisionIndex        (durable-log indexing/recovery/surface repair)

VisionArtifactStore            (derived artifact ownership)
VisionProviderTransport        (Router-owned provider HTTP)
Compat                         (only supported Host/provider gaps with exit criteria)
```

### Single-owner rules

The final closure must make these statements true:

- routing authority has one production owner;
- planner output is data, never a disguised Settings object;
- session durable-log indexing/targeted recovery/surface repair has one production implementation;
- a Session store is not discovered through an implicit process-global "current" owner;
- browser code renders Host product decisions instead of re-deriving routing/background authority or eligibility;
- Router-owned provider HTTP has one transport boundary;
- compatibility shims translate supported gaps but do not own product policy.

## C1 — Session/Core policy convergence contract

Allowed changes:

- add one narrow internal SessionVisionRuntime dependency to core composition;
- make SessionVisionIndex the sole owner of event-log scan, targeted attachment recovery and surface repair;
- replace SessionSurfacePolicy -> fake Settings projection with explicit derived runtime flags;
- remove obsolete current-store/service-locator and store monkey-patching after parity proof.

Forbidden changes:

- cache size/TTL changes;
- attachment-id semantics;
- Session event format changes;
- new persistence files;
- route/provider/tool policy changes;
- native-image ownership changes;
- timeout/retry/budget changes.

**Stop condition:** if the migration starts requiring provider/routing/artifact redesign or broad public/core API churn beyond one narrow optional runtime dependency, stop and redesign rather than pursuing DI purity.

## C2 — Presentation convergence contract

Host owns decisions; browser owns presentation and user interaction.

The stable presentation DTO should be additive and versioned. It may expose decisions such as:

- `canBenchmark` / `benchmarkReason`;
- `capabilityState`;
- `healthClass`;
- `backgroundEligible` / `backgroundReason`;
- routing/authority summaries safe for presentation.

The DTO must not expose credentials, credential references, raw endpoints/fingerprints solely for internal execution, mutable breaker internals, or evidence objects that require the browser to reinterpret validity.

Prefer extending an existing benchmark/runtime snapshot over creating another long-lived polling surface. Existing 2.0.x routes are removed only under the normal compatibility/version policy.

## C3 — Bounded cleanup contract

Mandatory low-risk cleanup:

- retire obsolete capability-shadow naming/shim once no production consumer remains;
- remove stale migration comments whose stated deletion phase has passed;
- ensure every retained compatibility seam has Reason, Host gap, Feature detection, Removal condition and Tests.

Conditional cleanup:

- remove the VisionProviderTransport module registry only if explicit injection has a small, local change radius and does not broaden public/core signatures materially;
- otherwise document a concrete later removal trigger and retain the working boundary.

Not a closure target:

- deleting legitimate rc.6/rc.8 compatibility merely to reduce file count;
- deleting `vision-chain`;
- rewriting the mature core for LOC reduction;
- migrating the scheduler to `ctx.jobs` without the already-defined GO criteria;
- changing artifact layout again.

## Mandatory validation after each semantic switch

At minimum, the affected slice must retain coverage for:

- Ordered exact behavior;
- Auto exact behavior and live authority revoke/recheck;
- fallback preservation and stale-plan filtering;
- native multimodal non-intervention;
- text-only/plugin-owned/unknown image ownership;
- Session restart/cold resume;
- bounded-cache target recovery;
- same-session and cross-session concurrency;
- cancellation/no ALS leak;
- artifact retention and unknown-entry preservation;
- Router-owned HTTP independence from the global fetch patch;
- remote/local settings behavior;
- Node 22 and Node 24;
- minimum/previous/current DSH contract;
- platform/resource gates relevant to the changed boundary.

## Closure completion rule

The architecture is not declared CLOSED merely because C1/C2/C3 PRs merge. After deletion of the old paths, run one final adversarial audit on the resulting `main` and prove:

1. one semantic owner per boundary;
2. no duplicate production algorithm can still rescue the replacement;
3. every remaining compatibility seam has a currently reachable supported case or an explicit removal trigger;
4. adding a new modality (PDF/video/1+x) does not require a new Settings impersonation layer, process-global runtime locator, duplicate Session cache/index, or browser-owned authority algorithm;
5. the full regression/contract/stress/security matrix is green on merged `main`.

Only then mark **2.x architecture convergence: CLOSED**.

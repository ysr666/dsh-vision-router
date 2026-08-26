# DSH compatibility matrix

This document is the P0 compatibility baseline for dsh-vision-router 2.x.

The matrix is capability-based. Runtime code must feature-detect the seam it needs; it must not branch on a DSH version string merely to select a behavior. Version labels below name the CI fixtures that prove each capability.

## Gating fixtures

| CI fixture | DSH package line | Role |
| --- | --- | --- |
| `minimum-contract` | `0.1.0-rc.6` | Minimum supported Host contract. Must remain green. |
| `legacy-contract` | `0.1.0-rc.8` | Legacy contract carrying batch attachments and dimension policy. |
| `current-contract` | `0.1.1-rc.2` | Current contract baseline for 2.x convergence. Must be green before P1. |
| `latest-dsh` | resolved dynamically from npm | Scheduled canary only. Never a normal PR required check. |

Node 22 and Node 24 remain the general required runtime matrix. The Host contract jobs are additive; they do not replace the normal test matrix.

## Capability matrix

`yes` means the fixture has a direct positive test or feature probe. `no` means a direct negative probe exists. `compat` means the fixture proves Vision Router can safely carry the newer input/config through that Host, but does **not** claim the Host owns that capability. `probe` means the capability is intentionally not inferred from the version label and is verified at runtime/contract-test time.

| Capability | minimum-contract rc.6 | legacy-contract rc.8 | current-contract rc.2 | Evidence / detection |
| --- | --- | --- | --- | --- |
| Batch attachment save | no | yes | yes | `hasBatchAttachmentContract()` checks the released `attachments.saveImages` prototype; `tests/rc6-rc7-compat.test.js`; contract CI. |
| Max image dimension policy | compat | yes | yes | All fixtures parse the complete attachment-local row; rc.8/current positively retain the field and the established admission tests exercise the 10000/10001 boundary. Older Schemastery passthrough is not treated as ownership evidence. |
| Adapter registration | yes | yes | yes | released `ctx.llm.registerAdapter` surface plus adapter contract tests. |
| Atomic registration replace | probe | probe | yes | current-contract exercises the real registration handle's `replace()` and disposer; Doctor reports `unknown` if a live Host cannot prove replacement without mutating topology. |
| Settings live namespace | yes | yes | yes | `settings.register()` + live `scope.get()/watch()` compatibility tests; current-contract mounts the real SettingsProvider contract through a minimal storage subclass. |
| Tool registration / execution | probe | probe | yes | current-contract mounts the released `@deepseek-ai/dsh-tools` runtime, registers a typed tool, executes it, and disposes it; Vision Router tool-runtime boundary tests remain additive. |
| `prepareCall` | no | no | yes | `tests/adapter-prepare-call-compat.test.js`; current-contract exercises the installed LLM runtime's `prepareCall()`. |
| Native image coexistence | yes | yes | yes | `tests/native-image-coexistence.test.js`, `tests/issue-289-native-nonintervention.test.js`, cold-resume workflow. |
| Jobs service | probe | probe | probe | read-only Doctor capability probe only; P2 must run a separate feasibility spike before any scheduler migration. |
| Client surface replacement | probe | probe | probe | no version inference; keep `unknown` until a safe readable Host seam is available. |
| Settings web exposure | probe | probe | probe | presentation capability; never inferred from the settings persistence service. |
| Effect/dispose cleanup | yes | yes | yes | compatibility lifecycle tests plus current-contract adapter/tool/watch disposer checks; plugin registrations remain Cordis-effect owned. |
| Public entry boot | yes | yes | yes | packed plugin public entry import in each Host contract fixture. |
| Packaged tarball install | yes | yes | yes | each Host contract fixture packs the plugin then installs the tarball into an isolated Host package. |

## Compatibility inventory and exit criteria

Every compatibility seam must answer the same six questions: **Reason**, **Host gap**, **First needed for**, **Feature detection**, **Removal condition**, and **Tests**. Source modules carry the detailed annotation; this table is the architectural index.

| Seam | Reason / Host gap | Feature detection | Removal condition | Primary tests |
| --- | --- | --- | --- | --- |
| `lib/dsh-contract-compat.js` | Keep rc.6 single-attachment behavior, rc.8 attachment overlay repair, and settings/provider ownership semantics across the support window. | attachment/settings/LLM methods, never a version string. | Supported Host window provides the needed public seams natively and minimum supported DSH advances beyond the gap. | `rc6-rc7-compat`, `rc6-real-settings-persistence`, `attachment-admission-policy`, contract CI. |
| `lib/adapter-update-coalescer.js` | Older Vision Router adapters are duck-typed while DSH 0.1.1 dispatches through `prepareCall`; synchronous topology events can re-enter reconciliation. | adapter has `prepareCall`; event behavior is bounded by the coalescer. | All supported adapters implement the Host contract directly and no supported Host needs the reconciliation guard. | `adapter-prepare-call-compat`, adapter/runtime regression tests. |
| `lib/android-attachment-compat.js` | Termux/Android file persistence can fail at the permission boundary on the minimum Host contract. | actual Android/Termux environment plus permission-boundary failure and absence of batch attachment ownership. | Minimum supported Host owns a working Android attachment store for this path. | `android-attachment-compat`, resource tests. |
| `lib/replay-envelope-v2-compat.js` | Durable replay producer identity moved into the v2 replay envelope. | exact `response.kind === 'pi-ai' && response.version === 2` producer proof. | Support window no longer contains histories/runtime needing the old source normalization. | `replay-delegation`, replay/session tests. |
| `lib/pi-ai-bridge-wire-compat.js` | The legacy direct image bridge predates pi-ai declared wire compatibility. | exact non-streaming image bridge fingerprint and resolved pi-ai route/model facts. | Direct bridge is removed or every supported Host executes the request through the native pi-ai wire contract. | `pi-ai-bridge-wire-compat`, native process-restart contract. |
| `lib/settings-client-rc8-lifecycle.js` | Browser-side settings lifecycle differs across supported Host generations. | browser/runtime surface behavior, not DSH version parsing. | Support window exposes one stable settings client lifecycle. | settings IA/lifecycle regression tests. |

## Rules

1. A new version-specific branch requires evidence that no stable capability probe exists.
2. A compatibility layer may narrow behavior to preserve an existing product contract; it may not expand routing authority.
3. `latest-dsh` can reveal upstream drift, but a canary failure must not silently redefine the supported contract.
4. P1 may begin only when all three gating fixtures and the existing cold-resume/resource baselines are green.

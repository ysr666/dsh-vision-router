# 2.x Architecture Closure — final adversarial audit

Audit baseline: `main@1c11c1c3c7046268ae1c7b8f2287b023aeb1eb26` (after C3-B / PR #339).

This document records the final adversarial architecture review. It is not a feature roadmap and does not claim that PDF, video, CAD or GUI-agent support exists. The final `CLOSED` declaration is allowed only after the accompanying final Closure gate is merged and the resulting `main` gates are green.

## Severity result

| Severity | Structural blockers |
| --- | ---: |
| High | 0 |
| Medium | 0 |

No remaining finding establishes a second semantic owner for Authority, routing, Session recovery/surface repair, Artifact storage, Router-owned provider HTTP, Host product decisions, or browser presentation.

## Single-owner result

| Semantic responsibility | Current owner | Permanent evidence |
| --- | --- | --- |
| User routing/background authority | `lib/vision-routing-authority.js` | P1 routing parity + Architecture Closure |
| Capability evidence collection | `lib/vision-routing-evidence.js` | routing evidence/runtime parity |
| Capability planning/scoring | `lib/vision-capability-router.js` | P1 routing parity |
| Scoped execution order | `lib/vision-execution-order.js` | execution-order wiring/parity |
| Session indexing, durable recovery and surface repair | `lib/session-vision-index.js` | `session-runtime-core-wiring.test.js` |
| Session bounded state | `lib/session-vision-state.js` | Session runtime/state integration gates |
| Managed artifact publication/lifetime | `lib/vision-artifact-store.js` | artifact boundary/store gates |
| Router-owned provider HTTP | `lib/vision-provider-transport.js` | P2 provider-transport gates |
| Host product/presentation decisions | `lib/vision-product-presentation.js` | presentation convergence/switch gates |
| Browser rendering | Web benchmark client/panel | browser second-owner algorithms are forbidden by `presentation-switch.test.js` |

## Duplicate-owner adversarial checks

### Session

- Production creates one explicit `SessionVisionRuntime` and supplies the same index owner to the Session boundary and Core.
- `currentSessionVisionStateStore`, module-global `currentStore`, lookup monkey-patching and the old Core scan/recovery/surface-repair algorithms are forbidden by the Closure suite.
- Repository search at the audit baseline finds `currentSessionVisionStateStore` only inside the test that forbids its return.

Result: **PASS**.

### Core policy / Settings impersonation

`legacy-core-vision-policy-bridge.js` retains only two real pre-step compatibility behaviors. The Closure suite forbids projected Settings/config/scope/child views and forbids interception of `ctx.get('settings')` or injected Settings children.

Result: **PASS**.

### Browser product ownership

The browser consumes Host candidate `presentation` state. The final switch gate forbids browser implementations of background eligibility, deferred/excluded interpretation, measured-text-only inference and the retired runtime-status fetch/switch shim.

Result: **PASS**.

### Capability shadow

`lib/vision-capability-shadow.js` and its historical test path are deleted. A recursive gate forbids imports of the retired shadow surface from production, tests or scripts.

Result: **PASS**.

## Compatibility result

The normative compatibility inventory now requires every retained seam to document:

- reason;
- Host/internal gap;
- feature/capability detection;
- removal condition;
- tests.

The inventory-completeness gate covers 11 retained seams.

Two notable retained items are intentionally **not blockers**:

1. `legacy-core-vision-policy-bridge.js` remains for the two supported pre-step behaviors described above.
2. `vision-provider-transport.js` retains one scoped process/profile registry because mature OpenAI-compat and Anthropic catalog-correction callers still read `currentVisionProviderTransport()`. Its install/release lifecycle and deletion trigger are explicit.

A repository-wide audit of the exact `const installed = []` pattern found only the inventoried VisionProviderTransport registry. The retired Session current-owner locator is absent from production.

Result: **PASS / justified compatibility only**.

## Future-modality tabletop

The Closure architecture is tested against hypothetical future additions:

- PDF;
- video;
- CAD screenshot;
- GUI agent;
- `1+X` structured-first / free-follow-up vision.

These are architecture scenarios, not implemented features.

An acceptable future change may add:

- capability vocabulary;
- evidence/intent mapping;
- an operation/tool or model path;
- presentation state when needed.

The tabletop fails if the feature proposal requires a new semantic infrastructure owner such as:

- Settings proxy/impersonation;
- new context wrapper carrying internal policy semantics;
- new module-global runtime registry;
- new Session cache/owner;
- new Host patch or lifecycle exception used to bypass existing owners.

`tests/final-architecture-closure.test.js` also binds the tabletop to the real current owner modules and recursively checks production for hidden module-global `current*` owners and unregistered `installed[]` registries.

Result at audit design time: **PASS, pending final PR/main execution**.

## Long-term anti-regression gate

Architecture Closure permanently carries these constituent gates:

- external/cross-boundary contract baseline;
- compatibility inventory completeness;
- Settings impersonation closure;
- Host-presentation/browser switch closure;
- capability-shadow retirement;
- Session runtime/Core single-owner wiring;
- final owner/tabletop/runtime-locator closure gate.

This deliberately protects ownership/dependency direction rather than trying to make every occurrence of words such as `legacy`, `Proxy` or `current` illegal.

## Regression evidence on the C3-B merged baseline

Exact baseline: `1c11c1c3c7046268ae1c7b8f2287b023aeb1eb26`.

- Architecture Closure: run `33258346425`, Node 22/24 success.
- P3 Compatibility Convergence: run `33258346400`, Node 22/24 success.
- DSH Contract: run `33258346423`, minimum/legacy/current success.
- P1 Routing Parity: run `33258346406`, Node 22/24 success.
- P2 Data Boundary: run `33258346424`, all Node 22/24 boundary jobs success.
- Native multimodal cold resume: run `33258346404`, rc.7/rc.8 on Node 22/24 success.
- CI: run `33258346403`, Node 22/24, rc.6/rc.7/rc.8 and Ubuntu/macOS/Windows success.
- CodeQL: run `33258346338`, Actions and JavaScript/TypeScript analyses success.

## Final decision rule

At this baseline the adversarial audit has **zero High/Medium structural blockers**. Architecture convergence must not be declared closed merely from this document or from a green PR.

Closure becomes final only when:

1. the future-modality/runtime-locator gate in this final PR passes;
2. the final PR is merged normally;
3. the resulting `main` SHA passes the required and Architecture Closure gates (plus the normal regression/security matrix triggered by the change).

After those conditions are met, stop architecture convergence rather than continuing purity refactors. Future PDF/video/1+X work belongs to product PRs that must respect these owner boundaries.

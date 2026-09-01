# Compatibility seam inventory

P0 records why each major compatibility seam exists and the condition that permits its removal. This inventory is normative for 2.x convergence: a shim without an exit criterion is architectural debt that cannot silently become permanent.

## `lib/dsh-contract-compat.js`

- **Reason:** preserve released attachment/settings/provider-ownership behavior across the supported DSH window.
- **Host gap:** rc.6 has the single-attachment contract; later Hosts add batch save, max-dimension policy and newer settings/provider lifecycle behavior.
- **First needed for:** minimum rc.6 support and the subsequent rc.7/rc.8 attachment migration.
- **Feature detection:** `attachments.saveImages`, attachment `imageLimits`, settings registration/scope functions, and LLM registration methods. No version-string branch.
- **Removal condition:** minimum supported DSH natively exposes the required attachment/settings/provider seams and legacy profile overlays are outside support.
- **Tests:** `rc6-rc7-compat`, `rc6-real-settings-persistence`, `attachment-admission-policy`, `dsh-host-capabilities`, minimum/legacy/current contract CI.

## `lib/adapter-update-coalescer.js`

- **Reason:** keep Vision Router-owned duck-typed adapters compatible with Host `prepareCall` dispatch and prevent synchronous adapter-topology events from recursively reconciling forever.
- **Host gap:** older plugin adapters do not inherit the Host adapter base class; supported Host generations can emit adapter updates synchronously during registration.
- **First needed for:** DSH 0.1.1 `prepareCall` and atomic registration behavior.
- **Feature detection:** adapter-local `prepareCall` presence; actual `llm/adapters-updated` event path. No version inference.
- **Removal condition:** every supported Vision Router adapter directly satisfies the Host adapter contract and supported Host event semantics no longer require the bounded coalescer.
- **Tests:** `adapter-prepare-call-compat`, `runtime-boundary-fixes`, current-contract Host smoke.

## `lib/android-attachment-compat.js`

- **Reason:** allow the minimum Host path to survive Termux/Android attachment persistence permission boundaries without taking ownership on batch-capable Hosts.
- **Host gap:** file-backed attachment storage can fail with `EACCES`/`EPERM` in Android/Termux environments on the legacy path.
- **First needed for:** Android/Termux support while rc.6 remains minimum.
- **Feature detection:** Android/Termux environment, permission-boundary error and absence of the batch attachment contract.
- **Removal condition:** minimum supported DSH owns a working Android attachment implementation for the same path and the fallback is no longer reachable.
- **Tests:** `android-attachment-compat`, image-resource/resource-retention tests.

## `lib/replay-envelope-v2-compat.js`

- **Reason:** preserve delegated replay identity when producer provider/model moved into durable pi-ai replay envelope v2.
- **Host gap:** older Vision Router replay code expected producer identity at the top level.
- **First needed for:** rc.7 replay-envelope v2 histories.
- **Feature detection:** exact durable producer proof: `response.kind === 'pi-ai'`, `response.version === 2`, provider and model match.
- **Removal condition:** the supported runtime/history window no longer includes envelopes requiring source rebinding, or the Host exposes an equivalent native replay identity seam consumed directly by Vision Router.
- **Tests:** `replay-delegation`, session/cold-resume regression coverage.

## `lib/pi-ai-bridge-wire-compat.js`

- **Reason:** make the legacy direct image bridge transport-equivalent to pi-ai declared wire compatibility without reading credentials or changing provider priority.
- **Host gap:** the direct bridge predates route/model wire metadata such as max-token fields and route-owned headers.
- **First needed for:** DSH 0.1.1 pi-ai declared provider/wire compatibility.
- **Feature detection:** exact non-streaming OpenAI-compatible image bridge fingerprint plus resolved route/model facts; normal streaming Host traffic does not match.
- **Removal condition:** the direct bridge is removed or every supported Host executes this image path through the native pi-ai wire seam.
- **Tests:** `pi-ai-bridge-wire-compat`, native process-restart/cold-resume contract.

## `lib/settings-client-rc8-lifecycle.js`

- **Reason:** keep browser settings lifecycle coherent across legacy and current Host client generations.
- **Host gap:** settings client attachment/replacement lifecycle is not identical across the support window.
- **First needed for:** rc.8-era settings UI coexistence.
- **Feature detection:** actual client/runtime lifecycle surfaces; never the Host version label.
- **Removal condition:** supported Hosts expose one stable settings client lifecycle and the compatibility branch is proven unreachable by contract tests.
- **Tests:** settings IA, client lifecycle, remote-settings and Web acceptance regressions.

## `lib/http-compat.js`

- **Reason:** isolate evidenced provider/model wire quirks from generic visual HTTP execution.
- **Host gap:** this is provider compatibility rather than a DSH Host gap; some OpenAI-compatible endpoints reject otherwise valid generic payload shapes.
- **First needed for:** model-family quirks such as GLM-4V-Flash output limits and image-only message handling.
- **Feature detection:** provider/model/url rule predicates backed by known wire behavior.
- **Removal condition:** upstream endpoint behavior becomes generic-compatible for a rule and regression evidence confirms the preset is no longer needed.
- **Tests:** `http-compat`, provider HTTP regression tests.

## `lib/vision-provider-transport.js` process/profile registry

- **Reason:** carry the Router-owned provider transport into compatibility callers whose mature function signatures still accept only a raw `fetch` or use an internal direct HTTP call, while keeping Router traffic off the process-global fetch patch.
- **Host gap:** this is an internal composition gap rather than a DSH version persona: `fetchWithOpenAICompatibility(...)` and the Anthropic catalog-correction path do not yet receive a `VisionProviderTransport` parameter explicitly.
- **First needed for:** provider-scoped transport ownership and proxy narrowing without rewriting the mature compatibility call signatures in the same migration.
- **Feature detection:** explicit transport-aware callers bypass the registry; only compatibility paths that call `currentVisionProviderTransport()` consume the currently installed process/profile transport. The registry never patches `globalThis.fetch`.
- **Removal condition:** every Router-owned compatibility caller receives `VisionProviderTransport` explicitly, production has zero reads of `currentVisionProviderTransport()`, and the install/release registry can be removed without changing proxy, credential, bounded-body or cancellation behavior.
- **Tests:** `vision-provider-transport`, `http-compat`, `catalog-corrections`, P2 Data Boundary provider-transport Node 22/24, Host pack/install smoke.

## `lib/legacy-global-proxy-boundary.js`

- **Reason:** retain the process-global proxy patch only for Host-owned/raw-fetch visual providers that still lack a provider-scoped proxy seam. Router-owned `vision-http` and direct protocol-correction traffic already uses `VisionProviderTransport` with an explicit dispatcher.
- **Host gap:** the supported Host window does not yet guarantee one provider-scoped/shared HTTP proxy seam that third-party Host-owned adapters can consume without a process-global fetch wrapper.
- **First needed for:** legacy/custom Host-owned visual provider compatibility when users configure Vision Router proxy routing.
- **Feature detection:** live visual-chain ownership. Router-owned routes bypass the legacy patch; any unknown/Host-owned provider conservatively keeps it available. This is capability/ownership detection, not a Host-version persona.
- **Removal condition:** **the minimum supported DSH provides a provider-scoped/shared HTTP proxy seam** that covers the remaining Host-owned/raw-fetch provider compatibility requirement.
- **Tests:** `legacy-global-proxy-boundary`, `vision-provider-transport`, `adversarial-hardening`, P2 Data Boundary Node 22/24.

## `lib/legacy-core-vision-policy-bridge.js`

- **Reason:** preserve the two remaining pre-step compatibility behaviors after Core policy ownership moved to explicit session/Core surfaces: reuse the exact `SessionMemoryView` for text-only image-history rewrite, and expose exact current-turn durable attachment IDs as read-only model context for Vision Router-owned wrappers.
- **Host gap:** the supported Host pre-step path does not natively provide both an exact session-scoped visual-memory rewrite seam for text-only fallback and a model-readable durable attachment-reference seam for Router-owned image turns.
- **First needed for:** the Core/session ownership migration that removed Settings/config impersonation while retaining these two real pre-step behaviors.
- **Feature detection:** live `SessionSurfacePolicy` (`rewriteCurrentImages` and ownership), exact known session visual memory, and actual current-turn image attachment IDs. No Host version-string branch and no Settings/config projection.
- **Removal condition:** the minimum supported Host exposes native pre-step/session-memory and durable attachment-reference capabilities that make both behaviors redundant, and contract/parity tests prove the bridge can be removed without reintroducing Settings impersonation or degrading text-only/native image turns.
- **Tests:** `settings-impersonation-closure`, `session-surface-policy`, session/runtime parity and native cold-resume coverage.

## `lib/tesseract-exec-compat.js`

- **Reason:** own the single process-wide `promisify(execFile)` compatibility boundary for the two narrow child-process cases Vision Router still needs: materializing Tesseract stdin image bytes, and replacing only Core's exact legacy Windows `VirtualScreen`/`CopyFromScreen` desktop-capture command with a per-monitor-DPI-safe equivalent. One owner prevents cleanup-order bugs from independently stacked `execFile` wrappers.
- **Host gap:** these are runtime/platform gaps rather than DSH semantic ownership: Node's async `execFile` path does not consume the historical OCR `options.input`, while non-DPI-aware Windows PowerShell virtualizes desktop metrics and can disagree with physical screen-copy coordinates on scaled/mixed-DPI displays.
- **First needed for:** Node 24/local Tesseract process execution reliability; Windows scaled/mixed-DPI `vision_screenshot` correctness (#340).
- **Feature detection:** exact executable/call fingerprints only. Tesseract handling requires `tesseract[.exe]` + stdin input; Windows screenshot handling requires `win32`, `powershell[.exe]`, `-Command`, and the exact legacy `SystemInformation.VirtualScreen` + `Graphics.CopyFromScreen` script shape. No Host/Node version persona and unrelated child processes delegate unchanged.
- **Removal condition:** local OCR no longer needs an `execFile` stdin shim **and** Core/Host exposes a native DPI-correct desktop-capture seam (or the legacy PowerShell command is removed), with Node 22/24 and Windows platform matrices proving the shared wrapper is unreachable before deletion.
- **Tests:** `tesseract-node24-boot`, `qa-screenshot-runtime` (PMv2/PMv1 ordering, context restoration, exact-match passthrough, Windows PowerShell compile smoke), cross-platform Host tests.

## `lib/abort-signal-compat.js`

- **Reason:** keep Vision Router cancellation/deadline composition working when a supported DSH Host or bridge exposes `AbortSignal`/`AbortController` but omits the standard static `AbortSignal.any()` or `AbortSignal.timeout()` helpers used by the Router's runtime boundaries.
- **Host gap:** some real Host/bridge environments can surface a partial AbortSignal runtime even though the declared Node support window normally provides both helpers, producing `AbortSignal.any is not a function` inside visual work.
- **First needed for:** partial Host/bridge AbortSignal runtimes observed during Vision Router image execution and exact capability checks.
- **Feature detection:** only the actual static helper presence is inspected. Existing native `AbortSignal.any` and `AbortSignal.timeout` functions are never replaced; only a missing helper is installed. No Node or DSH version persona is inferred.
- **Removal condition:** every supported Host/runtime contract guarantees both static helpers in the actual realm used by plugin execution, and a cross-Host regression proves no supported bridge can present the partial runtime anymore.
- **Tests:** `qa-turn-budget-cancellation` legacy-realm fallback/validation/non-intervention coverage plus Node 22/24 and DSH contract CI.

## Removal protocol

A compatibility seam may be deleted only when all of the following are true:

1. its **Removal condition** is satisfied by the declared support window;
2. the relevant capability is proved by a gating Host contract fixture or direct feature test;
3. deleting the seam leaves Node 22/24, minimum/legacy/current Host contracts and relevant platform tests green;
4. no Authority, Session, Storage or native-multimodal invariant changes as a side effect;
5. the deletion is a focused change, not bundled into an unrelated routing/data-boundary refactor.

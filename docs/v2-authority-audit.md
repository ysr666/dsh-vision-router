# Vision Router v2 Authority Audit — A-H

Status: **audit of the v2 Draft before Commit I implementation changes**

Behavioral baseline audited: `29faf57bfbff4be623fa42d9036fc39de239d573`.

The only later change at the start of this audit is the contract-only commit `ca8df601f9c3cbaa6167a1f892bb1d092a0dd290`, which adds `docs/v2-authority-contract.md` and does not change runtime behavior.

This audit covers the cumulative v2 feature surface built through A-H, grouped by authority-bearing entry point rather than by individual historical commit. The question for every path is:

> **Where did the user authorize this side effect, and what exactly was the scope?**

Ratings:

- **PASS** — current behavior already satisfies the Authority Contract.
- **FAIL / P0** — current behavior can cross an authority boundary and must be fixed before real-machine acceptance/executor work.
- **CONDITIONAL / P1** — safe in today's call graph, but authority is enforced by convention rather than a durable contract and should be hardened in Commit I.
- **N/A** — no authority-bearing side effect exists on this path.

## Executive result

The current A-H architecture is mostly conservative, but it has **two P0 consent violations** and **one P1 future-bypass risk**:

1. **P0 — background measurement is granted by default.** `backgroundBenchmarking` defaults/falls back to `local-free`. Once the user selects `routingMode:auto`, the background profiler can create local/known-free Benchmark requests even if the user never separately granted background Measurement Authority.
2. **P0 — runtime performance is observed in ordered mode.** The visual-tool wrapper establishes the runtime-performance scope for every supported real visual tool before checking any Auto authority. Successful adapter streams can therefore populate future-routing performance evidence while `routingMode:ordered`.
3. **P1 — manual measurement authority lives at the HTTP/UI boundary, not in the manager API.** Today's production route is explicit and loopback-protected, but `createCapabilityBenchmarkManager().enqueue/run` has no authority parameter. A future internal caller could invoke measurement without carrying proof of the user action.

No current A-H code changes the real v1 execution order. No persistent runtime/outcome learning exists.

## A-H authority surface matrix

| Surface | Current authority source | Rating | Audit result |
| --- | --- | --- | --- |
| routing mode / preference product model | `routingMode`, `routingPreference` | PASS | `routingMode` defaults to `ordered`; preference is separate and cannot itself grant Auto execution. |
| Auto preview service | read-only GET | PASS | Computes recommendation only; returns `autoPreviewOnly:true`, `executionActive:false`, `healthIncluded:false`. |
| turn shadow planner | internal `capabilityRoutingShadow` debug switch | PASS | Logs a recommendation only and then executes the original tool unchanged. It has no executor seam. Runtime-observation issue is audited separately. |
| exact manual capability Benchmark | explicit user benchmark action | PASS at route boundary / P1 internally | Browser opens a Benchmark modal and POSTs only after a user choice; cloud cost is disclosed; POST/DELETE are loopback mutation routes. Manager methods themselves do not carry explicit authority provenance. |
| exact vision smoke test | explicit user test action | PASS | POST-only model-invoking diagnostic, same-origin checked and loopback-fenced by the common mutation boundary; no fallback and no capability-profile write. |
| background capability profiler | `backgroundBenchmarking` plus current Auto condition | **FAIL / P0** | Missing/invalid/default background state resolves to `local-free`; Auto can therefore activate measurements without a separate background consent action. |
| background revocation | live settings polling | PASS after P0 default fix | Running work re-checks live policy and aborts when authorization disappears; foreground/manual work preempts background. |
| capability profile persistence | successful Benchmark result | PASS conditional on Measurement Authority | Store writes only sanitized successful Benchmark records. The persistence mechanism is sound; unauthorized default background measurement can currently reach it, so the caller must be fixed. |
| runtime performance observation | implicit real-call wrapper | **FAIL / P0** | Runtime scope is established on supported visual tools regardless of `routingMode`; successful streams record process-local future-routing evidence even in ordered mode. |
| runtime performance retention | process-local bounded store | PASS | Max age/sample count are bounded; no disk persistence; failures/aborts do not become positive samples; restart clears evidence. |
| persistent runtime/outcome learning | none | PASS | No current A-H path persists user-specific runtime/outcome learning. It remains prohibited until a separate authority is designed. |
| breaker health bridge | read-only `peek()` | PASS | Availability is observed without pruning, LRU touch, credential clearing, failure recording, or other breaker mutation. |
| remote settings | explicit `allowRemoteSettings` meta-authority + trusted-host RPC | PASS / review-sensitive | `routingMode` and `backgroundBenchmarking` are remotely mutable only after the user separately enables remote settings after risk confirmation. New authority-bearing fields must never be added to the remote allow-list automatically. |
| capability identity / cache lookup | evidence lookup only | PASS | Endpoint/suite identity decides whether evidence is applicable; evidence presence never grants execution or measurement permission. |
| Benchmark suite v3 / H hardening | evaluator/fixture/parser hardening | N/A | Suite revision, answer-token isolation, deadline contract, diagnostic redaction and script-marker hardening create no new authority. |
| settings/diagnostics HTML preludes | browser presentation | N/A for execution | Injection itself does not grant side-effect authority. Current background fallback/copy reflects the unsafe default and must be reconciled when the P0 implementation is fixed, but no UI redesign is part of this audit. |

## Finding I-01 — P0: background measurement is default-authorized

### Evidence

The public Config currently defines:

```text
routingMode = ordered by default
backgroundBenchmarking = local-free by default
```

`entry.js` also normalizes a missing/invalid background value to `local-free` when building `runtimeConfig`.

`vision-background-benchmark.js` independently normalizes a missing/invalid background value to `local-free`.

The background profiler then considers work authorized when:

```text
routingMode == auto
and background mode != off
and candidate is eligible for that background mode
```

Therefore a user can explicitly grant **Execution/Auto intent only** by choosing Auto, never touch the background measurement setting, and still cause additional local/known-free Benchmark work because Measurement Authority arrived from a default rather than a separate consent action.

The browser prelude has the same fallback (`local-free`), so the visible state also treats the grant as the default rather than an explicit authorization.

### Why this violates the contract

`routingMode:auto` may not imply background Measurement Authority.

Zero monetary price is not zero side effect: a local/free Benchmark can consume CPU/GPU, network, provider quota, model residency and time.

### Required Commit I change

Fail closed at **every** authority layer:

```text
Config default:                     off
runtimeConfig missing/invalid:      off
backgroundMode missing/invalid:     off
browser/settings fallback:          off
```

Only an explicit effective value of `local-free` or `all` may grant standing background measurement.

Because this is an unreleased v2 Draft, pre-Authority prototype/default state must not be treated as a grandfathered permission. Before release, ambiguous prototype state must fail closed and require the user to grant background measurement again.

### Required tests

- missing `backgroundBenchmarking` + Auto -> zero background requests;
- invalid `backgroundBenchmarking` + Auto -> zero background requests;
- `off` + Auto -> zero background requests;
- explicit `local-free` + Auto -> only eligible local/known-free work;
- explicit `all` + Auto -> eligible configured cloud work may run;
- Auto does not rewrite/upgrade the background authority field;
- revoking `local-free/all` to `off` aborts running background work.

## Finding I-02 — P0: runtime performance is collected without Auto consent

### Evidence

`vision-capability-shadow.js` wraps every supported visual tool in:

```text
withVisionRuntimePerformanceScope(...)
```

before it reads live settings or checks `capabilityRoutingShadow`.

`vision-runtime-performance.js` then observes `ctx.llm.stream` whenever that scope exists and records successful latency samples in the process-local store.

There is no `routingMode:auto` check on this path.

Consequently, normal fixed-order users can accumulate performance evidence intended for future Balanced/Speed routing even though they have not delegated Auto routing authority.

### Why this violates the contract

The current process-local observation is low risk — it creates no extra provider request and is not persisted — but it still exists specifically to influence a future routing decision. Under the new Authority Contract, this ephemeral future-routing observation is permitted only after the user explicitly enables Auto.

### Required Commit I change

Establish the runtime-performance scope only when the **live** authority snapshot permits ephemeral Auto observation.

The LLM stream observer may remain installed globally; without an authorized scope it must pass through and record nothing.

Do not use `capabilityRoutingShadow` as the consent switch. It is an internal development/debug flag, not product authority.

### Required tests

- Ordered + successful OCR call -> runtime store unchanged;
- Auto + first successful OCR call -> one warming sample;
- Auto + second successful OCR call -> eligible median;
- Auto -> Ordered before next call -> no new sample;
- Ordered -> Auto -> subsequent successful call may sample;
- failed/aborted call -> no sample in either mode;
- manual Benchmark/background Benchmark/smoke test -> no runtime sample.

## Finding I-03 — P1: manual Benchmark manager does not carry authority provenance

### Evidence

The production browser flow is strong:

- a click opens the Benchmark modal;
- Quick/Full/force/diagnostic actions POST only after a user choice;
- cloud candidates show a possible-cost warning;
- Cancel sends DELETE;
- the common web capability boundary restricts Benchmark POST/DELETE to the local DSH UI.

However, `createCapabilityBenchmarkManager()` exports side-effectful `enqueue()` and `run()` methods that accept backend/mode/intents but no authority context/token/source.

Today's production call graph reaches those methods from the explicit HTTP action, so this is not a current unauthorized provider call. It is a future-bypass hazard: another internal feature could call the manager directly and accidentally inherit "manual" semantics without a user action.

### Required Commit I change

Introduce a small code-level authority model and require side-effectful measurement callers to identify the authority source.

A minimal target is sufficient; do not build a general policy engine. For example:

```js
resolveVisionRoutingAuthority(config)

{
  execution: 'ordered' | 'auto',
  backgroundMeasurement: 'off' | 'local-free' | 'all',
  ephemeralRuntimeObservation: boolean,
  persistentLearning: false,
}
```

For manual measurement, the HTTP action should create/pass an explicit per-job manual measurement lease/source. Direct manager execution without that source should fail closed in production paths.

Tests may construct explicit test authority rather than relying on UI convention.

## Finding I-04 — PASS: real execution is still outside v2

The routing preview explicitly reports:

```text
autoPreviewOnly: true
executionActive: false
healthIncluded: false
```

The turn shadow planner computes/logs a suggested order only when its internal shadow flag is enabled, then invokes the original tool implementation. No A-H path feeds `autoPreviewOrder` into the v1 executor.

This is the correct boundary. Commit I must preserve it.

## Finding I-05 — PASS: preference is not authority

`vision-routing-product.js` normalizes `routingMode` independently from `routingPreference` and defaults invalid/missing mode to `ordered`.

The legacy `capabilityRoutingStrategy` compatibility value can influence preference vocabulary only; it cannot turn Auto on.

This already matches the Authority Contract.

## Finding I-06 — PASS: manual provider-invoking diagnostics are explicit and transport-fenced

Both current active measurement actions are bounded:

### Exact capability Benchmark

- model calls start from explicit POST-created jobs;
- Cancel is explicit DELETE;
- successful complete results alone reach `store.put()`;
- failures/partial runs do not overwrite valid evidence;
- model-invoking POST/DELETE routes are loopback-only through `installLocalMutationRouteBoundary()`.

### Exact vision smoke test

- POST only;
- same-origin check in the handler;
- common loopback mutation boundary also covers the route;
- exact backend, fallback disabled;
- no capability profile persistence.

No change is required to their user-facing flow in this audit.

## Finding I-07 — PASS: background revocation mechanics are already strong

Once a background work item is running, a policy poll reads live settings. If the work is no longer authorized, the controller aborts with a background-yield error rather than treating revocation as provider failure.

Foreground visual work and manual Benchmark also preempt background work.

Commit I should preserve this mechanism while replacing the unsafe default authority source.

## Finding I-08 — PASS: capability persistence is evidence storage, not permission storage

The capability store:

- loads only the current cache version;
- sanitizes records;
- persists atomically with mode `0600`;
- merges per-axis evidence;
- writes only when `put()` is called by an authorized measurement path.

The cache does not itself trigger provider calls or change execution order.

The only authority defect is upstream: default-authorized background measurement can currently produce records. Fixing I-01 restores the intended boundary.

## Finding I-09 — PASS: breaker health remains read-only

The v2 breaker bridge captures the v1 breaker only for observation and calls `peek()` for a turn-scoped health fact. The observer is explicitly diagnostic-only and exceptions cannot affect v1 breaker construction/execution.

Availability may inform a future authorized decision, but it does not grant authority and does not rewrite capability evidence.

## Finding I-10 — PASS with review rule: remote settings is delegated meta-authority

The remote settings bridge places `routingMode` and `backgroundBenchmarking` on an explicit mutable allow-list, but writes are accepted only after `allowRemoteSettings` has been explicitly enabled through the risk-confirmed trusted-host path.

Under the Authority Contract this is valid delegation: the user has authorized the trusted remote settings surface to act on their behalf.

Commit I must pin these invariants with tests:

- no remote authority-bearing mutation before `allowRemoteSettings`;
- after explicit authorization, one reviewed top-level field may be changed with revision checking;
- disabling remote settings blocks future writes;
- a future authority-bearing field remains remote-local-only until manually added to the allow-list.

## Finding I-11 — PASS: no persistent behavioral learning exists

A-H currently persists capability Benchmark evidence only.

Runtime performance is process-local and expires; no success-rate history, retry history, user correction history, model replacement behavior, or other long-lived user-specific outcome learning is stored.

Do not add such persistence in Commit I. It requires a later explicit Learning Authority design.

## Finding I-12 — N/A: Commit H hardening does not widen authority

Suite v3 answer-token isolation, deadline semantics, diagnostic redaction and robust HTML script-marker detection harden measurement/diagnostics but do not create new model requests or permission paths.

They should remain unchanged during the Authority implementation unless a regression test proves a direct interaction.

## Commit I implementation scope derived from this audit

Commit I should be deliberately small. It is **not** the Auto executor commit and **not** a UI redesign.

Required implementation work:

1. add a code-level authority resolver/snapshot shared by v2 callers;
2. make background Measurement Authority fail closed (`off`) on default/missing/invalid state;
3. ensure Auto does not imply background measurement;
4. gate ephemeral runtime-performance scope on live Auto authority;
5. carry explicit manual measurement provenance/lease into side-effectful Benchmark manager calls;
6. add adversarial authority tests for non-implication, revocation and direct/programmatic callers;
7. keep preview/shadow execution-inactive;
8. keep persistent runtime/outcome learning absent.

Explicitly out of scope for Commit I:

- changing actual v1 backend order;
- adding an Auto executor;
- changing routing scoring/thresholds;
- adding new Benchmark axes;
- adding persistent behavioral learning;
- redesigning the Settings UI.

## Gate before returning to real-machine acceptance

Commit I is acceptable only when automated tests can prove all of the following:

```text
Auto alone                      -> no background provider request
background unset/invalid        -> no background provider request
ordered real visual call        -> no future-routing runtime sample
Auto real visual call           -> authorized ephemeral runtime sample
manual Benchmark click/action   -> authorized measurement job
programmatic measurement        -> requires explicit authority source
revoked background authority    -> queued work blocked / running work yields
preview/shadow recommendation   -> still cannot change real execution
persistent user learning        -> still absent
```

After that gate is green, the real-machine acceptance matrix should be updated with an Authority section and run against the new Commit I head before any opt-in execution-changing Auto work is considered.

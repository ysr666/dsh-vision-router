# v2 capability-aware vision routing

This document describes the current v2 routing target on `feat/v2-capability-router`. The branch remains **preview/shadow-only**: v1.7.x execution order is still authoritative, and `routingMode: auto` is not connected to the real executor yet.

## Product rule

> **The user decides preference; Benchmark provides facts; Vision Router does not guess model capability.**

Normal users choose:

- **Routing mode**: `ordered` or `auto`;
- **Routing preference**: `balanced`, `quality`, `speed`, or `local`;
- **Background profiling**: `local-free`, `all`, or `off`.

Model names, provider names, model families and popularity never create capability scores. An unmeasured axis is simply unmeasured.

`capabilityRoutingShadow` remains an internal validation flag, not the product switch.

## Inputs and boundaries

Capability routing uses only:

1. **User policy**
   - configured model order;
   - routing preference;
   - explicit locality preference.
2. **Exact-endpoint measurements**
   - directly measured per-axis capability score;
   - the same axis's measured median transport latency;
   - that axis's own measurement timestamp/freshness.

Runtime breaker/rate-limit state is a separate availability gate. It may temporarily move an unavailable backend behind healthy candidates, but it never edits capability scores.

There are no family priors, generic priors, reputation scores, manual capability scores, model-name inference, or prior/measurement blending.

## User order is the baseline

Auto preview starts from the configured order. It is not a global leaderboard sort.

A measured backend cannot jump over an unmeasured neighbor merely because its own score is high. Example:

```text
A OCR 60
B OCR unmeasured
C OCR 99
```

remains:

```text
A -> B -> C
```

`B` is an information barrier.

Capability movement is adjacent and conservative. Both neighbors must have fresh directly comparable evidence for the current axis, and the right side must lead by at least:

```text
AUTO_REORDER_MIN_ADVANTAGE = 0.08
```

So `91 -> 94` stays in configured order, while `61 -> 94` may preview a swap.

## Direct task axes

Current directly measured axes are:

```text
structured
ocr
document
grounding
general
```

Tasks such as `ui`, `detection`, `chart_diagram`, `code_screenshot`, and `visual_compare` do not receive proxy formulas. Until they have their own direct measurement contract, capability-based Auto preserves configured order for them.

## Preferences

### Quality

Uses the fresh directly measured capability score for the current axis.

### Balanced

Uses:

```text
0.80 * capability + 0.20 * speed
```

where speed comes only from the **same axis's** measured median transport latency.

### Speed

Uses:

```text
0.55 * capability + 0.45 * speed
```

and still requires fresh measured capability. Another axis's latency or an aggregate latency is never substituted.

### Local

`local` is explicit user policy, not measured superiority. Healthy local routes are stably grouped before cloud routes; conservative measured comparison then applies inside locality groups.

## Candidate pool

Auto preview is limited to routes that belong to Vision Router's user configuration:

- configured provider/model rows and fallbacks;
- explicitly enabled local backends;
- explicitly configured HTTP vision backends.

Arbitrary DSH-discovered visual models do not silently enter the routing pool.

An unselected built-in free HTTP tier is `fallback-only` and cannot be Benchmark-promoted over user routes. If the user explicitly selects it, it becomes a normal user route.

## Exact-endpoint Benchmark

Benchmark uses generated fixtures, never user images.

The exactness contract includes:

- exact provider/model/endpoint/protocol identity;
- secret-safe `ep2_...` fingerprint;
- one-way fingerprint of the resolved credential value when required;
- credential rotation invalidates the old endpoint identity;
- unresolved credential-required routes do not alias genuinely keyless routes;
- fallback disabled during Benchmark;
- fingerprint mismatch aborts persistence;
- endpoint URLs, raw keys, credential references and raw model output are excluded from persisted/browser evidence.

Profiles are stored atomically at:

```text
~/.dsh/cache/vision-router/capability-profiles.json
```

with mode `0600`.

## Suite and profile cache revisions

Current measurement contract:

```text
CAPABILITY_BENCHMARK_SUITE_REVISION = 2
CAPABILITY_PROFILE_CACHE_VERSION = 3
```

Cache v3 adds **per-axis timestamps and fixture counts**:

```text
measuredAtByAxis
fixtureCountByAxis
```

Legacy cache-v2 records from the current suite are migrated conservatively: each retained score inherits the old record timestamp. Wrong-suite records remain unusable.

The reason for cache v3 is important: refreshing one axis must not refresh every other axis.

Example:

```text
OCR      measured 8 days ago
General  measured today
```

means:

```text
OCR      stale -> excluded from Auto
General  fresh -> Auto-eligible
```

A new General measurement cannot make the old OCR measurement fresh.

## Per-axis freshness

Freshness belongs to each measured axis independently:

- `<= 7 days`: fresh and Auto-eligible;
- `7–30 days`: stale, still human-visible, excluded from Auto;
- `> 30 days`: removed from retained current profile data.

A mixed-age profile is valid. The Benchmark product may therefore expose, for one backend:

```text
OCR       91 · 8天前 · 已陈旧
General   88 · 刚刚 · 可用于Auto
Document  — 未测
```

The browser/API contract includes per-axis fields:

```text
scores
medianLatencyMs
measuredAtByAxis
fixtureCountByAxis
freshnessByAxis
autoEligibleAxes
staleAxes
coverage
coverageKind
```

Aggregate `measuredAt`, `freshness` and `autoEligible` remain summary/compatibility fields; Auto scoring itself uses the current axis's timestamp.

There is no confidence tier.

## Manual Quick / Full Benchmark

Manual Benchmark remains available as an advanced operation, but it is **not a prerequisite for normal Auto setup**.

Quick:

- about 3 sequential requests;
- covers OCR + General.

Full:

- about 6 sequential requests;
- covers Structured + OCR + Document + Grounding + General.

Every selected fixture preflights before request 1:

```text
synthetic SVG
-> Sharp/libvips PNG render
-> adapter attachment materialization when required
-> model request 1
```

Preflight failure sends zero model requests and persists no partial evidence. Measured latency covers model transport only, excluding fixture render and attachment persistence.

Invocation failures fail fast; explicit user Stop/Cancel is distinct from timeout/provider failure. A failed retest never overwrites valid prior evidence.

## Commit G: background progressive profiling

When `routingMode: auto`, Vision Router can gradually fill missing/stale axes while the user is idle. It does **not** run a hidden Full benchmark.

The profiler performs one backend + one axis at a time:

```text
idle
-> choose one eligible backend
-> choose one missing/stale axis
-> preflight that axis
-> run its exact generated fixture(s)
-> merge only that axis into the profile
```

A completed axis becomes available to Auto preview immediately without waiting for five-axis coverage.

### Background modes

```text
backgroundBenchmarking: local-free | all | off
```

- `local-free` — default; background work is limited to local routes or routes explicitly known to be free;
- `all` — explicit authorization to background-profile all configured benchmarkable user routes, including cloud routes that may incur API charges;
- `off` — no background capability profiling.

`fallback-only` routes are not background-profiled.

### Priority and yielding

Background profiling is deliberately lowest priority:

```text
real visual task
> manual Benchmark queue/run
> background progressive profiling
```

A real visual tool call aborts an active background measurement and restarts the idle window. Enqueuing a manual Benchmark likewise makes background work yield until the manual queue is idle.

Foreground/manual preemption is not treated as provider failure. Real provider failures receive per-backend/per-axis backoff before another background attempt.

The background timer is `unref()`-ed when supported, so it cannot keep DSH, doctor, tests, or another short-lived process alive by itself.

Background profiling never changes a real visual tool result or execution order.

## Runtime health

Shadow reads the live v1 circuit breaker through a side-effect-free observation seam. Circuit-open/rate-limited routes may be demoted for that live turn's shadow plan.

Observation must not prune cooldowns, touch LRU state, clear credential trips, or record a new breaker event. Settings preview intentionally remains health-neutral because it has no real turn scope.

## Benchmark UI

The model row stays compact with one **Benchmark / 测评** entry. The modal presents all five fixed axes and shows, independently for each axis:

- score;
- median transport latency;
- age;
- fresh/stale state;
- whether it may participate in Auto.

Missing axes display `— 未测`; no inferred values are filled in.

Cloud-cost notices, text-only force verification and grounding developer diagnostics remain in the secondary Benchmark panel.

## Shadow output and safety boundary

Shadow/preview exposes structures such as:

```text
currentOrder
autoPreviewOrder
decisions
incomparableBackends
measuredBackends
unmeasuredBackends
blockedBackends
```

Current runtime behavior is still:

```text
build preview/shadow plan
-> log/display only
-> invoke original v1 visual execution unchanged
```

`routingMode: auto` does **not** reorder the real v1 executor yet.

Before any future execution-changing Auto commit, real-provider validation must prove:

1. per-axis freshness cannot be accidentally refreshed by another axis;
2. unmeasured/stale information barriers preserve order;
3. repeated measurements produce stable material differences;
4. Balanced/Speed use same-axis latency only;
5. Local is policy, not a capability claim;
6. foreground/manual activity reliably preempts background work;
7. default `local-free` never spends chargeable cloud API quota;
8. `all` requires explicit user selection and is clearly labeled as potentially chargeable;
9. breaker behavior remains the v1 availability source of truth;
10. actual v1 execution remains unchanged.

Only after those gates have convincing real-machine evidence should an execution-changing Auto commit be discussed.

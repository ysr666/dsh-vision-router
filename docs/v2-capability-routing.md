# v2 capability-aware vision routing

This document describes the current v2 routing target on `feat/v2-capability-router`.

The branch remains **preview/shadow-only**. The existing v1 executor and configured fallback order remain authoritative; `routingMode: auto` is not connected to real execution.

## Product rule

> **The user determines preference; Benchmark provides facts; Router does not guess.**

The architecture deliberately separates four domains that must not be collapsed into one score.

| Domain | Question | Source of truth |
| --- | --- | --- |
| Capability | What can this exact model deployment do? | direct Benchmark axes |
| Performance | How fast is it now? | recent successful real visual calls |
| Availability / access | Can it be used for this turn? | credentials, breaker, rate-limit, timeout, live transport state |
| Policy | What does the user prefer? | configured order + routing preference |

A fact from one domain must not silently become a fact in another domain.

## Baseline: configured order

User-configured order is always the baseline truth.

Auto preview is a conservative adjacent-reorder planner, not a global leaderboard sort.

An unmeasured/incomparable route is an information barrier. A candidate behind that barrier cannot jump across it merely because another candidate has a strong score.

`fallback-only` built-ins cannot Benchmark-promote over user-selected routes, and arbitrary discovered DSH models do not silently enter the Auto pool.

## Direct capability axes

Current direct Benchmark axes are:

```text
structured
ocr
document
grounding
general
```

Current unsupported direct axes include:

```text
ui
detection
chart_diagram
code_screenshot
visual_compare
```

Until a direct fixture exists, the router does not manufacture a proxy capability score from model family, name, provider reputation, another axis, or a generic prior.

## Capability identity

Capability evidence is attached to a secret-safe `ep2_...` identity built from the measurement contract, including the exact provider/model/deployment route and non-secret protocol/configuration facts.

Identity also binds the Benchmark suite revision and renderer scope where relevant.

### Credentials are not capability identity

API keys answer **whether the route can be accessed**, not **what the model is capable of**.

Therefore credential values are excluded from capability identity.

```text
same endpoint/model/API + Key A -> same capability identity
same endpoint/model/API + Key B -> same capability identity
```

A rotated key may change access state, authorization outcome, quota or breaker scope, but it does not by itself invalidate OCR/Document/Grounding capability evidence.

If a key truly selects a different deployment/project/model, that distinction must be represented explicitly in non-secret endpoint/model configuration.

## Measurement age

Capability evidence has provenance timestamps, not an arbitrary TTL.

```text
8 days old   -> measured
80 days old  -> measured
1 year old   -> measured
```

provided the exact capability identity and Benchmark suite still match.

Age is useful to a human reviewer but is not a router validity judgement. The router does not create `fresh / stale / expired` capability classes.

A positive timestamp remains required for provenance integrity; malformed records without a usable timestamp are rejected rather than guessed.

## Benchmark profile format

Current revisions:

```text
CAPABILITY_BENCHMARK_SUITE_REVISION = 2
CAPABILITY_PROFILE_CACHE_VERSION = 4
```

Canonical persisted fields include:

```text
scores
measuredAt
measuredAtByAxis
fixtureCount
fixtureCountByAxis
benchmarkLatencyMs
benchmarkMedianLatencyMsByAxis
```

Cache v4 intentionally does not migrate v3 because v3 could split capability identity by credential value.

Wrong-suite records are ignored.

## Benchmark latency is not runtime speed

Benchmark request duration is retained for diagnostics, but it is a historical observation of that Benchmark run.

It is explicitly named:

```text
benchmarkLatencyMs
benchmarkMedianLatencyMsByAxis
```

Those fields do **not** feed routing performance scoring.

Runtime performance uses a separate process-local observation channel:

```text
runtimeLatencyMsByAxis
```

No implementation may substitute Benchmark latency, aggregate latency, another task's latency, or a generic provider latency when runtime speed is required.

## Runtime performance observer

Runtime speed is a dynamic fact, so unlike capability it deliberately has recency semantics.

Current observer contract:

```text
source: successful real visual-tool adapter streams
window: 1 hour
samples retained per backend+axis: up to 8
minimum samples before routing eligibility: 2
aggregation: median full-response latency
persistence: none; process-local only
```

The direct visual tool establishes the task axis through `AsyncLocalStorage`; `ctx.llm.stream` records the elapsed time only when that exact real stream finishes successfully.

This means:

- one successful sample is visible in diagnostics as **warming**, but cannot affect Balanced/Speed;
- after two recent successful samples for the same backend + direct axis, the median becomes `runtimeLatencyMsByAxis[axis]` and may participate in Balanced/Speed;
- error, abort and failed streams are never performance samples;
- samples older than the runtime window are removed;
- restarting DSH clears runtime-performance evidence;
- Benchmark, background capability profiling and exact smoke tests run outside the visual-tool runtime scope and cannot contaminate speed evidence.

Capability does **not** inherit this one-hour window. An OCR capability score may remain valid for months while its runtime speed observation disappears after the recent-performance window.

The current observer covers the real DSH adapter-stream path. A direct HTTP compatibility/fallback request that bypasses `ctx.llm.stream` is intentionally left without runtime speed evidence instead of fabricating a different timing metric. Such a candidate stays incomparable for Balanced/Speed until a precise equivalent observation seam exists.

Because the current executor still follows configured v1 order, alternate backends may naturally have little or no runtime performance history. That is acceptable: missing performance is an information barrier, not permission to guess.

## Preference semantics

### Quality

Quality is directly measured capability for the current axis.

```text
Quality score = capability
```

For adjacent candidates to compare, both need valid direct capability evidence for that axis. A reorder requires at least:

```text
AUTO_REORDER_MIN_ADVANTAGE = 0.08
```

Smaller differences preserve configured order.

### Balanced

Balanced combines capability with **eligible recent runtime** performance:

```text
Balanced score = 0.80 * capability + 0.20 * runtime-speed
```

If runtime performance is missing or still warming, the candidate is incomparable for Balanced and configured order is preserved.

### Speed

Speed likewise requires eligible recent runtime performance:

```text
Speed score = 0.55 * capability + 0.45 * runtime-speed
```

If runtime performance is missing or still warming, configured order is preserved. Benchmark latency is not a substitute.

### Local

Local is explicit policy:

```text
local first
then capability comparison within locality groups
```

It is not a claim that local models are more capable.

## Availability and breaker health

Live availability is a separate gate.

Examples:

- credential missing/invalid;
- HTTP 429 / quota;
- circuit breaker open;
- request timeout;
- transport/network failure.

These facts may make a route temporarily unavailable for a real turn. They do not rewrite stored capability scores.

Settings preview intentionally remains health-neutral:

```text
healthIncluded: false
```

Turn-level shadow may inspect the same v1 breaker through a side-effect-free read seam.

## Exact self-Benchmark

Benchmark uses generated privacy-safe fixtures, not user images.

Quick:

```text
OCR + General
about 3 requests
```

Full:

```text
Structured + OCR + Document + Grounding + General
about 6 requests
```

Trust requirements:

- fallback disabled;
- exact selected backend only;
- all selected fixtures preflight before request 1;
- Sharp/libvips rendering tested before model calls;
- adapter attachment materialization included in preflight where needed;
- preflight failure sends zero model requests;
- provider/transport failure fails fast;
- partial failed runs do not persist capability evidence;
- failed retest preserves prior valid evidence;
- timeout and explicit cancellation are distinguished;
- raw credentials/endpoints/responses are excluded from public diagnostics.

## Progressive background profiling

Background profiling exists to fill **missing capability facts**.

```text
backgroundBenchmarking: local-free | all | off
```

`local-free` is the default and does not authorize chargeable cloud requests.

`all` explicitly allows configured cloud routes that may incur API charges.

`off` disables background profiling.

One background unit is:

```text
one candidate + one unmeasured direct axis
```

Already measured axes are not periodically retested merely because time passed.

Priority is:

```text
real visual execution
> manual Benchmark
> background profiling
```

Foreground/manual activity makes background work yield. Genuine background provider failure receives retry backoff.

Background capability runs do not populate runtime speed.

## Diagnostics contract

Current read-only diagnostics version:

```text
diagnosticVersion = 3
```

The payload explicitly states:

```text
measurementAgePolicy: informational-only
credentialAffectsCapabilityIdentity: false
benchmarkLatencyAffectsRouting: false
performanceSource: runtime-observation-only
runtimePerformanceCoverage: real visual-tool adapter streams
runtimePerformanceMaxAgeMs: 3600000
runtimePerformanceMinSamples: 2
```

Per candidate/axis diagnostics keep these concepts separate:

- capability score;
- measurement timestamp/age;
- Benchmark latency observation;
- raw/warming runtime observation and sample count;
- routing-eligible runtime median, when warmed;
- availability/health only when the relevant surface has a real turn scope;
- active user policy and reorder threshold.

The browser displays planner output and does not duplicate ranking logic.

## Execution boundary

Current v2 work may:

- persist routing settings;
- collect capability Benchmark evidence;
- fill missing capability axes in the background under cost policy;
- passively observe recent successful real visual-call performance;
- compute Auto preview/shadow plans;
- expose sanitized diagnostics.

Current v2 work must **not**:

- change the real v1 execution order;
- replace the v1 executor;
- infer unsupported capability axes;
- use Benchmark latency as current speed;
- use credentials as capability identity;
- silently authorize paid background profiling;
- create synthetic runtime speed for paths that are not precisely observed.

The executor should only be connected after the acceptance matrix in `docs/v2-auto-preview-acceptance.md` has convincing real-machine PASS evidence.
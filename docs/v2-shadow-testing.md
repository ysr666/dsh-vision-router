# v2 shadow routing test guide

The v2 capability router is deliberately **preview/shadow-only**. It may compute an `autoPreviewOrder`, while the current v1 fallback chain remains the actual execution order.

## Product fields

```text
routingMode: ordered | auto
routingPreference: balanced | quality | speed | local
backgroundBenchmarking: local-free | all | off
```

None of these fields authorize execution-changing Auto in this Draft.

## What shadow is allowed to observe

Shadow planning may combine four separated inputs:

```text
Capability   -> direct Benchmark scores
Performance  -> recent successful real visual-call observations
Availability -> turn-scoped breaker/rate-limit/access facts
Policy       -> configured order + routingPreference
```

It must never reinterpret one input as another.

## Capability evidence

Current direct axes:

```text
structured
ocr
document
grounding
general
```

Unsupported task types remain incomparable unless a direct axis is added later.

Capability evidence is valid when its exact non-secret capability identity and Benchmark suite match. Measurement age is informational only.

Changing an API key alone does not change capability identity.

## Performance evidence

Benchmark request duration is stored only as a Benchmark observation:

```text
benchmarkLatencyMs
benchmarkMedianLatencyMsByAxis
```

Shadow routing must not use those fields as current speed.

Runtime performance is process-local and currently observed only from successful real visual-tool DSH adapter streams. The tool wrapper supplies the direct axis through `AsyncLocalStorage`; the `ctx.llm.stream` wrapper measures full-response elapsed time.

Current defaults:

```text
window: 1 hour
max samples per backend+axis: 8
minimum samples for routing: 2
aggregation: median
```

One successful sample is diagnostics-only warming evidence. Two recent successful same-axis samples expose `runtimeLatencyMsByAxis[axis]` and may make the candidate comparable for Balanced/Speed.

Failed or aborted streams never count. Samples older than the runtime window disappear. Restarting DSH clears runtime observations.

Benchmark, background capability profiling and exact smoke tests run outside the visual-tool runtime scope and must create zero runtime-performance samples.

Direct HTTP compatibility/fallback calls that bypass `ctx.llm.stream` are currently left without runtime speed evidence. Do not substitute Benchmark latency or a different timing metric.

## Expected preference behavior

### Quality

Two adjacent candidates with direct same-axis capability evidence can reorder only when the right candidate's capability advantage is at least `0.08`.

### Balanced

Requires both capability and eligible recent runtime speed facts:

```text
0.80 * capability + 0.20 * runtime-speed
```

No runtime speed, or only one warming sample -> no weighted comparison.

### Speed

Requires both capability and eligible recent runtime speed facts:

```text
0.55 * capability + 0.45 * runtime-speed
```

No runtime speed, or only one warming sample -> no weighted comparison.

### Local

Local is an explicit local-first policy. Capability comparison may happen within locality groups; local-first is not a capability claim.

## Information barriers

Test these explicitly:

1. A measured, B unmeasured, C strongly measured -> C must not cross B.
2. A and B measured with delta below `0.08` -> keep configured order.
3. A/B capability measured but no runtime performance under Balanced/Speed -> keep configured order.
4. A/B have only Benchmark latency under Balanced/Speed -> keep configured order.
5. A/B each have one runtime sample -> diagnostics show warming, still keep configured order.
6. A/B each have at least two recent same-axis samples -> weighted comparison may occur.
7. `fallback-only` candidate with excellent Benchmark score -> cannot promote over user routes.
8. unsupported task intent -> no proxy reorder.

## Runtime observer isolation cases

### Successful real tool call

Run a real `vision_ocr` adapter-backed call successfully twice on the same backend.

Expected after first success:

```text
runtimePerformanceObserved: true
runtimePerformanceEligible: false
runtimeSampleCount: 1
```

Expected after second recent success:

```text
runtimePerformanceObserved: true
runtimePerformanceEligible: true
runtimeSampleCount: 2
runtimeLatencyMs: <median>
```

### Failure / cancellation

Make the stream fail or abort.

Expected:

```text
no new runtime sample
```

### Scope isolation

Run manual Benchmark, background capability profiling, exact smoke test, and a non-direct-axis visual task.

Expected:

```text
no runtime performance sample created by those operations
```

Runtime observation must remain active even when `capabilityRoutingShadow:false`; the development log flag must not control product performance collection.

### Runtime recency

Advance beyond the one-hour runtime window without a newer successful sample.

Expected:

```text
runtime performance disappears / candidate becomes incomparable for Balanced or Speed
capability Benchmark score remains measured and unchanged
```

This is the intentional distinction between dynamic performance and persistent capability.

## Age-neutral capability evidence

Exercise capability records measured:

```text
today
8 days ago
80 days ago
1 year ago
```

With unchanged identity/suite, all remain measured capability evidence.

Expected diagnostics:

- factual age remains visible;
- no `fresh / stale / expired` capability validity tier;
- background profiler does not schedule a capability retest only because evidence is old.

## Credential rotation boundary

For the same provider/model/endpoint/API configuration:

1. Benchmark with Key A;
2. rotate to Key B;
3. refresh capability candidate/diagnostics.

Expected:

- same secret-safe `ep2_...` capability identity;
- stored capability remains attached;
- raw key never appears in profile/diagnostics;
- access/auth behavior may change independently.

## Background profiler shadow checks

Default `local-free`:

- local/known-free user routes may fill missing axes while idle;
- paid cloud routes must not be called automatically.

Explicit `all`:

- configured chargeable routes may be profiled;
- Settings must disclose the cost boundary.

`off` or `routingMode: ordered`:

- no background capability requests.

Already measured axes must not be periodically refreshed based on age.

Real visual work and manual Benchmark must preempt background profiling.

Background capability profiling must never populate runtime speed.

## Breaker / availability checks

Turn-level shadow may observe the real v1 breaker through a side-effect-free peek seam.

Verify that observation does not:

- prune cooldown state;
- touch LRU order;
- clear credential state;
- record new failures/successes;
- change v1 fallback behavior.

Settings preview stays health-neutral because it has no real session/turn scope.

## Diagnostic payload

Current contract:

```text
diagnosticVersion: 3
measurementAgePolicy: informational-only
credentialAffectsCapabilityIdentity: false
benchmarkLatencyAffectsRouting: false
performanceSource: runtime-observation-only
runtimePerformanceCoverage: real visual-tool adapter streams
runtimePerformanceMaxAgeMs: 3600000
runtimePerformanceMinSamples: 2
autoPreviewOnly: true
executionActive: false
healthIncluded: false
```

For a candidate/axis, verify the copied JSON distinguishes:

- `measuredAxisScore`;
- `measuredAt` / `ageMs`;
- `benchmarkLatencyMs`;
- `runtimeObservedLatencyMs`;
- `runtimeSampleCount` / `runtimeMinSamples`;
- `runtimeLatencyMs` only after warming threshold;
- `runtimePerformanceObserved`;
- `runtimePerformanceEligible`;
- `runtimeAgeMs`;
- `autoComparable`.

No endpoint URL, API key, credential ref or raw model output should appear.

## Critical execution test

Create a case where Quality preview recommends:

```text
configured: A -> B
preview:    B -> A
```

Then send a real image through the current product.

Expected:

```text
actual execution starts from A
```

If actual execution starts from B, the Draft safety boundary has been crossed and the test fails regardless of preview quality.

Repeat under Balanced/Speed after runtime observations exist. Preview may change, but actual v1 execution must still start from configured A.

## Exit condition

Shadow testing is successful only when the planner is explainable **and** real v1 behavior stays unchanged.

Use `docs/v2-auto-preview-acceptance.md` for the complete real-machine matrix before discussing an execution-changing Auto commit.
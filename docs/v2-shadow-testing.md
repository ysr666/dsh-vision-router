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
Capability  -> direct Benchmark scores
Performance -> separate runtime observations, when available
Availability -> turn-scoped breaker/rate-limit/access facts
Policy -> configured order + routingPreference
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

`Balanced` and `Speed` require a separate same-axis runtime performance observation. Without it, the candidate remains incomparable for those preferences and configured order is preserved.

## Expected preference behavior

### Quality

Two adjacent candidates with direct same-axis capability evidence can reorder only when the right candidate's capability advantage is at least `0.08`.

### Balanced

Requires both capability and runtime speed facts:

```text
0.80 * capability + 0.20 * runtime-speed
```

No runtime speed -> no weighted comparison.

### Speed

Requires both capability and runtime speed facts:

```text
0.55 * capability + 0.45 * runtime-speed
```

No runtime speed -> no weighted comparison.

### Local

Local is an explicit local-first policy. Capability comparison may happen within locality groups; local-first is not a capability claim.

## Information barriers

Test these explicitly:

1. A measured, B unmeasured, C strongly measured -> C must not cross B.
2. A and B measured with delta below `0.08` -> keep configured order.
3. A/B capability measured but no runtime performance under Balanced/Speed -> keep configured order.
4. A/B have only Benchmark latency under Balanced/Speed -> keep configured order.
5. `fallback-only` candidate with excellent Benchmark score -> cannot promote over user routes.
6. unsupported task intent -> no proxy reorder.

## Age-neutral evidence

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
- no `fresh / stale / expired` validity tier;
- background profiler does not schedule a retest only because evidence is old.

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
autoPreviewOnly: true
executionActive: false
healthIncluded: false
```

For a candidate/axis, verify the copied JSON distinguishes:

- `measuredAxisScore`;
- `measuredAt` / `ageMs`;
- `benchmarkLatencyMs`;
- `runtimeLatencyMs`;
- `runtimePerformanceObserved`;
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

## Exit condition

Shadow testing is successful only when the planner is explainable **and** real v1 behavior stays unchanged.

Use `docs/v2-auto-preview-acceptance.md` for the complete real-machine matrix before discussing an execution-changing Auto commit.

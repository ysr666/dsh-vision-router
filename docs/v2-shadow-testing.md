# v2 shadow routing test guide

The v2 capability router is deliberately **preview/shadow-only**. It computes an `autoPreviewOrder`, while the current v1 fallback chain remains the actual execution order.

## Product fields

```text
routingMode: ordered | auto
routingPreference: balanced | quality | speed | local
backgroundBenchmarking: local-free | all | off
```

`routingMode: auto` is not execution-changing on this Draft branch. `capabilityRoutingShadow: true` enables internal turn-level observation/logging.

## Measurement model

Vision Router does not infer capability from names or families. Current direct axes are:

```text
structured
ocr
document
grounding
general
```

Unsupported task classes do not receive proxy scores.

Current persistence contract:

```text
suite revision: 2
profile cache version: 3
```

Cache v3 stores `measuredAtByAxis` and `fixtureCountByAxis`. Legacy cache-v2 records from the current suite migrate with the legacy record timestamp copied to each retained measured axis.

### Measurement time is provenance only

Each axis keeps its own timestamp so the UI can truthfully say when that capability was measured.

Required regression:

```text
OCR measured 8 days ago
General measured today
```

must yield:

```text
OCR      measured / comparable for OCR
General  measured / comparable for General
```

The old OCR date must remain 8 days ago when General is refreshed. It must **not** become invalid merely because it is older, and it must not be rewritten as newly measured.

The same rule applies at 80 days or a year: age alone does not invalidate identity-valid, current-suite evidence.

Evidence should disappear/rebind when the exact endpoint/model/API/credential identity or Benchmark suite changes, not when a calendar threshold passes.

## Manual Benchmark

Quick and Full remain manual/advanced controls:

- Quick: ~3 requests, OCR + General;
- Full: ~6 requests, Structured + OCR + Document + Grounding + General.

They are no longer the expected onboarding path for Auto.

Every selected fixture preflights before request 1:

```text
synthetic SVG
-> Sharp/libvips PNG
-> adapter attachment materialization if needed
-> request 1
```

Preflight failure means zero model requests and no partial persistence. Latency is transport-only.

Wrong-but-valid answers may score low; invocation/auth/rate-limit/network/protocol/timeout/infrastructure failures fail fast. Explicit user cancellation remains distinct from timeout/provider failure.

A user may manually retest whenever newer evidence is desired; the system must not invent a periodic retest requirement from age alone.

## Commit G background profiler

When `routingMode: auto`, the profiler may gradually fill one **missing** axis at a time after an idle window.

It must never behave like a hidden Full benchmark and must never periodically remeasure completed axes merely because their timestamps are old.

### Eligibility

Default:

```text
backgroundBenchmarking: local-free
```

Expected:

- local route: eligible;
- explicitly known free route: eligible;
- chargeable/unknown-cost cloud route: not eligible;
- fallback-only route: not eligible.

With:

```text
backgroundBenchmarking: all
```

configured benchmarkable cloud user routes may be measured. This is the explicit cost-authorization boundary.

With `off`, no background Benchmark request is allowed.

With `routingMode: ordered`, background profiling is also inactive.

### Work unit

One work item is:

```text
one candidate + one unmeasured direct axis
```

After success, only that axis's score, latency, timestamp and fixture count are merged. Richer evidence on other axes must remain untouched.

A complete five-axis profile should generate **zero** background Benchmark requests even if all five timestamps are months old.

### Axis priority

A recent foreground visual task may raise its direct benchmark axis to the front of the next background scan. Otherwise the background priority order is conservative and deterministic.

A recent Document task therefore makes a **missing** `document` axis a preferred next target, without inventing evidence for UI/detection/etc. tasks that lack a direct axis.

### Yield/preemption contract

Priority is:

```text
real visual task
> manual Benchmark
> background profiler
```

Required checks:

1. start a background axis run;
2. begin a real visual tool call;
3. active background signal becomes aborted;
4. no provider-failure backoff is recorded for that foreground yield;
5. after foreground completion, a new idle window starts.

Repeat with a manual Benchmark enqueue/run. Background work must yield until the manual queue is idle.

A genuine background provider failure should create per-candidate/per-axis retry backoff rather than tight-looping.

The background timer should be `unref()`-ed where available so the profiler cannot keep a short-lived Node process alive.

## Order-preservation cases

### No measurements

```text
configured: Gemini -> Qwen -> GLM -> Unknown
preview:    Gemini -> Qwen -> GLM -> Unknown
```

Names must have zero effect.

### One-sided measurement

```text
A: unmeasured
B: OCR 99
```

remains `A -> B`.

### Unmeasured barrier

```text
A: OCR 60 measured
B: OCR unmeasured
C: OCR 99 measured
```

remains `A -> B -> C`. C cannot cross B using capability evidence.

An old but valid measurement is **not** an information barrier.

### Small vs material difference

```text
A OCR 91, B OCR 94 -> keep order
A OCR 61, B OCR 94 -> may preview B -> A
```

The threshold remains 0.08.

## Preference checks

- **Quality**: direct measured capability only.
- **Balanced**: 0.80 capability + 0.20 same-axis speed.
- **Speed**: 0.55 capability + 0.45 same-axis speed.
- **Local**: explicit local-first policy, then conservative capability comparison inside locality groups.

Balanced/Speed must not borrow another axis's latency or an aggregate latency.

## Candidate pool checks

The pool may contain:

- configured provider/model rows and fallbacks;
- explicitly enabled local backends;
- explicitly configured HTTP visual backends;
- built-in free tier as `fallback-only` when unselected.

Arbitrary DSH-discovered models must not enter Auto preview automatically. `fallback-only` routes cannot be Benchmark-promoted over user routes.

## Breaker validation

Turn-level shadow reads the same v1 breaker through side-effect-free observation.

Expected:

- circuit-open/rate-limited route appears blocked;
- it may move behind healthy routes in turn shadow;
- capability scores are unchanged;
- v1 remains responsible for actual skip/fallback.

Observation must not mutate cooldown/LRU/credential/breaker state.

Settings preview stays `healthIncluded:false` because there is no actual turn/session breaker scope.

## Benchmark product UI checks

The main model row remains compact with one Benchmark entry.

The modal must show five fixed axes, each with:

```text
score | median latency | measurement time
```

For example:

```text
OCR      91 | 500ms | 8天前
General  88 | 420ms | 刚刚
Document — 未测
```

The age is factual provenance only. The UI must not label a result `stale`, `expired`, `已陈旧`, or `已过期` because N days passed.

## Shadow output

Expected fields include:

```text
currentOrder
autoPreviewOrder
suggestedOrder
decisions
incomparableBackends
measuredBackends
unmeasuredBackends
healthBackends
blockedBackends
```

`measuredBackends` means a backend has routing-usable direct measured evidence. There is no time-age qualifier.

## Safety contract

Shadow/background profiling must not change the real tool result.

Current execution remains:

```text
observe/profile in separate low-priority path
-> build preview/shadow
-> call original v1 visual tool implementation unchanged
```

Actual v1 execution still owns fallback walking, breaker, timeouts, cancellation, resource governance, local stabilization, compatibility bridges and error classification.

## Gate before real Auto

Before connecting `autoPreviewOrder` to execution, verify on real providers:

1. old identity-valid measurements remain usable irrespective of age;
2. refreshing one axis never rewrites another axis's measurement timestamp;
3. unmeasured barriers always preserve capability order;
4. endpoint/model/API/credential or suite changes stop old evidence from being reused;
5. background default never spends chargeable cloud quota;
6. a complete old profile is not periodically background-retested;
7. `all` only runs after explicit user selection;
8. foreground visual activity reliably preempts background work;
9. manual Benchmark reliably preempts background work;
10. provider failures back off without tight loops;
11. Quick/Full preflight/failure rules remain intact;
12. repeated large measured differences remain stable;
13. Balanced/Speed use same-axis latency only;
14. Local remains explicit policy;
15. real v1 output/order remains unchanged.

If those are not convincing, improve measurement/shadow behavior. Do not wire execution-changing Auto to compensate for weak evidence.

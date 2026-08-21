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

### Per-axis freshness

Each axis is independent:

- <=7 days: fresh, may participate in Auto;
- 7–30 days: stale, still visible, excluded from Auto;
- >30 days: dropped from retained current profile data.

Required regression:

```text
OCR measured 8 days ago
General measured today
```

must yield:

```text
OCR      stale / not comparable
General  fresh / comparable when the task is General
```

Refreshing General must never refresh OCR.

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

## Commit G background profiler

When `routingMode: auto`, the profiler may gradually fill one axis at a time after an idle window.

It must never behave like a hidden Full benchmark.

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
one candidate + one missing/stale axis
```

After success, only that axis's score, latency, timestamp and fixture count are merged. Richer evidence on other axes must remain untouched.

### Axis priority

A recent foreground visual task may raise its direct benchmark axis to the front of the next background scan. Otherwise the background priority order is conservative and deterministic.

A recent Document task therefore makes a stale/missing `document` axis a preferred next target, without inventing evidence for UI/detection/etc. tasks that lack a direct axis.

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

### Unmeasured/stale barrier

```text
A: OCR 60 fresh
B: OCR unmeasured or stale
C: OCR 99 fresh
```

remains `A -> B -> C`. C cannot cross B using capability evidence.

### Small vs material difference

```text
A OCR 91, B OCR 94 -> keep order
A OCR 61, B OCR 94 -> may preview B -> A
```

The threshold remains 0.08.

## Preference checks

- **Quality**: direct fresh capability only.
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
score | median latency | own age | own freshness/Auto state
```

A mixed profile must be visibly mixed, for example:

```text
OCR      91 | 500ms | 8天前 | 已陈旧
General  88 | 420ms | 刚刚  | 可用于Auto
Document — 未测
```

No whole-profile age/fresh label may hide this distinction.

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

`measuredBackends` means a backend has at least routing-usable fresh evidence in the relevant shadow context; retained stale data is not silently promoted.

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

1. unmeasured/stale barriers always preserve capability order;
2. mixed-age profiles use only the current axis timestamp;
3. background default never spends chargeable cloud quota;
4. `all` only runs after explicit user selection;
5. foreground visual activity reliably preempts background work;
6. manual Benchmark reliably preempts background work;
7. provider failures back off without tight loops;
8. Quick/Full preflight/failure rules remain intact;
9. repeated large measured differences remain stable;
10. Balanced/Speed use same-axis latency only;
11. Local remains explicit policy;
12. real v1 output/order remains unchanged.

If those are not convincing, improve measurement/shadow behavior. Do not wire execution-changing Auto to compensate for weak evidence.

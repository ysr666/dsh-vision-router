# v2 shadow routing test guide

The v2 capability router is deliberately **shadow-only**. It computes an `autoPreviewOrder`, but the current v1 fallback chain remains the actual execution order.

## Enablement

For development testing:

```text
capabilityRoutingShadow: true
```

The product fields are:

```text
routingMode: ordered | auto
routingPreference: balanced | quality | speed | local
```

`routingMode: auto` is not execution-changing on this draft branch. Shadow mode remains observational.

## Benchmark first

The router does not infer capability from model names or families. Benchmark the routes you want to compare.

Quick benchmark:

- 3 sequential requests;
- Latin/UI OCR;
- Chinese chat OCR;
- general scene;
- coverage: `ocr`, `general`.

Full benchmark:

- 6 sequential requests;
- structured baseline;
- two OCR fixtures;
- grounding;
- document/table;
- general scene;
- coverage: `structured`, `ocr`, `document`, `grounding`, `general`.

There are no low/medium/high confidence tiers. The product records **coverage and freshness** instead.

Freshness rules:

- `<=7 days`: fresh and eligible for Auto comparison;
- `7–30 days`: stale, still visible in the Benchmark UI, not eligible for Auto comparison;
- `>30 days`: expired and not exposed as current measured product data.

The Benchmark panel displays each measured axis with its score and per-axis median latency. Missing axes remain `— 未测`.

## Queue behavior

- multiple models may be queued;
- one benchmark actually runs at a time;
- active duplicate requests are de-duplicated;
- running jobs show progress/current axis/elapsed time;
- queued jobs show queue position;
- running and queued jobs can be cancelled;
- browser refresh recovers in-process state;
- DSH restart intentionally does not resume chargeable jobs.

Auth/rate-limit/timeout/network/protocol/image-support/infrastructure failures fail fast. A failed retest preserves the previous valid profile. A lower-coverage Quick retest cannot replace a richer Full profile.

Cloud models show an in-panel request-count/cost note. Force verification for DSH-declared text-only models and one-request legacy grounding repair also remain inside the Benchmark panel.

## What capability routing is allowed to compare

Current direct benchmark axes are only:

```text
structured
ocr
document
grounding
general
```

Tasks such as `ui`, `detection`, `chart_diagram`, `code_screenshot`, and `visual_compare` do not currently have direct benchmark axes. Shadow must preserve configured order for capability comparison on those tasks instead of inventing proxy scores.

## Order-preservation cases

### No measurements

```text
configured: Gemini -> Qwen -> GLM -> Unknown
measured:   none
preview:    Gemini -> Qwen -> GLM -> Unknown
```

Model names must have zero effect.

### One-sided measurement

```text
A: unmeasured
B: OCR 99
```

Preview remains `A -> B` because A is unknown.

### Unmeasured barrier

```text
A: OCR 60
B: unmeasured
C: OCR 99
```

Preview remains `A -> B -> C`. C cannot cross B without evidence about B.

### Small measured difference

```text
A: OCR 91
B: OCR 94
```

Preview remains `A -> B` because the 3-point delta is below the current 8-point reorder threshold.

### Material measured difference

```text
A: OCR 61
B: OCR 94
```

A fresh comparison may preview `B -> A`.

### Stale measurements

If either route's relevant measurement is older than 7 days, that measurement is not eligible for Auto comparison. The user order remains the capability-routing baseline.

## Routing preferences

### Quality

Compare the directly measured capability score for the task axis.

### Balanced

Compare measured capability plus corresponding measured median latency.

### Speed

Give more weight to corresponding measured median latency, while still requiring measured capability on both sides.

### Local

Local-first is explicit user policy. It may stably move healthy local routes ahead of cloud routes even when capability is unmeasured. Within local/cloud groups, capability reordering remains measurement-only and conservative.

## Candidate pool checks

Verify that the routing pool contains only:

- configured provider/model rows and fallbacks;
- explicitly enabled local backends;
- explicitly configured HTTP visual backends;
- the built-in free tier as `fallback-only` when enabled.

Arbitrary DSH-discovered models that the user did not select must not enter `autoPreviewOrder`.

A built-in `fallback-only` route must never promote above user routes because of Benchmark. If the user explicitly selects that route in the chain, it becomes a normal user route.

## Breaker validation

Shadow reads the **same live v1 circuit breaker** through side-effect-free `peek()`.

Deliberately trip one configured backend with an auth/rate-limit/turn-scoped deterministic failure, then run another relevant visual tool call.

Expected behavior:

- the backend appears in `blockedBackends`;
- it moves behind healthy routes in `autoPreviewOrder`;
- its Benchmark capability scores do not change;
- v1 remains responsible for the real execution skip/fallback.

`peek()` must not prune cooldowns, touch LRU state, clear credential trips or record a new breaker event. Health-observation failures are neutral.

## Shadow plan fields

The plan exposes:

```text
currentOrder
autoPreviewOrder
suggestedOrder        # transitional alias of autoPreviewOrder
decisions
incomparableBackends
measuredBackends
unmeasuredBackends
healthBackends
blockedBackends
```

`decisions` contains structured reasons for actual preview movement, such as:

- `measured-advantage`;
- `rate-limited`;
- `circuit-open`.

This is the future source for a "why this model?" UI. The browser should not reimplement routing logic.

## Log format

Search logs for `v2 shadow`.

A compact line resembles:

```text
vision-router: v2 shadow mode=ordered preference=balanced intent=ocr strategy=balanced current=[A -> B -> C] suggested=[B -> A -> C] measured=[A, B] blocked=[C]
```

`measured` means **fresh, directly usable routing measurements**, not merely any profile retained in the 30-day UI cache.

## Safety contract

Shadow enablement must not change the visual tool result.

The wrapper does:

```text
observe
-> build preview
-> log diagnostics
-> call original v1 tool implementation unchanged
```

It does not reorder, skip, retry or replace an actual backend.

Actual v1 execution continues to own:

- fallback walking;
- circuit breaker;
- deadlines/timeouts;
- cancellation;
- resource governance;
- local-model stabilization;
- compatibility bridges;
- error classification.

Benchmark execution is a separate explicit action and disables Vision Router fallback. It must never silently benchmark a backup model.

## Gate before real Auto

Before wiring `autoPreviewOrder` into execution, collect real-provider shadow samples and answer:

1. Do unmeasured routes always preserve user order regardless of model name?
2. Do Quick results affect only OCR/general tasks?
3. Do Full results affect only the five directly measured axes?
4. Are stale results visible but absent from Auto comparison?
5. Are suggested large differences stable across repeated fresh runs?
6. Does the 8-point threshold suppress small benchmark noise?
7. Does local-first behave as explicit policy rather than a capability claim?
8. Do breaker-blocked routes match v1's actual availability behavior?
9. Do fallback-only built-ins stay behind user routes?
10. Does enabling shadow leave actual output and execution unchanged?

If those answers are not convincing, improve Benchmark or shadow logic. Do not enable real routing to compensate for weak validation.
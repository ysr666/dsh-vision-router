# v2 capability-aware vision routing

This document describes the current v2 routing target on `feat/v2-capability-router`. The branch remains **shadow-only**: v1.7.x execution order is still authoritative, and `routingMode: auto` is not connected to the real executor yet.

## Product contract

Normal users choose two things:

- **Routing mode**: `ordered` or `auto`;
- **Routing preference**: `balanced`, `quality`, `speed`, or `local`.

`capabilityRoutingShadow` is an internal validation flag, not the product switch.

The key product rule is:

> **The user decides preference; Benchmark provides facts; Vision Router does not guess model capability.**

Model names, provider names, model families and popularity do not create capability scores. An unmeasured model is simply unmeasured.

## Two inputs only

The router intentionally has only two capability-selection inputs:

1. **User intent**
   - configured model order;
   - routing preference;
   - explicit locality choice (`local`).
2. **Exact-endpoint measurements**
   - self-benchmark scores;
   - per-axis benchmark latency;
   - benchmark timestamp/freshness.

Runtime availability is a separate gate. Circuit-breaker state and rate limits can temporarily move an unavailable backend out of the way, but they never change its measured capability.

There is no capability evidence hierarchy. In particular, v2 does **not** use:

- family priors;
- generic priors;
- model-name inference;
- manual capability scores;
- provider/model reputation scores;
- measured/prior score blending.

## User order is the default truth

Auto routing starts from the user's configured order. It is not a global leaderboard sort.

If the configured order is:

```text
A -> B -> C
```

and there is no directly comparable fresh measurement, the result stays:

```text
A -> B -> C
```

A measured backend may not jump over an unmeasured backend merely because its own score is high. Doing so would implicitly claim that it is better than the unmeasured backend, which the router cannot know.

Example:

```text
A OCR 60
B unmeasured
C OCR 99
```

Auto preview remains:

```text
A -> B -> C
```

`B` is an information barrier.

## Task intents and benchmark axes are different types

The visual task vocabulary is broader than the current benchmark suite.

Current task intents:

- `structured`
- `ocr`
- `document`
- `ui`
- `grounding`
- `detection`
- `general`
- `chart_diagram`
- `code_screenshot`
- `visual_compare`

Current directly measured benchmark axes:

- `structured`
- `ocr`
- `document`
- `grounding`
- `general`

Only tasks with a direct measured axis can currently trigger a capability-based reorder.

The current router deliberately does **not** manufacture proxy formulas such as `ui = ocr + structured` or `detection = grounding + general`. For `ui`, `detection`, `chart_diagram`, `code_screenshot`, and `visual_compare`, the user's configured order remains intact until a dedicated measurement contract exists.

## Conservative reorder rule

Capability-based movement uses stable adjacent comparison, not full-array sorting.

Two adjacent user routes are comparable only when both have a fresh measurement for the task's direct benchmark axis. If either side is not comparable, no capability swap occurs across that boundary.

A reorder also requires a minimum measured advantage:

```text
AUTO_REORDER_MIN_ADVANTAGE = 0.08
```

So:

```text
A OCR 91
B OCR 94
```

stays `A -> B`, while a materially larger difference such as `61 -> 94` may produce `B -> A` in shadow preview.

The threshold is a stability guard against benchmark noise. It is not an evidence grade.

## Routing preferences

### Quality

`quality` uses the directly measured capability score for the current benchmark axis.

### Balanced

`balanced` combines directly measured capability with the corresponding measured median latency. No default/model-derived latency is invented when direct data is unavailable.

### Speed

`speed` gives more weight to the corresponding measured median latency while still requiring measured capability on both compared routes.

### Local

`local` is an explicit user policy, not a capability score. Healthy local routes are stably grouped ahead of cloud routes. Capability comparison is then conservative within those groups.

Because locality is user intent, this policy may cross an unmeasured cloud route. That is different from claiming one model has better visual ability.

## Runtime health is an availability gate

The shadow layer reads the same live v1 circuit breaker through a side-effect-free `peek()` seam.

A backend reported as circuit-open or rate-limited is temporarily moved behind healthy candidates. Its benchmark scores are not edited or penalized.

This gives explanations such as:

```text
planned: A -> B
A: rate limited
preview: B -> A
```

rather than pretending that A's visual capability became worse.

The read-only health seam must remain non-mutating:

- no cooldown pruning;
- no LRU touch;
- no credential-state clearing;
- no breaker recording;
- observation failures are neutral.

## Candidate pool

Automatic routing is limited to routes that belong to the user's Vision Router configuration or are explicitly enabled by the user.

Eligible user routes include:

- configured provider/model rows and fallbacks;
- explicitly enabled local backends;
- explicitly configured HTTP vision backends.

Arbitrary DSH-discovered vision models may appear in model pickers, but they do not silently enter the automatic routing pool.

The built-in anonymous free tier is marked `fallback-only` unless the user explicitly selected that route. A fallback-only backend cannot be promoted ahead of user routes by Benchmark.

## Exact-endpoint self-benchmark

Benchmarking uses generated fixtures, not user images.

The exactness contract remains strict:

- the selected provider/model/endpoint is fingerprinted with a secret-safe `ep2_` identity;
- Vision Router fallback is disabled during a benchmark;
- normal DSH providers use their exact registered adapter/provider/model first;
- a v1-compatible bridge may only reach the same provider/model's exact HTTP endpoint;
- plugin-owned `vision-http` routes use their exact configured HTTP backend;
- a fingerprint mismatch aborts persistence;
- endpoint URLs, credentials and raw model responses are not persisted in the profile or returned to the browser.

Profiles are stored atomically at:

```text
~/.dsh/cache/vision-router/capability-profiles.json
```

with mode `0600`.

## Coverage, not confidence tiers

Benchmark does not label results as low/medium/high confidence.

The product contract reports what was actually measured.

### Quick benchmark

Three sequential requests:

- Latin/UI OCR;
- Chinese chat OCR;
- general scene.

Coverage:

```text
OCR / General
```

A fresh Quick result may participate in an OCR or general comparison because those axes were directly measured. It cannot participate in structured/document/grounding comparison.

### Full benchmark

Six sequential requests:

- structured baseline;
- Latin/UI OCR;
- Chinese chat OCR;
- grounding;
- document/table;
- general scene.

Coverage:

```text
Structured / OCR / Document / Grounding / General
```

The UI also receives `medianLatencyMs` per measured axis, so speed/balanced routing can use the latency from the same task class rather than a generic guessed speed.

### Grounding diagnostic repair

Older rich profiles that have a grounding score but no stored grounding diagnostic can run one grounding request. The repair updates only grounding score/latency/diagnostic while preserving the richer profile's other axes, coverage and original full-suite timestamp.

## Freshness is eligibility, not evidence quality

Freshness is a time gate:

- `<= 7 days`: `fresh`, visible and eligible for Auto comparison;
- `7–30 days`: `stale`, still visible in UI but **not** eligible for Auto comparison;
- `> 30 days`: expired and not exposed as current measured product data.

The Benchmark API exposes:

```text
scores
coverage
coverageKind
measuredAt
freshness
autoEligible
medianLatencyMs
```

It does not expose a `confidence` tier.

The shadow router's `measuredBackends` list is fresh-only. A stale profile can remain visible in the Benchmark UI for human reference, but it is treated as unmeasured for capability-based Auto reordering.

## Benchmark queue and failure behavior

- FIFO queue;
- one actual benchmark executes at a time;
- duplicate active jobs are de-duplicated;
- maximum 32 active jobs;
- queued jobs revalidate provider/model/fingerprint before execution;
- running progress exposes completed/total/current axis/elapsed time;
- queued and running jobs can be cancelled;
- browser refresh restores in-process queue state;
- DSH restart intentionally does not resume chargeable jobs.

Auth, rate-limit, timeout, network, unsupported-image, protocol and benchmark-infrastructure failures fail fast. Operational failures do not overwrite the previous valid profile. A lower-coverage Quick retest cannot downgrade an existing richer Full profile.

## Benchmark UI contract

The model row stays compact and has one normal **Benchmark / 测评** entry.

Examples:

```text
部分测评 · OCR / 通用 · 2天前                  [测评]
完整测评 · 结构化 / OCR / 文档 / 定位 / 通用    [测评]
测评已陈旧 · 暂不参与自动选择                    [重新测评]
尚未测评 · 自动选择不会推断此模型能力             [测评]
```

The modal shows the five fixed axes with score and corresponding median latency. Missing axes display `— 未测`; they are never filled with inferred numbers.

Cloud cost notices, force-verification for DSH-declared text-only models, and grounding developer diagnostics remain inside the secondary panel rather than crowding the main row.

## Shadow output

When `capabilityRoutingShadow: true`, the planner returns diagnostics including:

```text
currentOrder
autoPreviewOrder
decisions
incomparableBackends
measuredBackends
unmeasuredBackends
blockedBackends
```

`currentOrder` remains the actual v1 order. `autoPreviewOrder` is observational only.

`decisions` explains concrete movement, for example a measured advantage or an availability block. This structure is intended to power the future "why this model?" UI without making the browser reimplement routing logic.

## Safety boundary

Nothing in this document authorizes execution-changing auto routing yet.

The current runtime still does:

```text
shadow plan
  -> log/inspect only
  -> invoke original v1 visual tool unchanged
```

It does not reorder, skip, retry or replace a backend in actual execution.

After shadow behavior is stable across real provider combinations, the eventual executor integration should only change the starting candidate order when `routingMode === 'auto'`. The existing v1 fallback, breaker, timeout, cancellation, resource-governance and error-classification paths should remain the execution engine.

## Validation gates before real Auto

Before connecting `autoPreviewOrder` to execution, verify:

1. unmeasured model names never alter order;
2. one-sided measurement never claims superiority over an unmeasured neighbor;
3. small measured differences remain stable under the configured order;
4. repeated fresh measurements produce stable large differences where reorder is suggested;
5. stale data never reorders;
6. local preference behaves as explicit policy, not inferred capability;
7. breaker/rate-limit state temporarily demotes the same backend v1 would avoid;
8. fallback-only built-ins never promote above user routes;
9. shadow enablement leaves the actual tool result and v1 execution unchanged.

Only after those gates are convincing should opt-in execution-changing `routingMode: auto` be considered.
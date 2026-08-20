# v2 capability-aware vision routing

This document is the design target for the v2 routing architecture. The implementation on `feat/v2-capability-router` was rebuilt on current `main` after the v1.7.x stabilization cycle, including the DSH rc.8 compatibility work. The branch deliberately keeps the current v1 execution order authoritative while capability routing is measured in shadow mode.

## Current implementation status

PR #142 was rebuilt from current `main` instead of copying its old high-conflict `index.js`, `lib/client.js`, and `package.json` changes wholesale. The pre-rebuild heads remain preserved on backup branches for history/recovery.

Implemented on the rebuilt branch:

- stable visual intent vocabulary and tool -> intent mapping;
- capability profiles, conservative family priors, measured evidence, user overrides, and policy-aware scoring;
- the stable scene signals from merged PR #178 (`visual_kind`, `content_kind`, `mixed_of`) are consumed rather than reimplemented;
- evidence-aware model reference generation;
- privacy-safe generated benchmark fixtures and secret-safe `ep2_` endpoint fingerprints;
- exact-backend benchmark execution with Vision Router fallback explicitly disabled;
- atomic persisted measured profiles under the existing DSH Vision Router cache area;
- default-off runtime shadow observation at the visual-tool boundary;
- per-model **快速测试 / Quick test**, **完整测试 / Full test**, and text-only **强制验证 / Force verify** controls;
- a server-side FIFO benchmark queue with de-duplication, progress, browser-refresh recovery, cancellation, and one actual benchmark running at a time;
- measured capability/latency summaries with fixed score order, freshness and confidence labels;
- operational failure classification and fail-fast behavior for auth/rate-limit/timeout/network/protocol/image-support/infrastructure failures;
- grounding-coordinate normalization before IoU scoring;
- all v2 suites are included in the normal package test command.

Not implemented yet:

- execution-changing `capabilityRouting`;
- making v2 ordering the actual fallback order;
- exposing the current v1 circuit-breaker state to the outer shadow layer;
- the agent `preferredBackend` experiment from the original prototype.

The old temporary workflow/script that modified the branch and committed/pushed from GitHub Actions is not part of the rebuilt branch. Repository writes use the normal branch -> commit -> PR flow.

## Concept attribution and scope

The **scene-aware routing direction** in this v2 design was informed in part by earlier discussions with [@shaoqiuyuavailable](https://github.com/shaoqiuyuavailable) and his earlier `dsh-vision` work: classify the visual scene/content first, then use that signal to guide a more suitable visual path instead of forcing every image through one undifferentiated chain.

That attribution is scoped to the concept/direction. The capability-aware backend profile/scoring model, health/cost/privacy weighting, shadow observation, evidence-aware model reference, self-benchmark/fingerprint design, persistence, queueing, and the concrete v2 router architecture in this document are engineered for `dsh-vision-router`.

PR #178 has merged into `main`. Its normalized structured-bootstrap contract is now the stable scene-classification input for v2. `content_kind` remains subject metadata; it does not by itself turn a machine or architecture photo into a `chart_diagram` task.

## Why the v1 chain stops scaling

The current router answers one question well: **which configured vision backend should be tried next when a call fails?**

A v2 router needs to answer a different question first: **which backend is best suited to this visual operation?** OCR, document parsing, UI understanding, grounding, detection, diagram reading and general scene understanding are different capabilities. A single fixed order cannot express that without forcing one backend to be the default specialist for every task.

## Core contract

DeepSeek/the session agent chooses **what visual capability it needs**. Vision Router chooses **which vision backend is best suited to execute it**.

```text
image
  -> vision_bootstrap (task-independent structured baseline)
  -> normalized visual_kind / content_kind / mixed_of
  -> DeepSeek reasons over the user's request + baseline
  -> visual tool intent (ocr / grounding / detection / ui / ...)
  -> capability router scores the current backend pool
  -> shadow: compare recommendation with current v1 order
  -> future opt-in runtime: best healthy backend executes first
```

The agent should not receive a permanent hard-coded leaderboard. Model selection belongs primarily inside Vision Router and should be backed by evidence from the exact endpoint the user configured.

## Scene signals from #178

The capability router consumes the already-normalized bootstrap result instead of adding a second classifier.

Current bridge:

- `document` -> `document`
- `ui` -> `ui`
- `chat` -> `ui`
- `code` -> `code_screenshot`
- `general` / `unknown` -> `general`
- `mixed` -> up to two intents from normalized `mixed_of`, preserving the same information priority used by the structured-bootstrap layer (`ui`, `document`, `code`, `chat`, `general`)

An explicit requested operation still wins over scene fallback. A request to explain a circuit schematic is `chart_diagram` even if the bootstrap classified its media container as `document`.

## Intent vocabulary

- `structured` — task-independent first-pass visual map (`vision_bootstrap`)
- `ocr` — exact text transcription
- `document` — documents, forms, tables, long screenshots
- `ui` — web/app/chat UI semantic understanding
- `grounding` — locate one requested target
- `detection` — enumerate/localize a class of elements
- `general` — ordinary scene/image understanding
- `chart_diagram` — charts, architecture diagrams, schematics, circuits
- `code_screenshot` — IDE, source, terminal, traceback, logs
- `visual_compare` — semantic or pixel-oriented multi-image comparison

`vision_describe` may refine its intent from the requested operation and can use the bootstrap scene signal only when the question itself is generic.

## Capability evidence hierarchy

A permanent hard-coded leaderboard is intentionally **not** the source of truth. New or renamed models can appear faster than the plugin ships, and the same model name can behave differently across providers, relays, quantization and endpoint configuration.

Evidence order:

1. **exact-endpoint measured/self-benchmark evidence**;
2. **explicit user override**;
3. **official provider/model capability claims** when available;
4. **conservative family prior**;
5. **unknown generic prior** so future models remain routable without invented specialist strengths.

Unknown models stay explicitly unverified until stronger evidence exists.

## Exact-backend self-benchmark

`lib/vision-capability-benchmark.js` owns generated privacy-safe fixtures, scoring, aggregation and `ep2_` fingerprints. `lib/vision-capability-probe.js` owns sequential fixture execution and persisted profile records. `lib/vision-capability-benchmark-service.js` owns the current executable pool, queue, exact invoker, job state, failure policy and browser API.

The benchmark contract is intentionally strict:

- only one actual benchmark runs at a time; additional models join a FIFO queue;
- duplicate clicks for an already queued/running backend are de-duplicated;
- a queued job revalidates the selected provider/model/fingerprint before it starts, so settings changes cannot write evidence under the wrong route;
- the in-memory active queue is bounded (32 jobs) and is intentionally not resumed after a DSH process restart; browser refreshes do recover the live queue/job state;
- fixtures for one backend run sequentially, keeping latency comparable and avoiding local GPU/API concurrency distortion;
- Vision Router fallback is disabled;
- endpoint-scoped OpenAI Chat Completions providers call the exact endpoint/model directly;
- routes without a supported exact HTTP path use the exact registered DSH adapter/provider/model rather than the Vision Router fallback walk;
- a changed/mismatched endpoint fingerprint is rejected before persistence;
- auth, rate-limit, timeout, network, unsupported-image, unsupported-protocol and benchmark-infrastructure errors fail fast on the first affected fixture instead of spending the rest of the request budget;
- operational failures never overwrite an existing valid profile;
- a lower-coverage quick retest never replaces a richer full profile for the same fingerprint;
- persisted records contain fingerprint, provider/model identity, scores, latency summary, fixture/failure counts and timestamp only;
- endpoint URLs, API keys and arbitrary provider configuration are not persisted in the capability profile record or returned to the browser.

Profile state is stored as an atomic mode-`0600` JSON cache under `~/.dsh/cache/vision-router/`. The default profile retention is 30 days. In the UI, results are `fresh` for 7 days, marked stale from 7–30 days, and no longer exposed as measured routing evidence after 30 days. Shadow scoring uses the same 30-day hard cutoff.

### Quick vs full benchmark

The default **Quick test** is deliberately small:

- Latin/UI OCR;
- Chinese chat OCR;
- general scene understanding.

That is three model requests and produces a **low-confidence basic profile**. It does not claim to have measured structure, document parsing or grounding.

The **Full test** runs six requests:

- structured baseline;
- Latin/UI OCR;
- Chinese chat OCR;
- grounding;
- document/table reading;
- general scene understanding.

A successful six-fixture profile is currently labeled **medium confidence**. The fixture set is intentionally small and must not be presented as an external/authoritative benchmark.

### Grounding normalization

Grounding is scored on geometric accuracy, not strict output syntax alone. Before IoU is computed, the scorer accepts common response shapes (`x1/y1/x2/y2`, `left/top/right/bottom`, `x/y/width/height`, nested `bbox`/`box`, or a four-number array) and normalizes common coordinate spaces:

- image pixels;
- normalized `0..1`;
- percentages `0..100`;
- common normalized `0..1000` coordinates.

The score details retain `formatValid`, response shape and detected coordinate space so a formatting issue is distinguishable from poor localization.

## Benchmark queue and UI

Vision Router's existing model rows receive an independent second-line benchmark control through a separate browser prelude. This avoids rewriting the v1.7 settings component or its save/readback path.

Normal rows expose **快速测试 / Quick test** and **完整测试 / Full test**. Models that DSH explicitly declares text-only do not present a normal capability test; they expose **强制验证 / Force verify** so users can explicitly test providers whose catalog metadata is known to be wrong.

Queue UX:

```text
running:  测试中 1/3 · OCR · 5.2s                 [停止测试]
queued:   排队中 · 第1位 · 快速测试               [取消排队]
finished: OCR 82 · 通用 91 · 中位 4.8s · 刚刚 · 低置信度
```

The browser polls while work is active, so refreshing the settings page restores running/queued progress. It can cancel queued work or abort the currently running job.

Cloud backends that are not known-free show a confirmation explaining the approximate number of generated-image requests (quick ≈3, full ≈6) and that API charges may apply. Local/known-free backends do not show that cost warning.

Failure labels distinguish at least:

- authentication failure;
- rate limit;
- timeout;
- image input rejected;
- benchmark protocol unsupported;
- benchmark infrastructure failure;
- network failure;
- generic provider failure;
- cancellation.

If a retest fails while a previous valid profile exists, the UI keeps the previous scores and reports the new failure separately.

The browser can see only public candidate identity/locality/protocol/fingerprint/benchmarkability, job state and measured summary. It cannot see endpoint URLs or credentials. The DOM observer is scoped to Vision Router's model-chain rows, so normal streaming chat DOM updates do not continuously trigger settings-row scans. The benchmark UI never mutates Vision Router settings.

### Adapter-route attachment note

Exact HTTP endpoint tests send the generated fixture as request-local image data and do not create DSH attachments. A forced adapter-route test may need `ctx.attachments.saveImage()` because that is how the DSH adapter receives an image. DSH's public attachment service is immutable and currently exposes validate/save/read rather than deletion. The benchmark fixtures are deterministic/content-addressed, so repeat runs reuse a finite fixture set instead of intentionally creating unique test images each time; a future upstream retention seam can be used if one becomes available.

## Ranking

A candidate score can combine:

- capability match for the current intent;
- backend health;
- latency;
- cost/free status;
- local/privacy preference.

User-facing policies:

- `quality`
- `balanced`
- `speed`
- `privacy`

The existing configured order remains the deterministic tie-breaker.

### Current health caveat

The scoring core already supports circuit-open/rate-limit/recent-failure health input. The current v1 circuit breaker, however, is internal to `index.js`; the rebuilt outer shadow layer intentionally does not reach through that private closure.

Therefore the **current shadow runtime treats health as neutral/default** while comparing capability/latency/cost/privacy evidence. Actual v1 execution still applies its real circuit breaker normally. Before any execution-changing v2 routing is enabled, the next runtime seam should expose a narrow read-only breaker snapshot to shadow scoring rather than copying or replacing the v1 breaker implementation.

## Runtime shadow routing

`capabilityRoutingShadow` defaults to `false`. When enabled, the outer tool boundary observes supported visual tool calls, derives the intent, enumerates the current candidate pool, loads non-expired measured `ep2_` profiles where available, and logs:

```text
intent / strategy
current candidate order
v2 suggested order
which candidates have measured evidence
```

The wrapper then invokes the original tool implementation unchanged. It does **not** reorder, skip, retry or replace any backend. With shadow disabled it does no candidate enumeration for tool calls.

The bootstrap evidence is remembered per session only for shadow intent fallback, allowing a later generic `vision_describe` to reuse #178's normalized scene classification without changing the actual tool result.

## Migration plan

### Phase 1 — capability/evidence core

Implemented: intent mapping, #178 scene bridge, profiles, priors, measured evidence merge, policies, scorer, diagnostics, fixtures, endpoint fingerprints and persistence.

### Phase 2 — shadow validation

Implemented in default-off form: compare the current candidate order with v2 scoring while v1 remains authoritative.

Next work inside this phase:

- expose a narrow read-only snapshot of v1 breaker health to shadow scoring;
- collect/inspect shadow diagnostics across real provider combinations;
- expand fixtures where the current quick/full set is too weak;
- only after validation, consider the agent `preferredBackend` comparison experiment.

### Phase 3 — benchmark UI

Implemented experimentally: quick/full exact capability testing, FIFO queue, progress/cancel, failure classification, freshness/confidence and persisted measured tags/latency. It still needs real DSH browser/provider validation before being considered stable UX.

### Phase 4 — opt-in runtime routing

Not implemented. Add `capabilityRouting: true` only after shadow/benchmark evidence is trustworthy. It should reuse the existing v1 executor and circuit breaker while changing only candidate ordering.

### Phase 5 — v2 default

Only after opt-in runtime evidence is stable should capability-aware ordering become the normal path. The old fixed chain remains a compatibility behavior during migration.

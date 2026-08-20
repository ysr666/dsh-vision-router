# v2 capability-aware vision routing

This document is the design target for the v2 routing architecture. The implementation on `feat/v2-capability-router` was rebuilt on current `main` after the v1.7.x stabilization cycle, including the DSH rc.8 compatibility work. The branch deliberately keeps the current v1 execution order authoritative while capability routing is measured in shadow mode.

## Product contract first

Vision Router should not ask normal users whether they want to "enable v2" or "enable capability routing". Those are implementation concepts. The user-facing decision is:

- **Routing mode**: `auto` or `ordered`;
- **Routing preference**: `balanced`, `quality`, `speed`, or `local`.

In UI language these become **自动选择 / Auto select**, **固定顺序 / Fixed order**, **均衡 / Balanced**, **效果优先 / Quality**, **速度优先 / Speed**, and **本地优先 / Local first**.

`capabilityRoutingShadow` remains an internal development/validation control. It is not the product switch. The scorer's historical internal `privacy` strategy is mapped from the clearer user-facing `local` preference rather than exposed directly.

The current draft defaults to `routingMode: ordered` because execution-changing auto routing is not wired yet. This avoids presenting a switch that the runtime cannot honestly honor. Once auto execution has passed shadow, breaker-health, cost/locality and real-provider validation gates, the stable 2.0 release can make `auto` the default for new installations while keeping `ordered` permanently available for deterministic behavior.

A configured model order is not disposable metadata. It can encode cost, privacy/locality, speed and personal preference. Auto routing therefore must be conservative: weak or missing evidence should preserve the configured order; only sufficiently strong evidence or health constraints should justify moving away from it.

## Current implementation status

PR #142 was rebuilt from current `main` instead of copying its old high-conflict `index.js`, `lib/client.js`, and `package.json` changes wholesale. The pre-rebuild heads remain preserved on backup branches for history/recovery.

Implemented on the rebuilt branch:

- stable visual intent vocabulary and tool -> intent mapping;
- explicit product semantics for `routingMode` and `routingPreference`, with old prototype strategy names kept only as compatibility input;
- capability profiles, conservative family priors, measured evidence, user overrides, and policy-aware scoring;
- the stable scene signals from merged PR #178 (`visual_kind`, `content_kind`, `mixed_of`) are consumed rather than reimplemented;
- evidence-aware model reference generation;
- privacy-safe generated benchmark fixtures and secret-safe `ep2_` endpoint fingerprints;
- exact-backend benchmark execution with Vision Router fallback explicitly disabled;
- atomic persisted measured profiles under the existing DSH Vision Router cache area;
- default-off runtime shadow observation at the visual-tool boundary;
- a compact per-model benchmark entry that opens quick/full/force/diagnostic actions in a secondary panel instead of crowding the settings row;
- a server-side FIFO benchmark queue with de-duplication, progress, browser-refresh recovery, cancellation, and one actual benchmark running at a time;
- measured capability/latency summaries with fixed score order, freshness and confidence labels;
- operational failure classification and fail-fast behavior for auth/rate-limit/timeout/network/protocol/image-support/infrastructure failures;
- grounding-coordinate normalization before IoU scoring, plus one-request repair for legacy full profiles that lack grounding diagnostics;
- all v2 suites are included in the normal package test command.

Not implemented yet:

- execution-changing `routingMode: auto`;
- a conservative evidence threshold/order-prior policy for real auto routing;
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
  -> capability router evaluates the current backend pool
  -> shadow: compare recommendation with current ordered execution
  -> future auto mode: reorder only when evidence/health justifies it
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

Unknown models stay explicitly unverified until stronger evidence exists. Benchmarking is an enhancement, not an initialization requirement: unmeasured models remain usable and auto routing must fall back conservatively toward configured order when evidence is weak.

## Exact-backend self-benchmark

`lib/vision-capability-benchmark.js` owns generated privacy-safe fixtures, scoring, aggregation and `ep2_` fingerprints. `lib/vision-capability-probe.js` owns sequential fixture execution and persisted profile records. `lib/vision-capability-benchmark-service.js` owns the current executable pool, queue, exact invoker, job state, failure policy and browser API.

The benchmark contract is intentionally strict:

- only one actual benchmark runs at a time; additional models join a FIFO queue;
- duplicate clicks for an already queued/running backend are de-duplicated;
- a queued job revalidates the selected provider/model/fingerprint before it starts, so settings changes cannot write evidence under the wrong route;
- the in-memory active queue is bounded (32 jobs) and is intentionally not resumed after a DSH process restart; browser refreshes do recover the live queue/job state;
- fixtures for one backend run sequentially, keeping latency comparable and avoiding local GPU/API concurrency distortion;
- Vision Router fallback is disabled;
- normal DSH providers are called through their exact registered adapter/provider/model first; if that exact adapter fails with an error class that v1 itself permits to bridge, the benchmark may bridge to the same provider/model's exact HTTP endpoint, never to a backup model;
- plugin-owned `vision-http` routes use their exact configured HTTP backend directly;
- a changed/mismatched endpoint fingerprint is rejected before persistence;
- auth, rate-limit, timeout, network, unsupported-image, unsupported-protocol and benchmark-infrastructure errors fail fast on the first affected fixture instead of spending the rest of the request budget;
- operational failures never overwrite an existing valid profile;
- a lower-coverage quick retest never replaces a richer full profile for the same fingerprint;
- a one-request grounding diagnostic repair may update only the stored grounding score/latency/diagnostic of an existing richer profile while retaining its other scores, full fixture coverage, and original full-suite timestamp;
- persisted records contain fingerprint, provider/model identity, scores, latency summary, fixture/failure counts, timestamp and bounded safe diagnostic fields only;
- endpoint URLs, API keys, raw model replies and arbitrary provider configuration are not persisted in the capability profile record or returned to the browser.

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

For old full profiles that already contain a grounding score but predate persisted grounding diagnostics, the UI offers **Diagnose grounding**. It sends one grounding request, repairs the grounding score/latency/diagnostic in that existing profile, and leaves the other capability scores and full-suite timestamp untouched.

### Grounding normalization

Grounding is scored on geometric accuracy, not strict output syntax alone. Before IoU is computed, the scorer accepts common response shapes (`x1/y1/x2/y2`, `left/top/right/bottom`, `x/y/width/height`, nested `bbox`/`box`, four-number arrays, common GLM box markers, and similar wrappers) and normalizes common coordinate spaces:

- image pixels;
- normalized `0..1`;
- percentages `0..100`;
- common normalized `0..1000` coordinates.

The score details retain `formatValid`, response shape and detected coordinate space so a formatting issue is distinguishable from poor localization.

## Benchmark queue and UI

Vision Router's existing model rows receive an independent second-line benchmark control through a separate browser prelude. This avoids rewriting the v1.7 settings component or its save/readback path.

The main settings row is intentionally compact:

```text
measured: 实测能力 · 结构 100 · OCR 50 · 文档 100 · 定位 95 · 通用 75   [测评]
untested: 尚未测评                                                   [测评]
running:  正在测评 2/3 · OCR · 8.4s                                  [停止]
queued:   排队中 · 第2位 · 快速测试                                   [取消]
```

There is only one normal **Benchmark / 测评** entry point on the row. Opening it shows a secondary in-app panel containing the actions that used to crowd the main row:

- Quick test / quick retest;
- Full test / full retest;
- force-verify image support for DSH-declared text-only models;
- one-request grounding diagnostic repair when an older full profile needs it;
- current measured score/meta information;
- grounding result summary where available.

Grounding engineering fields (`parseSource`, response shape, coordinate space, normalized box, candidate spaces) live under a collapsed **Developer details / 开发者信息** section in the panel. The benchmark UI no longer uses native browser `alert()` or `confirm()` dialogs for normal results/cost messaging.

Cloud backends that are not known-free show an unobtrusive note in the panel explaining the approximate request counts (quick ≈3, full ≈6, grounding repair ≈1) and that API charges may apply. Local/known-free backends do not need that warning.

The browser polls while work is active, so refreshing the settings page restores running/queued progress. It can cancel queued work or abort the currently running job. Failure labels distinguish authentication, rate limit, timeout, image rejection, unsupported benchmark protocol, benchmark infrastructure, network, generic provider failures and cancellation.

If a retest fails while a previous valid profile exists, the UI keeps the previous scores and reports the new failure separately.

The browser can see only public candidate identity/locality/protocol/fingerprint/benchmarkability, job state and measured summary. It cannot see endpoint URLs or credentials. The DOM observer is scoped to Vision Router's model-chain rows, so normal streaming chat DOM updates do not continuously trigger settings-row scans. The benchmark UI never mutates Vision Router settings.

### Adapter-route attachment note

Exact HTTP endpoint tests send the generated fixture as request-local image data and do not create DSH attachments. An adapter-route test may need `ctx.attachments.saveImage()` because that is how the DSH adapter receives an image. DSH's public attachment service is immutable and currently exposes validate/save/read rather than deletion. The benchmark fixtures are deterministic/content-addressed, so repeat runs reuse a finite fixture set instead of intentionally creating unique test images each time; a future upstream retention seam can be used if one becomes available.

## Ranking and conservative auto-routing

The scoring core can combine:

- capability match for the current intent;
- backend health;
- latency;
- cost/free status;
- local/private execution.

The product preferences map to those weights as follows:

- `balanced` — balanced capability, health, latency and cost;
- `quality` — place more weight on measured capability;
- `speed` — place more weight on latency;
- `local` — strongly prefer local/private execution (currently mapped internally to the historical `privacy` scoring strategy).

The current shadow scorer still uses configured order only as a deterministic tie-breaker. **That is not the final auto-routing policy.** Before `routingMode: auto` may alter execution, configured order must become an explicit preference prior / conservative gate: small score differences or low-confidence evidence keep the user's order; meaningful measured differences or unhealthy backends can justify a reorder. Auto mode must also avoid silently escalating from local/free choices to paid cloud merely because a cloud model has a slightly higher capability prior.

## Current health caveat

The scoring core already supports circuit-open/rate-limit/recent-failure health input. The current v1 circuit breaker, however, is internal to `index.js`; the rebuilt outer shadow layer intentionally does not reach through that private closure.

Therefore the **current shadow runtime treats health as neutral/default** while comparing capability/latency/cost/privacy evidence. Actual v1 execution still applies its real circuit breaker normally. Before any execution-changing auto routing is enabled, the next runtime seam should expose a narrow read-only breaker snapshot to shadow scoring rather than copying or replacing the v1 breaker implementation.

## Runtime shadow routing

`capabilityRoutingShadow` defaults to `false`. It is a developer validation flag, not a user-facing routing mode. When enabled, the outer tool boundary observes supported visual tool calls, derives the intent, resolves the product `routingMode` / `routingPreference`, enumerates the current candidate pool, loads non-expired measured `ep2_` profiles where available, and logs the current order against the scorer's suggested order.

The wrapper then invokes the original tool implementation unchanged. It does **not** reorder, skip, retry or replace any backend. With shadow disabled it does no per-tool candidate enumeration for tool calls.

The bootstrap evidence is remembered per session only for shadow intent fallback, allowing a later generic `vision_describe` to reuse #178's normalized scene classification without changing the actual tool result.

## Migration plan

### Phase 1 — capability/evidence core

Implemented: intent mapping, #178 scene bridge, profiles, priors, measured evidence merge, product routing vocabulary, policies, scorer, diagnostics, fixtures, endpoint fingerprints and persistence.

### Phase 2 — shadow validation

Implemented in default-off form: compare the current candidate order with v2 scoring while ordered v1 execution remains authoritative.

Next work inside this phase:

- make configured order an explicit conservative preference signal rather than only a tie-breaker;
- expose a narrow read-only snapshot of v1 breaker health to shadow scoring;
- collect/inspect shadow diagnostics across real provider combinations;
- expand fixtures where the current quick/full set is too weak;
- only after validation, consider the agent `preferredBackend` comparison experiment.

### Phase 3 — benchmark UI

Implemented experimentally: compact one-entry benchmark UI, secondary quick/full/force/diagnostic panel, FIFO queue, progress/cancel, failure classification, freshness/confidence and persisted measured tags/latency. It still needs one final real DSH browser pass before being considered stable UX.

### Phase 4 — auto execution

Not implemented. Once the conservative order prior and read-only breaker health seam are validated, `routingMode: auto` may reorder candidates while reusing the existing v1 executor and breaker. `routingMode: ordered` must continue to execute strictly in the configured order.

There should be no separate user-facing "enable v2" or `capabilityRouting` switch.

### Phase 5 — 2.0 default

Only after auto execution evidence is stable should **new 2.0 installations** default to `routingMode: auto`. Fixed/ordered mode remains a permanent compatibility and deterministic-control option. Upgrade behavior should be chosen separately and conservatively so an update cannot unexpectedly increase paid-cloud usage or violate a user's local-first intent.

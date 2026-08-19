# v2 capability-aware vision routing

This document is the design target for a major-version routing change. The implementation on `feat/v2-capability-router` is rebuilt on current `main` (including the DSH rc.8 compatibility work) and keeps the current v1 execution order unchanged while the capability core is validated.

## Current implementation status

After the v1.7.x stabilization cycle, #142 was deliberately rebuilt from current `main` instead of rebasing its old high-conflict runtime files wholesale.

Implemented on the current branch:

- intent/profile/scoring core;
- evidence-aware model references;
- privacy-safe synthetic capability fixtures and `ep2_` endpoint fingerprints;
- exact-backend benchmark runner with fallback forbidden;
- persisted measured capability profiles under the existing DSH Vision Router cache area;
- the stable `content_kind` / `mixed_of` scene signals from merged PR #178 are consumed by the capability core;
- standalone capability/probe tests are part of the normal test command.

Intentionally not restored yet:

- runtime shadow wiring in `index.js`;
- shadow settings/UI in `lib/client.js`;
- any execution-changing `capabilityRouting` switch.

Those runtime pieces are being reintroduced against the current v1.7/rc.8 architecture rather than copying the old implementation. The old temporary workflow/script that modified the branch and committed/pushed from GitHub Actions is not part of the rebuilt branch; repository writes follow the normal branch/commit/PR flow.

## Concept attribution and scope

The **scene-aware routing direction** in this v2 design was informed in part by earlier discussions with [@shaoqiuyuavailable](https://github.com/shaoqiuyuavailable) and his earlier `dsh-vision` work: classify the visual scene/content first, then use that signal to guide a more suitable visual path instead of forcing every image through one undifferentiated chain.

That attribution is intentionally scoped to the concept/direction. The capability-aware backend profile and scoring model, health/cost/privacy weighting, shadow routing, evidence-aware model reference, self-benchmark/fingerprint design, and the concrete v2 router architecture in this document are engineered for `dsh-vision-router`.

PR #178 has now merged into `main`. Its normalized structured-bootstrap contract is the stable scene-classification input for v2: `visual_kind`, `content_kind`, and `mixed_of` are consumed rather than reimplemented. `content_kind` remains subject metadata; it does not by itself turn a machine or architecture photo into a `chart_diagram` task.

## Why the v1 chain stops scaling

The current router answers one question well: **which configured vision backend should be tried next when a call fails?**

A v2 router needs to answer a different question first: **which backend is best suited to this visual operation?** OCR, document parsing, UI understanding, grounding, detection, diagram reading and general scene understanding are different capabilities. A single top-to-bottom chain cannot express that without forcing one model to be the default specialist for every task.

## Core contract

DeepSeek/the session agent chooses **what visual capability it needs** by choosing a tool. Vision Router chooses **which visual model should execute that capability**.

```text
image
  -> vision_bootstrap (task-independent structured baseline)
  -> normalized visual_kind / content_kind / mixed_of
  -> DeepSeek reasons over user request + baseline
  -> visual tool intent (ocr / grounding / detection / ui / ...)
  -> capability router ranks the user's vision model pool
  -> best healthy backend executes
  -> result returns to DeepSeek
  -> repeat as needed
```

The agent should not receive a long permanent leaderboard. Model selection belongs primarily inside Vision Router.

## Scene signals from #178

The capability router consumes the already-normalized bootstrap result instead of adding another classifier.

Current bridge:

- `document` -> `document`
- `ui` -> `ui`
- `chat` -> `ui`
- `code` -> `code_screenshot`
- `general` / `unknown` -> `general`
- `mixed` -> up to two intents from normalized `mixed_of`, preserving the same information priority used by the structured-bootstrap layer (`ui`, `document`, `code`, `chat`, `general`)

An explicit tool/requested operation still wins over the scene fallback. For example, a request to explain a circuit schematic remains `chart_diagram` even when the bootstrap classified the media container as a document.

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

A tool maps to an intent. `vision_describe` can refine its intent from the requested operation and may fall back to the bootstrap scene signal when the question is otherwise generic, but it still never chooses a model itself.

## Capability profile

Each backend gets a normalized profile containing per-intent scores, confidence and traits such as latency/cost/locality. Ranking is per visual call, not per conversation.

### Capability evidence hierarchy

A permanent hard-coded leaderboard is intentionally **not** the source of truth. New or renamed models can appear faster than this plugin can ship releases, and the same model name can behave differently across providers, quantization and relays.

Use evidence in this order:

1. **exact-endpoint measured/self-benchmark evidence** — strongest long-term source;
2. **explicit user override** — exact configured backend knowledge;
3. **provider/model official claims** when available — useful seeding, not final truth;
4. **conservative family prior** — weak bootstrap evidence only;
5. **unknown generic prior** — keeps future models routable without inventing specialist strengths.

Unknown models are shown to the agent as **unverified** rather than being assigned confident OCR/grounding/UI claims from a generic score.

`lib/vision-capability-reference.js` builds compact references and plans a task-first probe set:

```text
current task intent -> structured -> OCR -> grounding -> general
```

## Exact-backend self-benchmark

`lib/vision-capability-benchmark.js` owns generated privacy-safe fixtures, scoring, aggregation and `ep2_` fingerprints. `lib/vision-capability-probe.js` owns execution and persistence.

The runner contract is intentionally strict:

- probes are sequential and explicitly request one exact backend;
- `allowFallback` is false;
- when the transport reports the backend fingerprint actually used, a mismatch aborts the benchmark instead of recording another backend's output;
- ordinary provider failures become zero-score evidence for that exact endpoint rather than silently switching models;
- persisted records contain only the fingerprint, provider/model identity, measured scores, latency summary, fixture count and failure count;
- endpoint URLs, API keys and arbitrary provider config are not persisted in the capability profile record.

Profile state is stored as an atomic, mode-`0600` JSON cache under the existing `~/.dsh/cache/vision-router/` area. Corrupt and expired cache entries fail soft.

Current generated fixtures cover:

- structured baseline;
- Latin/UI OCR;
- Chinese chat screenshot OCR;
- grounding;
- document/table reading;
- general scene understanding.

Future fixture expansion can cover detection, UI relationships, chart/diagram reasoning and code screenshots without changing the evidence contract.

## Ranking

A candidate score combines:

- capability match for the current intent;
- backend health (circuit breaker, recent failures, rate limiting);
- latency;
- cost/free status;
- local/privacy preference.

User-facing policies:

- `quality`
- `balanced`
- `speed`
- `privacy`

The existing configured order remains the deterministic tie-breaker.

## Phase 1 — capability core

Implemented on the rebuilt branch:

- standalone intent vocabulary;
- tool -> intent mapping;
- #178 structured-scene -> capability bridge;
- conservative family priors;
- measured + override profile merge;
- policy-aware scorer/ranker;
- health-aware ordering primitives;
- diagnostics explanation output;
- exact-backend benchmark/persistence primitives;
- unit tests.

## Phase 2 — shadow routing

Runtime shadow routing is the next integration step. It will be wired into `vision_describe` and the shared model-backed tool executor on the **current** v1.7/rc.8 runtime.

When enabled, it will compute and log `current order` vs `v2 suggested order`, while actual execution continues to iterate the original v1 candidate order. The shadow plan will include current circuit-breaker state, local/privacy traits, direct HTTP fallbacks and measured `ep2_` profiles when available.

`vision_bootstrap` remains the `structured` operation. Later follow-up calls can consume #178 scene signals when the requested operation itself is generic.

### Agent-reference shadow experiment

After runtime shadow wiring is restored, the first bootstrap prompt may receive a compact evidence-aware model reference. DeepSeek may submit a shadow-only `preferredBackend` chosen from that reference.

The router will compare:

```text
actual v1 order
agent preferred backend
v2 scorer order
measured capability evidence
```

`preferredBackend` remains **diagnostic only** and must never change execution order during shadow validation.

## Settings UX target

The main card should eventually replace the mental model of a single **vision fallback chain** with a **vision model pool**:

- Smart vision routing: on/off
- Policy: Quality / Balanced / Speed / Local privacy
- Model pool rows with evidence-aware capability tags
- One-click `Test model capabilities`

Advanced settings can expose per-intent preferred/blocked models and raw profile overrides. Ordinary users should not maintain a capability matrix manually.

The first UI increment should expose **Test model capabilities** without enabling execution-changing routing. It should run the exact-backend benchmark, persist the measured profile, and render evidence provenance/latency/capability tags.

## Migration phases

### Phase 2 — shadow validation

Reintroduce runtime shadow scoring on current main and compare fixed-order execution, agent recommendation, scorer ranking and measured endpoint evidence. No execution order changes.

### Phase 3 — benchmark UI

Expose opt-in exact-backend model capability testing and measured profile tags in the settings model pool.

### Phase 4 — opt-in runtime routing

Add `capabilityRouting: true`. Use v2 ordering for tool-side visual calls while preserving the current fallback executor and circuit breaker.

### Phase 5 — v2 default

Only after shadow and benchmark evidence show stable routing: make capability-aware ordering the normal path and keep the old fixed chain as compatibility behavior.

# v2 capability-aware vision routing

This document is the design target for a major-version routing change. The implementation on `feat/v2-capability-router` keeps the current v1 execution order by default while adding an intent/profile/scoring core and shadow experiments.

## Why the v1 chain stops scaling

The current router answers one question well: **which configured vision backend should be tried next when a call fails?**

A v2 router needs to answer a different question first: **which backend is best suited to this visual operation?** OCR, document parsing, UI understanding, grounding, detection, diagram reading and general scene understanding are different capabilities. A single top-to-bottom chain cannot express that without forcing one model to be the default specialist for every task.

## Core contract

DeepSeek/the session agent chooses **what visual capability it needs** by choosing a tool. Vision Router chooses **which visual model should execute that capability**.

```text
image
  -> vision_bootstrap (task-independent structured baseline)
  -> DeepSeek reasons over user request + baseline
  -> visual tool intent (ocr / grounding / detection / ui / ...)
  -> capability router ranks the user's vision model pool
  -> best healthy backend executes
  -> result returns to DeepSeek
  -> repeat as needed
```

The agent should not receive a long permanent leaderboard. Model selection belongs primarily inside Vision Router.

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

A tool maps to an intent. `vision_describe` can refine its intent from the requested operation, but it still never chooses a model itself.

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

`lib/vision-capability-reference.js` builds these compact references and also plans a task-first probe set:

```text
current task intent -> structured -> OCR -> grounding -> general
```

A future self-benchmark runner can execute that small fixture set against the exact provider/model/endpoint fingerprint, so a brand-new model can teach the router what it is good at without waiting for a plugin update.

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

- standalone intent vocabulary;
- tool -> intent mapping;
- conservative family priors;
- measured + override profile merge;
- policy-aware scorer/ranker;
- health-aware ordering;
- diagnostics explanation output;
- unit tests.

## Phase 2 — shadow routing

The scorer is wired into both `vision_describe` and the shared model-backed tool executor. Enable `capabilityRoutingShadow` to log `current order` vs `v2 suggested order`; actual execution still iterates the original v1 candidate order.

The shadow plan includes current circuit-breaker state, local/privacy traits and direct HTTP fallbacks. `vision_bootstrap` is explicitly tagged as `structured`, while internal OCR/grounding/detection prompts are classified into their specialist intents.

### Agent-reference shadow experiment

When shadow mode is enabled, the first bootstrap prompt can also receive a compact evidence-aware model reference. DeepSeek may submit a shadow-only `preferredBackend` chosen from that reference.

The router logs three things side-by-side:

```text
actual v1 order
agent preferred backend
v2 scorer order
```

`preferredBackend` is **diagnostic only** and never changes execution order. This lets us test the community suggestion — "give the text model a capability reference and let it choose" — without handing production routing to an unvalidated prompt heuristic.

The reference explicitly labels evidence provenance (`实测`, `人工确认`, `家族先验`, `未知新模型`) and tells the agent not to invent strengths for unverified future models.

## Planned self-benchmark fixtures

The next major capability-learning step should measure operations rather than subjective chat quality:

- OCR: exact/normalized text match on Chinese + English UI text;
- grounding: bounding-box IoU / point-in-target;
- detection: element recall and duplicate rate;
- structured: JSON validity + required-field coverage;
- document: reading order / key-value / table structure;
- UI: element/state relation accuracy;
- chart/diagram: labeled relation questions;
- latency: median request wall time.

Benchmark state should be keyed by provider + model + endpoint/config fingerprint so a local quantized model does not inherit cloud results from a similarly named model.

## Settings UX target

The main card should eventually replace the mental model of a single **vision fallback chain** with a **vision model pool**:

- Smart vision routing: on/off
- Policy: Quality / Balanced / Speed / Local privacy
- Model pool rows with evidence-aware capability tags
- One-click `Test model capabilities`

Advanced settings can expose per-intent preferred/blocked models and raw profile overrides. Ordinary users should not maintain a capability matrix manually.

## Migration phases

### Phase 3 — opt-in runtime routing

Add `capabilityRouting: true`. Use v2 ordering for tool-side visual calls while preserving the current fallback executor and circuit breaker.

### Phase 4 — self-benchmark and persistence

Add generated privacy-safe fixtures, exact-backend probe execution, persisted endpoint fingerprints, measured capability profiles and UI tags.

### Phase 5 — v2 default

Only after shadow and benchmark evidence show stable routing: make capability-aware ordering the normal path and keep the old fixed chain as compatibility behavior.

# v2 capability-aware vision routing

This document is the design target for a major-version routing change. The first implementation on `feat/v2-capability-router` is intentionally runtime-neutral: it adds the intent/profile/scoring core and tests without changing the existing v1 fallback order.

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

The agent should not receive a long list of model names or benchmark lore. Model selection belongs inside Vision Router.

## Intent vocabulary

Phase 1 uses the following stable internal intents:

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

Each backend gets a normalized profile:

```js
{
  provider: 'provider-id',
  model: 'model-id',
  scores: {
    structured: 0.90,
    ocr: 0.96,
    document: 0.92,
    ui: 0.88,
    grounding: 0.94,
    detection: 0.90,
    general: 0.90,
    chart_diagram: 0.86,
    code_screenshot: 0.84,
    visual_compare: 0.88,
  },
  confidence: { /* per-intent provenance confidence */ },
  traits: {
    latencyMs: 850,
    cost: 0.1,
    local: false,
    privacy: 'cloud',
  },
  provenance: {
    prior: 'family-prior',
    measured: true,
    override: false,
  },
}
```

### Three profile sources

1. **Conservative built-in prior** — family-level capability hints, not a hard benchmark ranking. Unknown models remain routable with a generic baseline.
2. **Runtime benchmark measurement** — a future local fixture suite can write per-intent measurements for the exact provider/model/endpoint fingerprint.
3. **User override** — explicit capability scores or allow/deny rules always win.

The important rule is that measurements override most of the prior, because the same named model can behave differently through quantization, local inference, relays, prompt wrappers, or provider-specific versions.

## Ranking

Ranking is per visual call, not per conversation. A candidate score combines:

- capability match for the current intent;
- backend health (circuit breaker, recent failures, rate limiting);
- latency;
- cost/free status;
- local/privacy preference.

Initial user-facing policies:

- `quality`
- `balanced`
- `speed`
- `privacy`

The existing configured order remains the deterministic tie-breaker.

Example: the same model pool may route `vision_ocr` to model A and `vision_ground` to model B without DeepSeek ever seeing A/B's names.

## Health integration

The v2 scorer should consume the existing resilience state instead of inventing another retry system. A tripped or rate-limited backend must sink to the bottom (or be filtered) before execution. Existing fallback/circuit-breaker behavior remains the final safety net after routing.

## Planned benchmark fixtures

A later phase can add a small, privacy-safe built-in capability test pack. It should measure operations rather than subjective chat quality:

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
- Model pool rows with auto-generated capability tags
- One-click `Test model capabilities`

Advanced settings can expose per-intent preferred/blocked models and raw profile overrides. Ordinary users should not maintain a capability matrix manually.

## Migration phases

### Phase 1 — now on this branch

- standalone intent vocabulary;
- tool -> intent mapping;
- conservative family priors;
- measured + override profile merge;
- policy-aware scorer/ranker;
- health-aware ordering;
- diagnostics explanation output;
- unit tests;
- **no runtime behavior change**.

### Phase 2 — shadow routing (implemented on this branch)

The scorer is now wired into both `vision_describe` and the shared model-backed tool executor. Enable `capabilityRoutingShadow` to log `current order` vs `v2 suggested order`; actual execution still iterates the original v1 candidate order. The shadow plan includes the current circuit-breaker state, local/privacy traits and direct HTTP fallbacks. `vision_bootstrap` is explicitly tagged as `structured`, while internal OCR/grounding/detection prompts are classified into their specialist intents. The first bootstrap prompt can also receive a compact evidence-aware model reference and submit a shadow-only `preferredBackend`; logs compare that agent recommendation with the scorer top choice while ignoring it for execution. This gives real-world evidence without risking users.

### Phase 3 — opt-in runtime routing

Add `capabilityRouting: true` and policy selection. Use v2 ordering for tool-side visual calls while preserving the current fallback executor and circuit breaker.

### Phase 4 — self-benchmark and UI

Add fixture-based capability measurement, persisted fingerprints, model-pool UI, tags, explanations and manual overrides.

### Phase 5 — v2 default

Only after telemetry/manual testing shows routing is stable: make capability-aware ordering the normal path and document the old fixed-order chain as compatibility behavior.


## Capability knowledge and future models

A permanent hard-coded leaderboard is intentionally not the source of truth. New or renamed models can appear faster than this plugin can ship releases, and the same model name can behave differently across providers, quantization and relays. The routing evidence hierarchy is therefore:

1. exact-endpoint measured/self-benchmark evidence;
2. explicit user override;
3. provider/model official claims when available;
4. conservative family prior;
5. unknown generic prior.

Unknown models are shown to the agent as **unverified** rather than being assigned invented specialist strengths. `lib/vision-capability-reference.js` also plans a small task-first probe set (`task intent -> structured -> OCR -> grounding -> general`) so a future self-benchmark runner can learn the exact configured endpoint without waiting for a model-name table update.

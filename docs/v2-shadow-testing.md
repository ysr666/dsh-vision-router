# v2 shadow routing test guide

The rebuilt capability router is deliberately **shadow-only**. It computes an intent-aware suggested backend order but never changes the order actually executed by the current v1 fallback chain.

## Current enablement

The rebuilt branch intentionally does **not** patch the v1.7 settings component to add a shadow-routing toggle. The schema/runtime fields exist, but the user-facing UI in this phase is the independent capability-benchmark queue.

For development testing, set:

```text
capabilityRoutingShadow: true
capabilityRoutingStrategy: balanced
```

Valid strategies are `balanced`, `quality`, `speed`, and `privacy`. `balanced` is the default.

Before comparing shadow rankings, benchmark relevant model rows where possible so the scorer has endpoint-specific measured evidence instead of only priors.

## Benchmark first

Each model row now keeps the main settings UI compact: it shows a concise capability summary plus one **测评 / Benchmark** entry. Open that panel to choose **快速测试 / Quick test** or **完整测试 / Full test**.

- Quick: 3 sequential requests — Latin/UI OCR, Chinese chat OCR, general scene. This is low-confidence evidence.
- Full: 6 sequential requests — structured, two OCR fixtures, grounding, document/table, general scene. This is currently medium-confidence evidence.
- Multiple models may be queued. Only one benchmark actually executes at a time; later models show a FIFO queue position.
- Browser refresh recovers the in-process running/queued state. A DSH process restart intentionally does not resume chargeable benchmark jobs.
- While active, the one normal Benchmark button temporarily becomes **Stop** or **Cancel** on the model row; quick/full/force/diagnostic actions do not permanently crowd the row.
- Auth/rate-limit/timeout/network/protocol/image-support/infrastructure failures fail fast rather than consuming the remaining fixture requests.
- A failed retest does not overwrite the last valid profile, and a quick retest cannot downgrade a richer full profile.
- Results older than 7 days are marked stale; results older than 30 days are not used as measured shadow evidence.
- Cloud models show an in-panel note because quick/full tests send about 3/6 generated-image requests and may incur provider charges.
- Models explicitly declared text-only by DSH expose **Force verify image support** only inside the benchmark panel.
- Older full profiles that have a grounding score but no persisted grounding diagnostic expose a one-request **Diagnose grounding** action. A successful repair updates only grounding evidence while retaining the rest of the richer full profile.

Grounding scores normalize common pixel, 0..1, percent, and 0..1000 coordinate conventions before IoU. Common GLM box wrappers/arrays are accepted. Grounding details are shown in the in-app benchmark panel; parser/coordinate internals are collapsed under **Developer details** rather than shown through a native browser alert.

## What to test

Use a pool with at least two different vision backends when possible. Try several tasks so the same pool is evaluated under different intents:

- structured baseline: enable structured 1+x and send a normal screenshot/image;
- OCR: ask for exact transcription of dense Chinese/English text;
- grounding: ask where one button/object is located;
- detection: ask to list all buttons/inputs/elements;
- UI: ask about selected states, controls, or page structure;
- document: ask about a form/table/invoice/long screenshot;
- chart/diagram: ask about a chart, circuit, schematic, or architecture diagram;
- code screenshot: ask about terminal output, traceback, IDE, or source-code screenshot;
- general: ask an ordinary photo/scene question.

For a generic follow-up `vision_describe`, verify that a preceding successful `vision_bootstrap` can feed the normalized #178 scene signal into shadow intent selection without changing the tool result.

## Log format

Search the server log for `v2 shadow`. A line currently looks like:

```text
vision-router: v2 shadow intent=ocr strategy=balanced current=[A -> B -> C] suggested=[B -> A -> C] measured=[A, B]
```

- `intent`: capability inferred for the observed visual tool call;
- `strategy`: active shadow policy;
- `current`: candidate order observed by the outer v2 layer;
- `suggested`: capability-aware ranking;
- `measured`: candidates whose non-expired exact `ep2_` profile was found in the shared benchmark store.

The full scorer explanation is available inside the shadow plan for tests/diagnostics even though the normal log line stays compact.

## Safety contract

Shadow mode must not alter results merely by being enabled. The wrapper computes/logs a plan and then calls the original visual tool implementation unchanged. It does not reorder, skip, retry, or replace a backend. With shadow disabled it does no per-tool candidate enumeration.

Actual v1 execution continues to apply its existing fallback logic, circuit breaker, deadlines, resource governance, local-model stabilization, and compatibility bridges.

Benchmark execution is a separate explicit user action. Its exact invoker disables Vision Router fallback. Normal DSH providers are attempted through their exact registered adapter/provider/model first; only a v1-compatible bridge condition may bridge to the same provider/model's exact HTTP endpoint. Plugin-owned `vision-http` routes use their exact configured HTTP backend directly. Benchmark failures must never silently fall through to another visual backend.

## Current breaker limitation

The v2 scoring core supports circuit-open/rate-limit/recent-failure health input, but the live v1 breaker is private inside `index.js`. The rebuilt outer shadow layer intentionally does not duplicate or reach through that closure.

Therefore **shadow health is currently neutral/default**. Do not interpret a recommendation for a backend that v1 subsequently skips as evidence that the breaker is wrong; it means shadow has not yet been given the read-only breaker snapshot.

Before any execution-changing `capabilityRouting` switch is added, expose a narrow read-only health snapshot from the existing v1 breaker and feed that into shadow scoring.

## Evidence gate for real routing

The useful questions before opt-in runtime routing are:

1. Does the suggested first backend consistently make more sense for OCR vs grounding vs UI/document/general tasks than the fixed first backend?
2. Do endpoint-specific measured profiles improve those choices compared with family priors?
3. Are quick/full generated fixtures discriminative enough, or do some intents need stronger fixtures?
4. Are score differences stable across repeat full runs rather than artifacts of one synthetic example?
5. After breaker health is exposed, does shadow avoid backends v1 correctly considers unhealthy?
6. Does enabling shadow leave tool outputs/latency within the expected observational overhead?

If these are not convincing, improve evidence/scoring first. Do not enable real routing to compensate for weak shadow results.

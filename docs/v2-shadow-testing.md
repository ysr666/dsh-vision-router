# v2 shadow routing test guide

The Phase-2 capability router is deliberately **shadow-only**. It computes an intent-aware suggested model order but never changes the order actually executed by the current v1 fallback chain.

## Enable

Install the `feat/v2-capability-router` branch, restart DSH, then open Vision Router settings:

1. Advanced settings
2. Developer settings
3. Enable **Capability routing shadow mode / 能力路由影子模式（v2 实验）**
4. Set `v2 routing policy` to one of `balanced`, `quality`, `speed`, or `privacy`

`balanced` is the default.

## What to test

Use a pool with at least two different vision models when possible. Try several tasks so the same pool is evaluated under different intents:

- structured baseline: enable structured 1+x and send a normal screenshot/image;
- OCR: ask for exact transcription of dense Chinese/English text;
- grounding: ask where one button/object is located;
- detection: ask to list all buttons/inputs/elements;
- UI: ask about selected states, controls, or page structure;
- document: ask about a form/table/invoice/long screenshot;
- chart/diagram: ask about a chart, circuit, schematic, or architecture diagram;
- code screenshot: ask about terminal output, traceback, IDE, or source-code screenshot;
- general: ask an ordinary photo/scene question.

## Log format

Search the server log for `capability-shadow`. A line looks like:

```text
vision-router: capability-shadow tool=vision_ocr intent=ocr strategy=balanced changed=yes v1=[A > B > C] v2=[B(0.91) > A(0.84) > C(0.71)]
```

- `tool`: the visual operation currently being executed;
- `intent`: the capability the router inferred;
- `strategy`: the active shadow scoring policy;
- `changed`: whether v2 recommends a different order from v1;
- `v1`: the current real execution order;
- `v2`: the suggested order, including the total score for each candidate.

## Safety contract

Shadow mode must not alter results merely by being enabled. The existing code still executes `usablePairs` and `httpFallbacks` in their original order. Circuit-breaker state is read as an input to the suggestion, but the v2 ranker does not bypass or replace the existing fallback/resilience executor.

The evidence we want before Phase 3 is simple: for mixed model pools, does the suggested first model consistently make more sense for OCR vs grounding vs UI/document/general tasks than the fixed first model? If not, improve the capability profiles/scoring before enabling real routing.

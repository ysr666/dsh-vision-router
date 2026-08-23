# v2 Auto preview acceptance matrix

This is the manual real-machine gate for the capability-aware routing work on `feat/v2-capability-router`.

The goal is **not** to prove that execution-changing Auto is ready. The goal is to verify that the preview/shadow architecture keeps four kinds of facts separate:

1. **Capability** — what an exact model deployment did on the current Benchmark suite;
2. **Performance** — recent successful real visual-call speed observations;
3. **Availability / access** — credentials, rate limits, breaker state, timeout and other live reachability facts;
4. **Policy** — the user's configured order and `Quality / Balanced / Speed / Local` preference.

The product rule remains:

> **User determines preference; Benchmark provides facts; Router does not guess.**

## Safety invariant

Every Settings preview must still report:

```json
{
  "autoPreviewOnly": true,
  "executionActive": false,
  "healthIncluded": false
}
```

`routingMode: auto` is a persisted product setting and a preview/background-profiling input only. It is **not connected to the real v1 executor**.

## Current measurement contract

```text
CAPABILITY_BENCHMARK_SUITE_REVISION = 3
CAPABILITY_PROFILE_CACHE_VERSION = 4
diagnosticVersion = 3
```

Cache v4 stores independent per-axis capability timestamps/counts and explicitly names Benchmark latency as a Benchmark observation:

```text
scores
measuredAtByAxis
fixtureCountByAxis
benchmarkMedianLatencyMsByAxis
benchmarkLatencyMs
```

The persisted profile must not expose generic `latencyMs` / `medianLatencyMs` fields that could be mistaken for current runtime performance.

### Cache migration boundary

Cache v3 is intentionally **not** migrated to v4.

Reason: older v3 capability identity could include credential identity. After v4, credentials no longer define capability identity, so blindly migrating old entries can split or alias the same deployment incorrectly. Users may rebuild capability evidence gradually through manual or background Benchmark.

Wrong-suite evidence remains invalid.

## Capability identity

A capability profile belongs to the exact measurement contract represented by the secret-safe `ep2_...` identity.

Capability identity may depend on facts such as provider, model, endpoint/adapter route, API protocol/non-secret endpoint configuration, Benchmark suite revision and renderer scope.

Capability identity **must not depend on the API key / credential value**.

Changing Key A to Key B for the same deployment therefore does not require a capability retest by itself. Credentials still matter for access/auth/quota/breaker state.

If a credential selects a genuinely different deployment/project/model, that deployment distinction must be represented explicitly in non-secret endpoint/model configuration instead of inferred from the secret itself.

## Measurement age policy

Measurement age is capability provenance only.

```text
8 days old   -> still measured
80 days old  -> still measured
1 year old   -> still measured
```

provided the capability identity and Benchmark suite still match.

Age alone must never create `fresh / stale / expired` capability validity tiers. A positive per-axis timestamp remains required for provenance integrity; missing/invalid timestamps must not be silently invented.

## Benchmark latency vs runtime performance

Benchmark request duration is useful diagnostics, but it is **not current speed**.

```text
benchmarkMedianLatencyMsByAxis -> historical Benchmark observation
runtimeLatencyMsByAxis         -> eligible recent runtime performance
```

Required separation:

- Benchmark latency is displayed as **Benchmark latency / 测评耗时**;
- Benchmark latency does not feed Auto ranking;
- no generic latency fallback may borrow another axis or Benchmark observation;
- runtime performance is process-local and comes from a separate observation path.

## Runtime performance observation contract

Current runtime observer:

```text
source: successful real visual-tool DSH adapter streams
window: 1 hour
max samples per backend+axis: 8
minimum samples for routing: 2
aggregation: median full-response latency
persistence: none
```

A direct visual tool establishes its capability axis through `AsyncLocalStorage`. The wrapped `ctx.llm.stream` records elapsed full-response time only for a successful stream.

Required semantics:

- first recent success -> visible as warming (`runtimePerformanceObserved:true`, `runtimePerformanceEligible:false`);
- second recent success -> same-axis median becomes routing-eligible;
- error/abort -> no sample;
- samples older than one hour -> removed;
- DSH restart -> runtime performance store starts empty;
- manual Benchmark/background capability profiling/exact smoke tests -> zero runtime samples because they do not run inside the real visual-tool scope;
- `capabilityRoutingShadow:false` -> runtime observation still works; product performance collection is not controlled by the development log switch;
- direct HTTP compatibility/fallback paths that bypass `ctx.llm.stream` currently remain without runtime speed evidence rather than receiving a fabricated metric.

This one-hour window applies only to dynamic performance. It does **not** expire capability scores.

### Preference semantics

`Quality`:

```text
score = directly measured capability
```

Both adjacent candidates need valid direct capability evidence for the current axis. A material capability advantage of at least `0.08` may reorder them.

`Balanced`:

```text
score = 0.80 * capability + 0.20 * runtime-speed
```

`Speed`:

```text
score = 0.55 * capability + 0.45 * runtime-speed
```

For `Balanced` and `Speed`, missing or still-warming runtime performance makes the pair incomparable. Configured order is preserved. Benchmark latency is never substituted.

`Local`:

```text
local-first policy, then capability comparison within locality groups
```

Local-first is user policy, not a capability claim.

## Direct capability axes

Only these axes currently have direct Benchmark fixtures:

```text
structured
ocr
document
grounding
general
```

Unsupported task intents such as `ui`, `detection`, `chart_diagram`, `code_screenshot` and `visual_compare` must not receive inferred/proxy capability scores.

## Conservative reorder rules

Configured order is the baseline.

- unmeasured current-axis capability is an information barrier;
- missing required runtime performance is an information barrier for Balanced/Speed;
- `fallback-only` built-ins cannot Benchmark-promote over user routes;
- arbitrary DSH-discovered models do not silently join the Auto pool;
- capability/weighted movement requires at least `AUTO_REORDER_MIN_ADVANTAGE = 0.08`;
- ties and small deltas preserve user order;
- live availability may gate a candidate during a real turn but does not rewrite stored capability.

## Preview diagnostics vocabulary

The read-only diagnostics payload uses:

```text
diagnosticVersion: 3
measurementAgePolicy: informational-only
credentialAffectsCapabilityIdentity: false
benchmarkLatencyAffectsRouting: false
performanceSource: runtime-observation-only
runtimePerformanceCoverage: real visual-tool adapter streams
runtimePerformanceMaxAgeMs: 3600000
runtimePerformanceMinSamples: 2
evidenceInvalidation: endpoint-identity, benchmark-suite
```

For each direct axis, Settings diagnostics should expose configured/preview order, ranks, capability score and age, Benchmark latency, runtime warming/eligible latency, runtime sample count/age, comparability, formula, threshold, sanitized identity and adjacent-pair checks.

Candidate capability evidence states are `measured`, `axis-unmeasured`, `unmeasured`, `unbenchmarkable`.

Pair outcomes include `measured-promotable`, `below-threshold`, `incomparable`, `local-policy-promotes-right`, `fallback-only-boundary`.

The browser must display the shared planner's output rather than implement its own ranking algorithm.

## Benchmark trust requirements

Manual Quick/Full remain advanced operations.

- Quick: about 3 requests; OCR + General.
- Full: about 6 requests; Structured + OCR + Document + Grounding + General.

Before request 1, every selected fixture must preflight through generated SVG -> Sharp/libvips PNG -> adapter attachment materialization where required.

Required invariants:

- preflight failure sends **zero** provider requests;
- provider/infrastructure failure fails fast and cannot persist partial evidence;
- failed retest leaves previous valid evidence intact;
- timeout without user Stop is `failed / timeout`;
- explicit Stop/Cancel is `cancelled`;
- Benchmark latency excludes fixture rendering and attachment preparation;
- document scoring requires structural correctness rather than token soup;
- raw keys, credential refs, endpoint URLs and raw model responses do not enter persisted/browser diagnostics;
- running Benchmark must not create runtime-performance samples.

## Background profiling contract

```text
backgroundBenchmarking: local-free | all | off
```

- `local-free` default: only local/known-free user routes;
- `all`: explicit authorization for configured chargeable cloud routes;
- `off`: disabled;
- `routingMode: ordered`: background profiling inactive;
- `fallback-only`: ignored.

One background work unit is one candidate + one **unmeasured direct capability axis**. It must not periodically retest a measured axis because of age and must not create runtime-speed observations.

Priority:

```text
real visual tool
> manual Benchmark queue/run
> background profiler
```

Real visual/manual activity must abort/yield background work. Yield is not provider failure. Genuine background failures back off the candidate+axis.

## Core routing matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| R01 | two unmeasured backends, Auto + Quality | configured order; pair incomparable |
| R02 | two measured same-axis capabilities; right leads >=0.08 | right may promote; `measured-advantage` |
| R03 | same-axis capability delta 0.01-0.07 | configured order; `below-threshold` |
| R04 | A measured, B unmeasured, C strongly measured | C cannot cross B |
| R05 | relevant capability measurements are 80d/1y old | still comparable under Quality |
| R06 | Quick covers OCR/general only | other axes remain unmeasured |
| R07 | Balanced, capability measured but no runtime samples | incomparable; configured order |
| R08 | Speed, capability measured but only Benchmark latency exists | incomparable; configured order |
| R09 | Balanced/Speed, one runtime sample per candidate | warming only; configured order |
| R10 | Balanced/Speed, >=2 recent same-axis runtime samples each | weighted comparison may occur |
| R11 | runtime samples age past 1h | performance becomes incomparable; capability remains measured |
| R12 | cloud before enabled local, Auto + Local | local may move first as explicit policy |
| R13 | unselected built-in free fallback | fallback-only stays behind user routes |
| R14 | endpoint/model/API identity changes | old capability `ep2_` not reused |
| R15 | rotate credential only, same endpoint/model/API | capability `ep2_` unchanged |
| R16 | unsupported UI/detection task | no proxy capability/performance reorder |

## Runtime performance matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| T01 | first successful adapter-backed `vision_ocr` call | one warming OCR sample; not routing-eligible |
| T02 | second recent successful OCR call on same backend | median OCR runtime becomes eligible |
| T03 | failed stream | no new sample |
| T04 | aborted/cancelled stream | no new sample |
| T05 | successful Document tool call | updates Document only, not OCR |
| T06 | manual Benchmark call | no runtime sample |
| T07 | background capability Benchmark | no runtime sample |
| T08 | exact backend smoke test | no runtime sample |
| T09 | `capabilityRoutingShadow:false` + successful real visual tool | sample still recorded |
| T10 | wait >1h without newer success | runtime sample removed; capability stays intact |
| T11 | restart DSH | process-local runtime store empty |
| T12 | direct HTTP fallback bypassing adapter stream | no fabricated runtime speed; candidate remains incomparable |

## Benchmark matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| B01 | old cache-v3 file | ignored; rebuild into cache v4 |
| B02 | Full on healthy backend | all fixtures preflight, then sequential requests |
| B03 | break one fixture renderer | infrastructure failure; zero model requests; old profile untouched |
| B04 | slow attachment persistence + normal model | Benchmark latency tracks transport only |
| B05 | rotate credential value | capability fingerprint unchanged; access may change |
| B06 | credential-required but unresolved | auth failure does not redefine capability identity |
| B07 | DSH credential seam misses while same-name env exists | no silent ambient fallback |
| B08 | provider/auth/rate-limit/network/protocol failure request 1 | fail fast; later fixtures not sent |
| B09 | force timeout without user Stop | failed/timeout |
| B10 | explicit Stop/Cancel | cancelled |
| B11 | custom/dev runner returns failureCount >0 | persistence refused |
| B12 | document answer structurally wrong | score materially reduced |
| B13 | manually remeasure only General | only General capability/Benchmark observation changes |
| B14 | remeasure Grounding diagnostic only | other axes retain evidence |

## Background profiler matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| P01 | Auto + default `local-free`, local backend missing OCR | after idle, one OCR capability work item may run |
| P02 | `local-free`, chargeable cloud only | zero background cloud Benchmark requests |
| P03 | `all`, configured chargeable cloud missing axis | background may run; UI discloses cost |
| P04 | `off` | zero background Benchmark requests |
| P05 | Ordered + any background mode | zero background Benchmark requests |
| P06 | background axis running, then real image | background yields; real task proceeds |
| P07 | background running, then manual Benchmark | background yields until manual queue idle |
| P08 | foreground/manual yield | no provider-failure backoff |
| P09 | genuine background provider failure | candidate+axis retry backoff |
| P10 | recent Document task and Document unmeasured | next eligible work may prefer Document |
| P11 | Document measured months ago | no retest merely because of age |
| P12 | unsupported task then idle | no fabricated direct capability axis |
| P13 | unselected fallback-only backend | ignored |
| P14 | short-lived doctor/test process | profiler timer cannot keep process alive |

## Settings/UI matrix

| ID | Environment/action | Expected result |
| --- | --- | --- |
| U01 | local: Fixed order <-> Auto | `routingMode` persists/readbacks |
| U02 | cycle Balanced/Quality/Speed/Local | `routingPreference` persists |
| U03 | cycle background local-free/all/off | `backgroundBenchmarking` persists |
| U04 | trusted-host remote, permission enabled | existing settings RPC/readback path only |
| U05 | two clients, change settings on A | B refreshes controls correctly |
| U06 | diagnostics Refresh | one read-only GET; no mutation |
| U07 | Copy JSON | sanitized diagnostic v3 payload |
| U08 | Benchmark finishes without closing Settings | new capability evidence visible |
| U09 | repeated remount/reopen | no duplicate/self-loop panels |
| U10 | inspect 8d/80d/1y capability | age only; no stale/expired validity label |
| U11 | inspect Benchmark modal | latency labeled Benchmark observation, not current speed |
| U12 | Balanced/Speed no runtime samples | explains configured-order preservation |
| U13 | one runtime sample | diagnostics show warming `1/2`, not eligible |
| U14 | two recent runtime samples | diagnostics show eligible runtime median/sample count |
| U15 | choose `all` | potentially chargeable background behavior clearly disclosed |

## Runtime separation matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| X01 | Quality preview recommends B>A; run real image | actual v1 still starts configured A |
| X02 | Balanced/Speed preview recommends B>A after runtime warming; run real image | actual v1 still starts configured A |
| X03 | Settings preview | `healthIncluded:false` |
| X04 | induce live breaker/rate-limit | turn shadow may gate; stored capability unchanged |
| X05 | rotate API key only | access may change; capability identity stays |
| X06 | diagnostics open during chat | no effect on tool result/retry/timeout/breaker/fallback |
| X07 | background profiler active then real visual task | v1 output/order identical to profiler-off baseline |

## Security/privacy checks

Copied JSON/browser Network must not contain API keys, bearer tokens, credential refs/env names, raw endpoint URLs, arbitrary provider config, raw Benchmark response, or user image content/path.

Allowed diagnostic facts include provider/model candidate key already visible in Settings, safe `ep2_` fingerprint, capability scores/timestamps, Benchmark latency clearly labeled as such, runtime sample count/age/median, suite revision and local/fallback-only/benchmarkable flags.

## Result-capture template

```text
Case ID:
Date/time:
OS / Node / DSH:
Plugin commit:
Benchmark suite / cache / diagnostic version:
Profile name / access mode:
Configured chain:
Routing mode / preference / background mode:
Capability state per axis:
Benchmark observation latency:
Runtime observed latency + sample count + age:
Runtime eligible: yes/no
Expected preview:
Observed preview:
Copied diagnostics JSON: yes/no
Relevant log: yes/no/not applicable
Actual v1 execution order unchanged: yes/no
PASS / FAIL:
Notes:
```

Never attach raw keys, credential references, endpoint secrets or user image content.

## Exit gate before execution-changing Auto

Do not connect Auto preview to the executor until real-machine evidence shows:

1. capability age alone never invalidates evidence;
2. credential rotation alone never changes capability identity;
3. one-axis remeasurement never rewrites another axis's timestamp;
4. unmeasured capability barriers preserve configured order;
5. Benchmark latency never enters runtime speed scoring;
6. runtime observer records successful real adapter streams only;
7. one runtime sample stays warming and cannot route;
8. two recent samples can provide the same-axis runtime median;
9. runtime evidence expires independently while capability remains;
10. Balanced/Speed preserve order without eligible runtime performance;
11. unsupported/direct-HTTP-unobserved paths do not receive fabricated runtime speed;
12. exact identity/suite changes invalidate old capability evidence correctly;
13. Quick/Full preflight/failure/privacy rules hold on real adapter + HTTP routes;
14. default `local-free` produces no chargeable cloud background requests;
15. background capability profiling never creates runtime-speed samples;
16. `all` is explicit and clearly disclosed;
17. foreground/manual activity always preempts background profiling;
18. no secret/raw user image data enters diagnostics;
19. Local remains labeled as policy;
20. Auto preview/background/runtime observation still leave actual v1 execution order/result unchanged;
21. supported DSH / Node / OS CI and real-machine host matrix passes.

Only after those gates have convincing PASS evidence should an opt-in execution-changing Auto commit be discussed.
# v2 Auto preview acceptance matrix

This is the manual real-machine gate for the capability-aware routing work on `feat/v2-capability-router`.

The goal is **not** to prove that execution-changing Auto is ready. The goal is to verify that the preview/shadow architecture keeps four kinds of facts separate:

1. **Capability** — what an exact model deployment did on the current Benchmark suite;
2. **Performance** — current runtime speed observations, when such observations exist;
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
CAPABILITY_BENCHMARK_SUITE_REVISION = 2
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

Capability identity may depend on facts such as:

- provider;
- model;
- endpoint / adapter route;
- API protocol and other non-secret endpoint configuration;
- Benchmark suite revision;
- renderer scope where relevant.

Capability identity **must not depend on the API key / credential value**.

Changing Key A to Key B for the same deployment therefore does not require a capability retest by itself.

Credentials still matter for **access**. A missing/invalid key may make a Benchmark or live request fail with `auth`, but that is an availability/access fact rather than a statement that the model suddenly has different OCR or grounding ability.

If a credential selects a genuinely different deployment/project/model, that deployment distinction must be represented explicitly in non-secret endpoint/model configuration instead of inferred from the secret itself.

## Measurement age policy

Measurement age is provenance only.

```text
8 days old   -> still measured
80 days old  -> still measured
1 year old   -> still measured
```

provided the capability identity and Benchmark suite still match.

A timestamp answers **when was this measured?** It does not let the router decide that capability expired after an arbitrary number of days.

Age alone must never create `fresh / stale / expired` validity tiers.

A positive per-axis timestamp remains required as provenance integrity for persisted evidence. Missing/invalid timestamps must not be silently invented.

## Benchmark latency vs runtime performance

Benchmark records how long each Benchmark request took. That value is useful diagnostics, but it is **not current speed**.

```text
benchmarkMedianLatencyMsByAxis -> historical Benchmark observation
runtimeLatencyMsByAxis         -> runtime performance fact, if/when available
```

Required separation:

- Benchmark latency is displayed as **Benchmark latency / 测评耗时**;
- Benchmark latency does not feed Auto ranking;
- runtime performance must come from an independent runtime observation path;
- no generic latency fallback may borrow another axis or the Benchmark observation.

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

For `Balanced` and `Speed`, **missing runtime performance makes the pair incomparable**. The router preserves configured order. It must not substitute Benchmark latency.

`Local`:

```text
local-first policy, then capability comparison within locality groups
```

Local-first is a user policy, not a claim that local models are intrinsically more capable.

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
- `fallback-only` built-ins cannot Benchmark-promote over user routes;
- arbitrary DSH-discovered models do not silently join the Auto pool;
- capability movement requires at least `AUTO_REORDER_MIN_ADVANTAGE = 0.08`;
- ties and small deltas preserve user order;
- availability/health may gate a candidate during a real turn, but does not rewrite its stored capability.

## Preview diagnostics vocabulary

The read-only diagnostics payload uses:

```text
diagnosticVersion: 3
measurementAgePolicy: informational-only
credentialAffectsCapabilityIdentity: false
benchmarkLatencyAffectsRouting: false
performanceSource: runtime-observation-only
evidenceInvalidation: endpoint-identity, benchmark-suite
```

For each direct axis, Settings diagnostics should expose:

- configured order and preview order;
- configured rank -> preview rank;
- direct capability score;
- factual measurement age;
- Benchmark latency as a non-routing observation;
- runtime latency separately, when available;
- comparability state;
- active policy formula;
- `0.08` threshold;
- sanitized `ep2_` identity;
- adjacent-pair checks.

Candidate capability evidence states are:

- `measured`;
- `axis-unmeasured`;
- `unmeasured`;
- `unbenchmarkable`.

Pair outcomes include:

- `measured-promotable`;
- `below-threshold`;
- `incomparable`;
- `local-policy-promotes-right`;
- `fallback-only-boundary`.

The browser must display the shared planner's output rather than implementing its own ranking algorithm.

## Benchmark trust requirements

Manual Quick/Full remain available as advanced operations.

- Quick: about 3 requests; OCR + General.
- Full: about 6 requests; Structured + OCR + Document + Grounding + General.

Before request 1, every selected fixture must preflight through generated SVG -> Sharp/libvips PNG -> adapter attachment materialization where required.

Required invariants:

- preflight failure sends **zero** provider requests;
- all selected fixtures preflight before the first model call;
- provider/infrastructure failure fails fast and cannot persist partial evidence;
- failed retest leaves previous valid evidence intact;
- timeout without user Stop is `failed / timeout`;
- explicit Stop/Cancel is `cancelled`;
- Benchmark latency excludes fixture rendering and attachment preparation;
- document scoring requires structural correctness rather than token soup;
- raw keys, credential refs, endpoint URLs and raw model responses do not enter persisted/browser diagnostics.

## Background profiling contract

Product setting:

```text
backgroundBenchmarking: local-free | all | off
```

Expected semantics:

- `local-free` (default): background requests only for local or explicitly known-free user routes;
- `all`: explicit authorization to background-profile configured benchmarkable cloud user routes that may incur API charges;
- `off`: no background profiling;
- `routingMode: ordered`: no background profiling;
- `fallback-only`: never background-profiled.

One background work unit is one candidate + one **unmeasured direct capability axis**.

It must not periodically retest an already measured axis just because its timestamp is old.

Priority:

```text
real visual tool
> manual Benchmark queue/run
> background profiler
```

Real visual/manual activity must abort/yield background work. That yield is not a provider failure. Genuine background provider failures should back off that candidate+axis instead of tight-looping.

## Core routing matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| R01 | two unmeasured backends, Auto + Quality | configured order; pair incomparable |
| R02 | two measured same-axis capabilities; right leads >=0.08 | right may promote; `measured-advantage` |
| R03 | same-axis capability delta 0.01-0.07 | configured order; `below-threshold` |
| R04 | A measured, B unmeasured, C strongly measured | C cannot cross B |
| R05 | both relevant-axis measurements are 80d/1y old | still comparable; age alone does not block Quality reorder |
| R06 | Quick covers OCR/general only | OCR/general measured; other axes remain unmeasured |
| R07 | Balanced, capability measured but no runtime performance | incomparable; configured order |
| R08 | Speed, capability measured but only Benchmark latency exists | incomparable; configured order |
| R09 | Balanced/Speed with same-axis runtime performance supplied | active weighted formula may compare |
| R10 | cloud before enabled local, Auto + Local | local may move first as explicit policy |
| R11 | unselected built-in free fallback | fallback-only stays behind user routes |
| R12 | endpoint/model/API identity changes | old `ep2_` evidence not reused |
| R13 | rotate credential only, same endpoint/model/API | capability `ep2_` identity unchanged |
| R14 | relevant-axis record lacks valid timestamp | rejected as malformed provenance |
| R15 | unsupported UI/detection task | no proxy capability reorder |

## Benchmark matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| B01 | old cache-v3 file | ignored; rebuild into cache v4 |
| B02 | Full on healthy backend | all fixtures preflight, then sequential requests |
| B03 | break one fixture renderer | infrastructure failure; zero model requests; old profile untouched |
| B04 | slow attachment persistence + normal model | Benchmark latency tracks transport only |
| B05 | rotate credential value | capability fingerprint unchanged; access fingerprint may change |
| B06 | credential-required but unresolved | Benchmark/live access can fail auth without changing capability identity |
| B07 | DSH credential seam misses while same-name env exists | no silent ambient fallback |
| B08 | provider/auth/rate-limit/network/protocol failure request 1 | fail fast; later fixtures not sent |
| B09 | force timeout without user Stop | failed/timeout |
| B10 | explicit Stop/Cancel | cancelled |
| B11 | custom/dev runner returns failureCount >0 | persistence refused |
| B12 | document answer token-complete but structurally wrong | score materially reduced |
| B13 | manually remeasure only General | only General score/Benchmark-latency/timestamp/count changes |
| B14 | remeasure Grounding diagnostic only | other axes retain their evidence |

## Background profiler matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| P01 | Auto + default `local-free`, local backend missing OCR | after idle, one OCR work item may run |
| P02 | Auto + `local-free`, chargeable cloud backend only | zero background cloud Benchmark requests |
| P03 | Auto + `all`, configured chargeable cloud backend missing axis | background may run; UI discloses cost boundary |
| P04 | Auto + `off` | zero background Benchmark requests |
| P05 | Ordered + any background mode | zero background Benchmark requests |
| P06 | background axis running, then send real image | background yields; real task proceeds normally |
| P07 | background axis running, then enqueue manual Benchmark | background yields until manual queue is idle |
| P08 | foreground/manual yield | no provider-failure backoff |
| P09 | genuine background provider failure | candidate+axis retry backoff; no tight loop |
| P10 | recent Document task and Document unmeasured | next eligible work may prefer Document |
| P11 | Document measured months ago | no retest merely because of age |
| P12 | unsupported task then idle | no fabricated direct capability axis |
| P13 | unselected fallback-only backend | ignored by background profiler |
| P14 | short-lived doctor/test process | profiler timer cannot keep process alive |

## Settings/UI matrix

| ID | Environment/action | Expected result |
| --- | --- | --- |
| U01 | local: Fixed order <-> Auto | `routingMode` persists/readbacks |
| U02 | cycle Balanced/Quality/Speed/Local | `routingPreference` persists |
| U03 | cycle background local-free/all/off | `backgroundBenchmarking` persists |
| U04 | trusted-host remote, permission enabled | existing settings RPC/readback path; no new settings-write HTTP route |
| U05 | two clients, change settings on A | B refreshes controls correctly |
| U06 | diagnostics Refresh | one read-only GET state; no mutation |
| U07 | Copy JSON | sanitized `diagnosticVersion: 3` payload |
| U08 | Benchmark finishes without closing Settings | new capability evidence becomes visible |
| U09 | repeated remount/reopen | one product panel and one diagnostics panel; no self-loop |
| U10 | inspect 8d/80d/1y measurement | age shown as provenance; no stale/expired validity label |
| U11 | inspect Benchmark modal | latency labeled Benchmark observation, not current speed |
| U12 | Balanced/Speed without runtime performance | UI/diagnostics explain why configured order is preserved |
| U13 | choose `all` | potentially chargeable background behavior clearly disclosed |

## Runtime separation matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| X01 | Auto preview recommends B>A under Quality; run real image | actual v1 still starts from configured A |
| X02 | inspect Settings preview | `healthIncluded:false` |
| X03 | induce live breaker/rate-limit | turn shadow may gate candidate; stored capability unchanged |
| X04 | rotate API key only | access state changes independently; capability evidence stays attached to same identity |
| X05 | manual Benchmark queued/running; restart DSH | jobs do not auto-resume; persisted capability remains |
| X06 | diagnostics open during chat | GET/DOM activity changes no tool result/retry/timeout/breaker/fallback |
| X07 | background profiler active then real visual task | v1 output/order identical to profiler-off baseline |

## Security/privacy checks

Inspect copied JSON and browser Network for one cloud and one local route.

Must be absent:

- API key/bearer token;
- credential value/ref/environment variable name;
- raw endpoint URL;
- arbitrary provider config;
- raw Benchmark response;
- user image content/path.

Allowed:

- provider/model candidate key already visible in Settings;
- secret-safe `ep2_[0-9a-f]{32}` capability fingerprint;
- measured capability score;
- per-axis measurement timestamp/age/coverage;
- Benchmark latency clearly labeled as Benchmark observation;
- runtime latency only if collected by a separate runtime observation path;
- suite revision;
- local/fallback-only/benchmarkable flags.

## Result-capture template

For each manual row, record:

```text
Case ID:
Date/time:
OS:
Node:
DSH version:
Plugin commit:
Benchmark suite revision:
Profile cache version:
Diagnostic version:
Profile name:
Access: loopback / trusted-host remote
Configured chain:
Routing mode:
Preference:
Background profiling mode:
Capability state per axis/candidate:
Benchmark observation latency:
Runtime performance observation, if any:
Expected preview:
Observed preview:
Copied diagnostics JSON attached: yes/no
Relevant log attached: yes/no/not applicable
Actual v1 execution order unchanged: yes/no
PASS / FAIL:
Notes:
```

Never attach raw keys, credential references, endpoint secrets or user image content.

## Exit gate before execution-changing Auto

Do not connect Auto preview to the executor until real-machine evidence shows:

1. measurement age alone never invalidates capability evidence;
2. credential rotation alone never changes capability identity;
3. refreshing one axis never rewrites another axis's timestamp;
4. unmeasured capability barriers preserve configured order;
5. Benchmark latency never enters runtime speed scoring;
6. Balanced/Speed preserve order when runtime performance is unavailable;
7. exact identity/suite changes invalidate old evidence correctly;
8. Quick/Full preflight/failure/privacy rules hold on real adapter + HTTP routes;
9. default `local-free` produces no chargeable cloud background requests;
10. complete old profiles are not periodically background-retested;
11. `all` is explicit and clearly disclosed;
12. foreground/manual activity always preempts background profiling;
13. background failures back off safely;
14. no secret/raw user image data enters diagnostics;
15. Local remains labeled as policy;
16. `routingMode:auto` and background profiling still leave actual v1 execution order/result unchanged;
17. the supported DSH / Node / OS host matrix passes.

Only after those gates have convincing PASS evidence should an opt-in execution-changing Auto commit be discussed.

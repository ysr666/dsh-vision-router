# v2 Auto preview acceptance matrix

This is the manual real-machine gate for Commits E + F + G on `feat/v2-capability-router`.

The goal is **not** to prove that Auto routing is ready to execute. The goal is to verify that:

1. read-only Auto preview is explainable;
2. Benchmark evidence is trustworthy;
3. Commit G can build that evidence gradually in the background without surprising cost or foreground interference;
4. actual v1 execution remains unchanged.

## Safety invariant

Every Settings preview must still report:

```json
{
  "autoPreviewOnly": true,
  "executionActive": false,
  "healthIncluded": false
}
```

`routingMode: auto` is a persisted product setting and a preview/background-profiling input only. It is **not** connected to the real v1 executor.

## Current measurement contract

```text
CAPABILITY_BENCHMARK_SUITE_REVISION = 2
CAPABILITY_PROFILE_CACHE_VERSION = 3
```

Cache v3 stores independent axis timestamps/counts:

```text
measuredAtByAxis
fixtureCountByAxis
```

Legacy cache-v2 evidence from the current suite may migrate, but each migrated axis inherits the old record timestamp. Wrong-suite evidence remains invalid.

Freshness is per-axis:

| Axis state | Meaning | Auto effect |
| --- | --- | --- |
| fresh | <=7 days | may compare on that direct axis |
| stale | >7 and <=30 days | visible, not comparable |
| expired | >30 days | removed from retained current profile data |
| unmeasured | no direct score/timestamp | not comparable |

A mixed-age profile is expected and must remain mixed.

## Preview diagnostics vocabulary

For each direct axis, Settings diagnostics expose configured/preview order, ranks, measured score/latency, comparable state, scoring formula, `0.08` threshold and adjacent-pair checks.

Pair outcomes include:

- `measured-promotable`;
- `below-threshold`;
- `incomparable`;
- `local-policy-promotes-right`;
- `fallback-only-boundary`.

The browser does not reimplement ranking. It displays the shared planner's output.

## Benchmark trust requirements

Manual Quick/Full remain available but are advanced operations rather than an Auto prerequisite.

- Quick: ~3 requests; OCR + General.
- Full: ~6 requests; Structured + OCR + Document + Grounding + General.

Before request 1, every selected fixture must preflight through generated SVG -> Sharp/libvips PNG -> adapter attachment materialization where required.

Required invariants:

- preflight failure sends zero provider requests;
- latency is model transport only;
- same-axis latency only for Balanced/Speed;
- exact endpoint/credential fingerprint identity;
- invocation failures fail fast and cannot persist partial evidence;
- timeout is failed/timeout, not user cancellation;
- explicit Stop/Cancel is cancelled;
- failed retest leaves prior valid evidence untouched;
- raw keys, credential refs, endpoint URLs and raw model responses do not enter persisted/browser diagnostics.

## Commit G background profiling contract

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

One background work unit is one candidate + one missing/stale direct axis. It must not run a hidden Full suite.

Priority:

```text
real visual tool
> manual Benchmark queue/run
> background profiler
```

Real visual/manual activity must abort/yield background work. That yield is not a provider failure and must not trigger provider-failure backoff. Genuine provider failure should back off that candidate+axis instead of tight-looping.

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
Profile name:
Access: loopback / trusted-host remote
Configured chain:
Routing mode:
Preference:
Background profiling mode:
Benchmark state per axis/candidate:
Expected preview:
Observed preview:
Copied diagnostics JSON attached: yes/no
Relevant log attached: yes/no/not applicable
Actual v1 execution order unchanged: yes/no
PASS / FAIL:
Notes:
```

Never attach raw keys, credential references, endpoint secrets or user image content.

## Core routing matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| R01 | two unmeasured backends, Auto + Quality | configured order; pair incomparable |
| R02 | two fresh same-axis measurements; right leads >=0.08 | right may promote; measured-advantage |
| R03 | same-axis delta 0.01–0.07 | configured order; below-threshold |
| R04 | A measured, B unmeasured, C strongly measured | C cannot cross B |
| R05 | relevant axis 8–30 days old | stale visible; no capability reorder |
| R06 | Quick covers OCR/general only | OCR/general may compare; other axes unmeasured |
| R07 | Balanced with fresh same-axis latency | formula 0.80 capability + 0.20 speed |
| R08 | Speed with fresh same-axis latency | formula 0.55 capability + 0.45 speed |
| R09 | cloud before enabled local, Auto + Local | local may move first as policy, not superiority |
| R10 | unselected built-in free fallback | fallback-only stays behind user routes |
| R11 | endpoint/model/API/credential identity changes | old `ep2_` evidence not reused |
| R12 | relevant axis latency missing but another axis has latency | Balanced/Speed remain incomparable; no borrowing |
| R13 | relevant axis lacks valid timestamp | not fresh, cannot reorder |
| G-R14 | OCR 8d stale + General today on same backend | OCR stale while General fresh; General refresh does not refresh OCR |
| G-R15 | one axis >30d, another axis fresh | expired axis disappears while fresh axis/profile remains |

## Benchmark matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| B01 | old cache-v2 current-suite profile | conservative migration to cache-v3 per-axis timestamps |
| B02 | Full on healthy backend | all fixtures preflight, then exactly sequential requests |
| B03 | break one fixture renderer in dev | infrastructure failure; zero model requests; old profile untouched |
| B04 | slow attachment persistence + normal model | recorded latency tracks transport, not attachment work |
| B05 | rotate credential value | safe endpoint fingerprint changes; old evidence not reused |
| B06 | credential-required but unresolved | distinct from genuinely keyless identity |
| B07 | DSH credential seam misses while same-name env exists | no silent ambient fallback |
| B08 | provider/auth/rate-limit/network/protocol failure request 1 | fail fast; later fixture requests not sent |
| B09 | force timeout without user Stop | failed/timeout |
| B10 | explicit Stop/Cancel | cancelled |
| B11 | custom/dev runner returns failureCount >0 | persistence refused |
| B12 | document answer token-complete but structurally wrong | score materially reduced |
| G-B13 | remeasure only General on a richer mixed-age profile | only General score/latency/timestamp/count changes |
| G-B14 | remeasure Grounding diagnostic only | other axes retain values and timestamps |

## Background profiler matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| G-P01 | Auto + default `local-free`, local backend missing OCR | after idle, one OCR work item may run |
| G-P02 | Auto + `local-free`, chargeable cloud backend only | zero background cloud benchmark requests |
| G-P03 | Auto + `all`, configured chargeable cloud backend missing axis | background may run; UI has explicit cost warning |
| G-P04 | Auto + `off` | zero background benchmark requests |
| G-P05 | Ordered + any background mode | zero background benchmark requests |
| G-P06 | background axis running, then send real image task | background aborts/yields; real task proceeds normally |
| G-P07 | background axis running, then enqueue manual Benchmark | background aborts/yields until manual queue is idle |
| G-P08 | foreground/manual yield | no provider-failure backoff for yielded work |
| G-P09 | real background provider failure | candidate+axis gets retry backoff; no tight retry loop |
| G-P10 | recent Document visual task then idle | next eligible work prefers direct Document axis when missing/stale |
| G-P11 | unsupported UI/detection task then idle | no fabricated direct capability axis |
| G-P12 | unselected fallback-only backend missing all axes | background profiler ignores it |
| G-P13 | exit short-lived test/doctor process with profiler timer pending | timer does not keep process alive |

## Settings/UI matrix

| ID | Environment/action | Expected result |
| --- | --- | --- |
| U01 | local: Fixed order <-> Auto | routingMode persists/readbacks |
| U02 | cycle Balanced/Quality/Speed/Local | routingPreference persists |
| U03 | cycle background local-free/all/off | backgroundBenchmarking persists |
| U04 | trusted-host remote, permission enabled | same settings RPC/readback path; no new HTTP settings-write route |
| U05 | two clients, change settings on A | B refreshes controls correctly |
| U06 | diagnostics Refresh | one new read-only GET state, no mutation |
| U07 | Copy JSON | sanitized diagnosticVersion payload |
| U08 | Benchmark finishes without closing Settings | new evidence becomes visible |
| U09 | rc.8 remount/reopen repeatedly | one product panel, one diagnostics panel; no loop/duplicates |
| G-U10 | mixed-age profile open in Benchmark modal | every axis shows its own score, median latency, age and Auto/stale state |
| G-U11 | choose `all` | potentially chargeable background behavior is clearly disclosed |

## Runtime separation matrix

| ID | Setup/action | Expected result |
| --- | --- | --- |
| X01 | Auto preview recommends B>A; run real image | actual v1 starts from configured A |
| X02 | inspect Settings preview | healthIncluded:false |
| X03 | induce live breaker/rate-limit and compare | turn shadow may demote; Settings remains health-neutral |
| X04 | manual Benchmark queued/running; restart DSH | jobs do not auto-resume; persisted evidence remains by freshness rules |
| X05 | diagnostics open during chat | GET/DOM activity changes no tool result/retry/timeout/breaker/fallback |
| G-X06 | background profiler active then real visual task | v1 output/order identical to background-profiler-off baseline |

## Host/runtime compatibility minimum

Before executor work, exercise at least:

| DSH | Node | OS | Required checks |
| --- | --- | --- | --- |
| rc.6 | supported Node 22 | Linux/macOS | settings persistence, preview, v1 order unchanged |
| rc.7 | supported Node 22 | Linux/macOS | same |
| rc.8 | Node 24 | macOS | loader/remount, Benchmark, background local/free, real image |
| rc.8 | Node 24 | Windows | UI/Benchmark controls, no duplicate panels |
| rc.8 | Node 24 | Linux | local + trusted-host settings synchronization |

CI is necessary but does not replace these real-machine rows.

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
- secret-safe `ep2_[0-9a-f]{32}` fingerprint;
- measured score/latency/per-axis timestamp/coverage/freshness;
- suite revision;
- local/fallback-only/benchmarkable flags.

## Exit gate before execution-changing Auto

Do not connect Auto preview to the executor until real-machine evidence shows:

1. all unmeasured/stale barriers are visible and preserve order;
2. mixed-age per-axis freshness behaves correctly;
3. Quick/Full preflight/failure/identity rules hold on real adapter + HTTP routes;
4. default `local-free` produces no chargeable cloud background requests;
5. `all` is explicit and clearly disclosed;
6. foreground and manual Benchmark always preempt background profiling;
7. background failures back off safely;
8. no secret/raw user image data enters diagnostics;
9. Local remains labeled as policy;
10. `routingMode:auto` and background profiling still leave actual v1 execution order/result unchanged;
11. minimum rc.6/rc.7/rc.8 host matrix passes.

Only after those gates have real PASS evidence should an opt-in execution-changing Auto commit be discussed.

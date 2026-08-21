# v2 Auto preview acceptance matrix

This is the manual real-machine gate for Commit E + Commit F on `feat/v2-capability-router`.

The goal is not to prove that Auto routing is ready to execute. The goal is to make the current **read-only Auto preview** explainable enough that a human can verify every suggested movement, while Commit F makes Benchmark evidence trustworthy enough to use for that preview.

## Safety invariant

Every captured preview must still report:

```json
{
  "autoPreviewOnly": true,
  "executionActive": false,
  "healthIncluded": false
}
```

`routingMode: auto` is a persisted product setting and a preview input only. v1 remains the actual execution engine and configured execution order remains authoritative.

## What Commit E adds to manual inspection

Under **Settings → Vision Router → Vision model**, the existing Auto preview is followed by **Auto acceptance diagnostics / Auto验收诊断**.

For every directly measured task axis it exposes:

- configured order;
- preview order;
- configured rank and preview rank for every candidate;
- exact candidate key;
- Benchmark evidence state;
- raw measured score for the current axis;
- measured median latency for the current axis;
- whether that evidence is actually Auto-comparable;
- the product scoring formula;
- the `0.08` reorder threshold;
- configured adjacent-pair checks explaining why movement is or is not allowed.

The **Copy JSON / 复制JSON** action copies the same sanitized read-only payload returned by:

```text
GET /_dsh/vision-router/routing-preview
```

The payload may include the secret-safe `ep2_...` endpoint fingerprint. It must never include endpoint URLs, API keys, credential values, credential references, raw Benchmark model output, or arbitrary provider config.

## What Commit F adds to Benchmark trust

Commit F hardens the evidence path before any real-machine provider spend:

- Benchmark suite revision is `2`;
- capability profile cache envelope version is `2`;
- old/wrong-suite profiles are ignored;
- all selected fixtures preflight before request 1;
- every fixture is rasterized through the real Sharp/libvips path;
- adapter attachment materialization happens during preflight, outside the latency window;
- preflight failure sends zero model requests;
- measured latency is transport-only;
- Balanced/Speed use only same-axis measured latency;
- actual credential value changes rotate the secret-safe Benchmark identity;
- credential-required-but-unresolved is distinct from genuinely keyless;
- invocation failures fail fast and cannot persist partial evidence;
- timeout is `failed/timeout`, not `cancelled`;
- document scoring checks structure/relationships rather than token presence;
- the six Full fixtures render successfully in the Ubuntu/macOS/Windows CI host matrix.

CI passing is necessary, but real provider/UI behavior still requires the manual rows below.

## Evidence-state vocabulary

| State | Meaning | Auto effect |
| --- | --- | --- |
| `fresh-measured` | profile is <= 7 days old and contains this axis | may participate in comparison |
| `axis-unmeasured` | fresh profile exists but this axis was not measured | not comparable on this task |
| `stale` | retained profile is > 7 and <= 30 days old | visible to human, excluded from Auto |
| `unmeasured` | no retained current profile | not comparable |
| `unbenchmarkable` | backend cannot currently be benchmarked exactly | not comparable |

The profile store itself retains at most 30 days, so a profile older than that may be indistinguishable from `unmeasured` after normal cache loading. A record without a valid positive `measuredAt` is never treated as fresh.

## Pair-check vocabulary

The diagnostics evaluate each adjacent pair in the configured order so a reviewer can understand the information barriers before looking at the final preview order.

| Outcome | Meaning |
| --- | --- |
| `measured-promotable` | right-side score advantage is >= `0.08` |
| `below-threshold` | both sides are comparable, but the advantage is < `0.08` |
| `incomparable` | at least one side lacks fresh comparable evidence |
| `local-policy-promotes-right` | explicit `Local` policy allows a local route to move ahead of a cloud route |
| `fallback-only-boundary` | a fallback-only route cannot be promoted by Benchmark |

These pair checks are an audit view of the configured chain. The actual preview order is still produced by the shared `suggestVisionOrder()` scorer; the browser does not reimplement routing.

## Result-capture template

For each row below, record:

```text
Case ID:
Date/time:
OS:
Node:
DSH version:
Plugin commit:
Benchmark suite revision:
Profile name:
Access: loopback / trusted-host remote
Configured chain:
Routing mode:
Preference:
Benchmark state per candidate:
Expected preview:
Observed preview:
Copied diagnostics JSON attached: yes/no
Relevant shadow log attached: yes/no/not applicable
Actual v1 execution order unchanged: yes/no
PASS / FAIL:
Notes:
```

Do not paste API keys, endpoint credentials, credential references, or raw provider config into the run record.

## Core routing matrix

| ID | Setup | Action | Expected diagnostic result | Required evidence |
| --- | --- | --- | --- | --- |
| E-R01 | two configured backends, neither measured | Auto + Quality | configured first remains first; both candidates `unmeasured`; pair `incomparable` | screenshot + copied JSON |
| E-R02 | two fresh measurements on same axis, right beats left by >= 0.08 | Auto + Quality | right is promoted; reason `measured-advantage`; pair `measured-promotable` | Benchmark cards + copied JSON |
| E-R03 | fresh same-axis scores differ by 0.01–0.07 | Auto + Quality | configured order preserved; pair `below-threshold` with numeric delta and threshold | copied JSON |
| E-R04 | A measured, B unmeasured, C strongly measured | Auto + Quality | C cannot silently jump across B; B appears as information barrier | screenshot + copied JSON |
| E-R05 | both profiles 8–30 days old | Auto + Quality | raw scores remain human-visible as `stale`; effective capability is absent; no capability reorder | copied JSON |
| E-R06 | Quick profile covers OCR/general only | inspect OCR, General, Document | OCR/general may compare; Document reports `axis-unmeasured` and preserves order | Benchmark modal + copied JSON |
| E-R07 | fresh capability + same-axis latency on both sides | Auto + Balanced | formula shown as `0.80*capability + 0.20*speed`; displayed preview matches computed shared scorer result | copied JSON + manual calculation |
| E-R08 | fresh capability + materially different same-axis latency | Auto + Speed | formula shown as `0.55*capability + 0.45*speed`; no movement unless weighted delta reaches 0.08 | copied JSON + manual calculation |
| E-R09 | cloud route configured before enabled local route, no measurements required | Auto + Local | local route may move first; reason `local-preference`; pair `local-policy-promotes-right`; no claim of measured superiority | screenshot + copied JSON |
| E-R10 | built-in anonymous fallback present but not explicitly selected | any Auto preference | fallback stays behind user routes; diagnostics show `fallback-only` role/boundary where applicable | copied JSON |
| E-R11 | benchmark a backend, then change provider/model/endpoint/API contract so the `ep2_` identity changes | refresh diagnostics | old profile must not become fresh evidence for the new fingerprint; new identity is unmeasured until benchmarked | old/new copied JSON with safe fingerprint |
| F-R12 | fresh capability exists for OCR but OCR latency missing; another axis has latency | Auto + Balanced/Speed | OCR remains incomparable for latency-aware preference; no aggregate/other-axis latency substitution | copied JSON |
| F-R13 | profile record lacks valid `measuredAt` | refresh diagnostics | record is not fresh and cannot reorder | copied JSON |

## Benchmark preflight / evidence matrix

| ID | Setup | Action | Expected result | Required evidence |
| --- | --- | --- | --- | --- |
| F-B01 | clean profile after upgrading to Commit F | open Benchmark | legacy suite/cache evidence is not treated as current fresh evidence; backend requires suite-v2 retest | Benchmark UI + copied JSON |
| F-B02 | Full benchmark on a healthy backend | start Full | all 6 fixtures preflight before first model request; then exactly 6 sequential model requests | log/request counter if available + completed card |
| F-B03 | intentionally break one synthetic fixture/renderer in a dev build | start Full | job fails `infrastructure`; provider request count remains 0; prior profile untouched | test/dev log |
| F-B04 | adapter backend with noticeable local attachment write delay | run repeated benchmark | displayed/stored latency tracks model transport rather than local attachment persistence cost | benchmark JSON + local timing notes |
| F-B05 | same provider/model/URL/protocol with Key A, then rotate to Key B | refresh/retest | secret-safe `ep2_` identity changes; Key A evidence does not become fresh evidence for Key B | old/new safe fingerprint only |
| F-B06 | configured credential ref exists but DSH credential service cannot currently resolve it | refresh candidates | identity is unresolved/key-required, not keyless; no old keyless profile is reused | copied JSON/log without ref/value |
| F-B07 | DSH credential service exists and returns a miss while same-name `process.env` is populated in a dev setup | benchmark/preflight | no silent ambient fallback; configured DSH credential seam remains authoritative | dev log/test evidence |
| F-B08 | provider returns auth/rate-limit/network/protocol/unsupported-image/provider exception on request 1 | run Quick/Full | job fails immediately; later fixture requests are not sent; previous valid profile remains | request count + Benchmark UI |
| F-B09 | force benchmark timeout without user stop | run benchmark | state is `failed`, class/code is timeout; UI must not say user cancelled | Benchmark UI + job JSON |
| F-B10 | explicitly press Stop/Cancel during a running job | cancel | state is `cancelled`; distinct from F-B09 | Benchmark UI + job JSON |
| F-B11 | custom/dev runner returns a record with `failureCount > 0` | execute dev regression | service refuses persistence; previous valid record remains | automated/dev test evidence |
| F-B12 | document fixture returns token-complete but malformed/reordered/mispaired content | score fixture | materially loses score / fails structural expectations; cannot score like valid ordered JSON | scorer test evidence |

## Settings/UI matrix

| ID | Environment | Action | Expected result |
| --- | --- | --- | --- |
| E-U01 | local loopback | switch Fixed order ↔ Auto | persisted `routingMode` survives close/reopen and DSH settings readback |
| E-U02 | local loopback | cycle Balanced / Quality / Speed / Local | persisted `routingPreference` matches selected control after reopen |
| E-U03 | trusted-host remote with permission enabled | change mode/preference remotely | write uses remote settings RPC; local page sees the same value; no HTTP settings mutation endpoint appears |
| E-U04 | two clients open | change Vision Router settings on client A | client B refreshes selected routing controls after settings update/reset |
| E-U05 | diagnostics open | click Refresh diagnostics | one fresh GET result replaces the displayed audit state without changing settings |
| E-U06 | diagnostics open | click Copy JSON | clipboard contains sanitized diagnostic payload with `diagnosticVersion: 1` |
| E-U07 | Benchmark job finishes while Settings remains open | do not close/reopen Settings | diagnostics refresh after Benchmark controls leave active job state; new evidence becomes visible |
| E-U08 | rc.8 client loader enters live mode / Settings remounts | reopen Settings repeatedly | product panel and diagnostics panel reappear once each; no duplicate panels or self-refresh CPU loop |

## Runtime-separation matrix

| ID | Setup | Action | Expected result | Required evidence |
| --- | --- | --- | --- | --- |
| E-X01 | `routingMode: auto`, preview recommends B before A | run a real image tool call | actual v1 executor still starts from configured A; Auto preview remains observational | copied JSON + vision-router log |
| E-X02 | Settings preview open | inspect response | `healthIncluded:false`; no fake session breaker state appears in Settings diagnostics | copied JSON |
| E-X03 | induce breaker/rate-limit on A in a real visual turn with shadow enabled | compare Settings preview vs turn shadow | Settings remains health-neutral; turn shadow may demote A using live breaker `peek()` | copied JSON + shadow log |
| E-X04 | Benchmark job queued/running | restart DSH | chargeable job does not resume; previously persisted valid profile remains available according to freshness/suite rules | before/after Benchmark UI |
| E-X05 | Auto diagnostics open during normal chat | send non-image and image turns | diagnostics GET/DOM activity never changes tool result, retry, timeout, breaker, or fallback behavior | logs + functional result |

## Host/runtime compatibility matrix

At minimum execute these combinations before executor work begins:

| ID | DSH | Node | OS | Required checks |
| --- | --- | --- | --- | --- |
| E-H01 | 0.1.0-rc.6 | supported Node 22 | Linux or macOS | settings load/save, diagnostics GET, copied JSON, actual v1 order unchanged |
| E-H02 | 0.1.0-rc.7 | supported Node 22 | Linux or macOS | same as E-H01 |
| E-H03 | 0.1.0-rc.8 | Node 24 | macOS | loader/remount survival, local Settings, Benchmark completion refresh, real Full benchmark |
| E-H04 | 0.1.0-rc.8 | Node 24 | Windows | diagnostics rendering, Benchmark controls, no duplicate panels |
| E-H05 | 0.1.0-rc.8 | Node 24 | Linux | local + trusted-host remote synchronization |

CI contract passes are necessary but do **not** count as these real-machine rows. Commit F's CI now additionally proves that the six synthetic fixtures rasterize through Sharp on Ubuntu/macOS/Windows; E-Hxx still exists to observe the actual browser settings surface and at least one real v1 image execution path.

## Security/privacy checks

For at least one cloud backend and one local backend, inspect the copied JSON and browser Network response.

Must be absent:

- API key / bearer token;
- credential value;
- credential reference / environment variable name;
- raw endpoint URL;
- arbitrary provider config;
- raw Benchmark model response;
- user image content or path.

Allowed diagnostic identity:

- provider/model candidate key already visible in Settings;
- secret-safe `ep2_[0-9a-f]{32}` fingerprint;
- measured score/latency/timestamp/coverage;
- suite revision;
- local/fallback-only/benchmarkable flags.

## Commit E + F exit gate

The preview/Benchmark gate is considered manually accepted only when:

1. E-R01 through E-R11 and F-R12/F-R13 have no unexplained movement;
2. all `below-threshold` cases preserve configured order;
3. all unmeasured/stale/timestamp-less barriers are visible rather than silently inferred;
4. Balanced/Speed never borrow aggregate or another-axis latency;
5. Local movement is clearly labeled as policy, never measured superiority;
6. F-B01 through F-B12 show suite-v2/preflight/failure/identity semantics behaving as documented;
7. credential rotation changes the safe Benchmark identity without exposing the credential/ref;
8. preflight infrastructure failure produces zero provider requests;
9. timeout and explicit cancellation remain distinguishable;
10. failed/incomplete retests leave previous valid evidence intact;
11. E-X01 proves `routingMode:auto` still does not change real v1 execution;
12. E-X02/E-X03 prove Settings health neutrality versus live-turn breaker diagnostics;
13. no secrets or raw user image data appear in the diagnostic payload;
14. the minimum host/runtime matrix is exercised without duplicate panels or settings readback failures.

Only after this matrix has real PASS evidence should the project discuss an execution-changing Auto commit.

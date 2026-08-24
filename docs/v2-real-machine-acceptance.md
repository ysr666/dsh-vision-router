# Vision Router v2 real-machine self-acceptance

The real-machine acceptance harness runs against the **currently running local DSH process**. It does not grant authority by itself: execution-changing Auto is active only when the user's live `routingMode` is explicitly `auto`.

The acceptance runner follows the same authority rule as v2 itself:

> Auto is delegated control, not assumed control.

Safe authority checks, real Auto execution, and exact-provider Benchmark deliberately use **independent grants**. Permission to mutate temporary routing settings does not imply permission to call a real provider, and permission to call one exact provider does not imply permission to change routing settings.

## J0a — safe authority + execution-seam acceptance

Run:

```bash
dsh-vision-router-acceptance --accept-safe-mutations --json
```

The safe phase temporarily changes only `routingMode` and `backgroundBenchmarking`, snapshots/restores the exact user-layer shape in `finally`, registers a process-local DSH adapter, traverses the real `ctx.llm.stream` runtime-performance wrapper, and makes **zero real provider/API requests**.

It covers:

| Case | Contract |
| --- | --- |
| A01 | Missing background authority resolves to `off`. |
| A02 | `routingMode:auto` does not imply background measurement authority. |
| A02-runtime | The live background profiler stays idle without measurement authority. |
| A06 | Fixed order creates zero runtime-routing samples. |
| A07-1 | First Auto sample is warming only. |
| A07-2 | Repeated Auto samples become eligible at the live threshold. |
| A08 | Revoking Auto in flight suppresses publication of the runtime sample. |
| A09 | Raw Benchmark manager calls without an opaque manual grant are rejected. |
| L00 | No current setting grants persistent behavioral learning. |
| R00 | Original user-layer authority settings are restored exactly. |
| E01-auto-execution-scope | The real DSH core `vision-router` SettingsScope accepts a process-local Auto order, exposes it only inside the scoped call, restores the original view afterward, and makes zero provider requests. |

The CLI also checks that the live routing diagnostics remain read-only and secret-minimized while reporting the current execution state truthfully:

```text
routingMode: auto    -> autoPreviewOnly=false, executionActive=true
routingMode: ordered -> autoPreviewOnly=true,  executionActive=false
```

The execution scope is deliberately narrow:

```text
executionScope: router-owned-visual-tools
executionFailClosed: true
```

Planner failure, authority revocation, or settings changes before execution fall back to the configured v1 order.

### Recorded real-machine E01 evidence

On **2026-08-24**, the zero-provider execution-scope probe passed against a running local DSH process with:

```json
{
  "ok": true,
  "scopeHooked": true,
  "transientOverrideWorks": true,
  "restored": true,
  "providerRequestsMade": 0,
  "executionCapable": true,
  "executionScope": "router-owned-visual-tools",
  "executionFailClosed": true
}
```

This proves the Auto execution seam is connected to the SettingsScope actually consumed by the real DSH-hosted v1 core, rather than existing only in isolated unit-test scaffolding.

## Real Auto execution — bounded two-request acceptance

Run only with explicit permission to make provider requests that may incur cloud charges:

```bash
dsh-vision-router-acceptance \
  --accept-real-execution \
  --allow-provider-requests \
  --allow-chargeable-cloud \
  --json
```

This phase requires the already-measured `opencode-go/minimax-m3` and `zhipu-glm/glm-4.6v` routes in the configured provider list. It temporarily places MiniMax immediately before GLM, selects Quality + Auto, invokes the real registered `vision_ground` tool at most twice, and restores the exact original user-layer routing/background fields in `finally`.

| Case | Contract |
| --- | --- |
| E02-real-auto-reorder | Existing comparable Grounding evidence changes the planned first backend, and the real visual tool attempts that backend first. |
| E04-scoped-fallback-transport | The selected identity stays unchanged through its authorized direct-HTTP compatibility transport. |
| E03-last-moment-revocation | Revoking Auto after planning but before the live authority recheck discards the plan and attempts the current configured first backend. |
| E05-provider-identity-stable | The selected backend's secret-safe capability fingerprint is unchanged by execution. |
| R00-real-execution-settings-restore | The original user-layer routing and background settings are restored exactly. |

### Recorded real-machine execution evidence

On **2026-08-24**, the bounded real execution phase passed with two successful provider requests:

```text
Configured Grounding first: opencode-go/minimax-m3 (score 0.0000)
Auto planned/actual first:   zhipu-glm/glm-4.6v (score 0.9617)
Decision:                    measured-advantage, delta 0.9617
Transport:                   host-advisory-preflight-direct-bridge
GLM token field:             max_completion_tokens

Plan before revocation:      zhipu-glm/glm-4.6v
Actual first after revoke:   opencode-go/minimax-m3
Revocation result:           authority-revoked, configured-order execution
Settings restore:            exact byte-for-byte match
```

The GLM call used the Host's text-projection advisory path, so this evidence proves the scoped preflight direct bridge; it does not claim an adapter rejection that did not occur.

### Recorded browser acceptance

The same run also verified the visible settings diagnostics in the running local UI:

- Auto was shown as execution-active, scoped to Router-owned visual tools, with configured MiniMax → GLM and Auto GLM → MiniMax Grounding orders;
- the expanded decision showed `0.000 vs 0.962`, delta `0.962`, threshold `0.080`, and the measured-advantage reason;
- the diagnostics endpoint remained GET-only (`POST` returned `405`) and its JSON contained no credential or raw endpoint material;
- toggling Composer Vision mode on and off made no provider request, preserved the ordinary `ByteDance Seed: Seed 1.6` selection, produced no alert, and did not alter routing settings;
- the original settings document matched its pre-run backup byte-for-byte after UI restoration.

## J0b — real-provider acceptance

J0b is a separate measurement-authority gate. It does **not** require `--accept-safe-mutations`.

### 1. Discover exact backend keys

Read-only discovery makes no mutations and no provider requests:

```bash
dsh-vision-router-acceptance --list-candidates
```

For machine-readable output:

```bash
dsh-vision-router-acceptance --list-candidates --json
```

The output contains only public candidate metadata such as exact key, provider/model, local/cloud-cost warning, benchmarkability, secret-safe fingerprint, and currently measured axes.

### 2. Authorize one exact real backend

For a local or otherwise non-charge-warning candidate:

```bash
dsh-vision-router-acceptance \
  --provider <exact-backend-key> \
  --allow-provider-requests \
  --json
```

For a candidate marked as potentially chargeable cloud, a second explicit grant is required:

```bash
dsh-vision-router-acceptance \
  --provider <exact-backend-key> \
  --allow-provider-requests \
  --allow-chargeable-cloud \
  --json
```

`--mode quick|full|grounding` selects the existing bounded Benchmark mode. `--force` preserves the explicit force-verification boundary for models DSH currently declares text-only.

### J0b evidence contract

J0b uses the existing exact Benchmark manager. The production benchmark path already enforces `exactBackend: true` and `allowFallback: false`; J0b then compares the live public Benchmark snapshot immediately before and after the authorized run.

A successful J0b run must prove:

| Case | Contract |
| --- | --- |
| B-live | The explicitly authorized Benchmark job completes. |
| T06-live | The real manual Benchmark creates no runtime-performance samples. |
| J0B-exact-identity | Candidate key/provider/model and secret-safe capability fingerprint remain bound to the same exact backend. |
| J0B-capability-evidence | Every requested direct axis has fresh persisted capability evidence from the run, on the current suite revision. |
| J0B-axis-scope | Re-measuring selected axes does not rewrite pre-existing evidence on unrelated axes. |
| P-public (post-run) | Public routing/Benchmark surfaces remain secret-minimized after real evidence/job data exists. |

If the real provider Benchmark itself fails, J0b still checks that previously persisted capability evidence was not overwritten (`J0B-failure-preserves-evidence`). The overall provider acceptance remains failed because the requested real measurement did not complete successfully.

Mode-to-axis expectations:

```text
quick      -> ocr + general
full       -> structured + ocr + document + grounding + general
grounding  -> grounding
```

## Benchmark visual-proof contract — suite v5

Every scored fixture contains a random image-visible `VR-CODE` badge. The random code is not present in the text prompt; a provider that never inspects the image therefore cannot manufacture valid capability evidence by replaying known fixture answers.

Real-machine testing exposed that the original universal proof instruction could conflict with the task format itself:

- OCR asks for all task text in top-to-bottom order, while the badge is physically near the top of the image;
- Structured/Document ask for `ONLY JSON`, while the proof must live outside the JSON body;
- Grounding asks for a coordinate-only answer line, while the proof requires a second line.

Suite v4 fixed the Grounding wording, and a real `zhipu-glm/glm-4.6v` Grounding run then completed successfully. However, a suite-v4 Quick run on the same known-working visual backend still failed visual proof, revealing that the conflict was cross-fixture rather than Grounding-only.

Suite v5 makes the boundary explicit for **all** scored fixture families:

```text
VR-CODE badge = benchmark verification metadata, not task content
requested answer body = obey the fixture's normal OCR / JSON / grounding / general contract
final line = the sole permitted output-format exception: VR-CODE:<code>
```

The badge remains mandatory and image-only. It must not be included inside OCR task text or JSON task content, and the verifier still rejects a missing or incorrect proof. Because this changes the measurement prompt contract, suite v5 intentionally invalidates suite-v4 fingerprints/evidence rather than silently reusing them.

## Combining J0a and J0b

Both grants may be supplied in one invocation when desired:

```bash
dsh-vision-router-acceptance \
  --accept-safe-mutations \
  --provider <exact-backend-key> \
  --allow-provider-requests \
  --json
```

They remain independent internally: the J0a grant authorizes only temporary settings mutation, while the J0b grant authorizes only the named real-provider measurement action.

## Exit status

- `0`: every requested required case passed;
- `1`: at least one requested acceptance case failed or the live DSH runtime rejected the run;
- `2`: invalid arguments or required user consent was not supplied.

## Remaining boundary

The recorded evidence covers exact Benchmark identity/evidence, real execution-changing Auto selection, last-moment authority revocation, the scoped direct-HTTP compatibility path, visible browser diagnostics, and exact settings restoration. It does not broaden Auto beyond Router-owned visual tools, grant background cloud measurement without its separate setting, or authorize persistent behavioral learning.

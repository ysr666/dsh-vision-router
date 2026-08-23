# Vision Router v2 real-machine self-acceptance (J0a + J0b)

The real-machine acceptance harness runs against the **currently running local DSH process**. It does not grant authority by itself: execution-changing Auto is active only when the user's live `routingMode` is explicitly `auto`.

The acceptance runner follows the same authority rule as v2 itself:

> Auto is delegated control, not assumed control.

J0a and J0b deliberately use **independent grants**. Permission to mutate temporary routing settings does not imply permission to call a real provider, and permission to call one exact provider does not imply permission to change routing settings.

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

## What J0a/J0b still do not prove

The zero-provider E01 probe proves that real DSH consumes the scoped Auto order and restores it correctly, but it intentionally does **not** invoke an actual visual provider. J0b proves exact real-provider measurement behavior, not end-to-end Auto selection on a real user visual call.

Remaining real-machine evidence should therefore focus on bounded, explicitly authorized cases that add information not already proven by E01/CI, such as:

- one real visual call where measured/policy evidence actually changes the selected first backend;
- live revocation or settings change immediately before a real provider call, proving configured-order fallback;
- real adapter + direct-HTTP fallback behavior under the same execution scope;
- browser diagnostics showing the execution state and selected order without leaking endpoint/credential material.

Persistent behavioral learning remains prohibited because no authority for it exists.

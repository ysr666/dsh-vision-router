# Vision Router v2 real-machine self-acceptance (J0a)

J0a turns the highest-priority v2 authority checks into a local, repeatable acceptance run executed **inside the running DSH process**.

It does not enable execution-changing Auto and does not change the product UI.

## Authority model of the acceptance runner

The acceptance runner follows the same rule as v2 itself:

> Auto is delegated control, not assumed control.

Running the safe phase requires an explicit command-line grant:

```bash
dsh-vision-router-acceptance --accept-safe-mutations
```

That grant authorizes only temporary changes to `routingMode` and `backgroundBenchmarking` for the duration of the safe acceptance request. The service snapshots the exact user-layer shape (including whether each field was absent), keeps background measurement disabled while exercising the authority boundary, and restores the original user-layer values in `finally`.

The safe phase:

- registers a process-local temporary DSH adapter;
- traverses the real `ctx.llm.stream` runtime-performance wrapper;
- makes **zero real provider/API requests**;
- writes no capability evidence;
- removes temporary runtime-performance evidence before returning;
- refuses to start while foreground vision work, manual Benchmark work, or a background Benchmark is active.

The acceptance route is POST-only and independently requires a loopback TCP peer plus localhost/loopback `Host` header.

## Safe phase coverage

The live DSH process verifies:

| Case | Contract |
| --- | --- |
| A01 | Removing the user background field resolves to `off`; absence grants no measurement authority. |
| A02 | `routingMode:auto` alone does not activate background measurement. |
| A02-runtime | The actual live background profiler remains idle when measurement authority is absent and does not add backoff. |
| A06 | A real stream through the process-local adapter in `ordered` mode creates zero runtime-routing samples. |
| A07-1 | The first real Auto sample is visible only as warming evidence when the runtime requires multiple samples. |
| A07-2 | Repeated Auto samples become eligible at the live runtime threshold. |
| A08 | Revoking Auto while a real stream is in flight suppresses publication of that call as future routing evidence. |
| A09 | A raw/programmatic Benchmark manager call without an opaque manual grant is rejected before backend selection. |
| L00 | No current v2 setting grants persistent behavioral learning. |
| R00 | The exact original user-layer authority settings are restored after the run. |

The CLI also reads the live routing-preview and Benchmark snapshot endpoints and verifies:

- `autoPreviewOnly: true`;
- `executionActive: false`;
- `healthIncluded: false`;
- no public API-key/credential/raw-endpoint/raw-response/token fields or values are present.

## Optional real-provider phase

A real provider Benchmark is **not** part of the safe grant.

To exercise an exact configured backend, the user must additionally name that backend and authorize provider requests:

```bash
dsh-vision-router-acceptance \
  --accept-safe-mutations \
  --provider vision-http/local-ollama/qwen2.5vl \
  --allow-provider-requests
```

If the selected candidate is flagged as potentially chargeable cloud, the service refuses the request unless the user adds a second grant:

```bash
dsh-vision-router-acceptance \
  --accept-safe-mutations \
  --provider http:cloud/model \
  --allow-provider-requests \
  --allow-chargeable-cloud
```

The provider phase uses the existing exact Benchmark manager, mints the same opaque per-action manual measurement grant as an explicit local user action, and verifies that the real Benchmark does not create runtime-performance samples.

`--mode quick|full|grounding` selects the existing bounded Benchmark mode. `--force` preserves the existing explicit force-verification boundary for models DSH currently declares text-only.

## Machine-readable report

Use:

```bash
dsh-vision-router-acceptance --accept-safe-mutations --json
```

Exit status:

- `0`: every required case passed;
- `1`: at least one acceptance case failed or the live DSH runtime rejected the run;
- `2`: invalid arguments or required user consent was not supplied.

Skipped/optional cases do not silently count as passes; the report keeps their status explicit.

## What J0a deliberately does not prove

J0a is a pre-executor acceptance layer. It does **not** claim that execution-changing Auto is ready, and it does not allow the runner to grant that authority to itself.

A future provider/browser expansion may add more real-environment evidence, but any step capable of spending quota, changing execution, or persisting behavioral learning must remain separately user-authorized.

# Capability-aware vision routing

Vision Router separates routing into four ordered concerns:

> Authority → Evidence → Planner → Execution

The user delegates control explicitly. Auto never grants itself permission to
measure models, spend cloud quota, or introduce routes that the user did not
configure.

## Product controls

The public routing contract contains three settings:

```text
routingMode: ordered | auto
routingPreference: balanced | quality | speed | local
backgroundBenchmarking: off | local-free | all
```

`ordered` and `off` are the defaults.

- `ordered` follows the configured provider/model order.
- `auto` starts immediately and affects only Router-owned visual tools. It uses
  reliable evidence when available and otherwise keeps the configured order.
- `backgroundBenchmarking` is independent authority. `local-free` permits idle
  measurement only for local or trusted free routes. `all` also permits
  configured cloud routes that may incur charges.

Enabling Auto does not start a Benchmark and does not imply background
measurement permission.

## Evidence boundaries

Capability evidence belongs to an exact non-secret deployment identity and the
current Benchmark suite. A new model, changed provider/model/deployment identity,
or wrong-suite record is unmeasured until it is tested under the current
contract.

The planner does not infer capability from a model name, family, provider
reputation, another capability axis, or a generic prior. An unmeasured or
otherwise incomparable route is an information barrier, so configured order is
preserved across it.

Credentials determine access, not capability identity. Credential values are
never stored in capability evidence.

Benchmark latency is historical information about the test run. Balanced and
Speed routing use only recent successful real visual-tool runtime observations;
Benchmark duration is never substituted as runtime-speed evidence.

Capability profiles are persisted by the profile store. Under the same current
Benchmark suite and the same deployment fingerprint, a measured axis is not
background-tested again merely because it is old. A complete five-axis profile
therefore produces zero background requests; a partial profile fills only its
missing axes. A suite or deployment-identity change creates new evidence scope
and can require measurement again.

## Planner and execution

Configured order is always the baseline. Auto makes conservative adjacent
reorders and requires a measured advantage of at least:

```text
AUTO_REORDER_MIN_ADVANTAGE = 0.08
```

Fallback-only built-ins cannot Benchmark-promote over user-selected routes, and
arbitrary DSH-discovered routes do not enter the execution pool.

Immediately before execution, Vision Router reads live settings again. A stale
plan, revoked Auto authority, or planner failure falls back to the current
configured order. The temporary Auto order is isolated to one visual-tool call
with `AsyncLocalStorage` and is restored automatically afterward.

Host text-only metadata is advisory for a user-selected generative model. It is
not treated as proof that the model cannot inspect images. **Test Vision** always
tries the exact current dropdown selection when its live adapter can be invoked.
If the user has explicitly enabled `backgroundBenchmarking`, eligible configured
models are also actually measured within that cost scope even when Host metadata
currently labels them text-only. The measured result, rather than the Host label,
is the capability evidence used by Auto.

Structural non-generative exclusions remain hard boundaries: explicit measurement
authority never turns an endpoint that cannot be invoked as a generative model
into an execution route.

## Capability Benchmark

Auto model rows expose **Benchmark** alongside the independent **Test Vision**
control. Ordered mode retains **Test Vision** but does not need Benchmark as an
Auto-routing control.

- **Test Vision**: one request to the exact current model, with fallback disabled.
  It verifies whether that model can actually inspect an image and does not
  create an Auto capability score. This explicit check is independent from the
  persisted Auto Benchmark candidate/evidence pool, so a newly selected live
  adapter model can be checked before it has benchmark evidence.
- **Quick**: OCR + General, about three requests.
- **Full**: Structured + OCR + Document + Grounding + General, about six
  requests.

A Host text-only label is shown as an advisory, not as a separate product mode.
Quick/Full Benchmark may still send generated test images to verify the model
when the user explicitly starts the Benchmark. The implementation may carry an
internal force flag for compatibility with older service guards, but users do
not need to reason about a separate “Force Verify” workflow.

Benchmark uses generated fixtures rather than user images. It targets the exact
selected backend with fallbacks disabled. All fixtures and attachment
materialization are preflighted before the first model request. A failed or
cancelled run does not publish partial evidence, and a failed retest preserves
the prior valid profile. Each fixture has its own hard deadline aligned with the
normal 120-second provider-call ceiling, while the whole manual Benchmark keeps a
larger run deadline so a legitimate slow Quick/Full sequence is not discarded
after its requests have already completed.

Cloud Benchmark requests may cost money. Manual tests require an explicit user
action; background paid tests require `backgroundBenchmarking: all`.

The explicit one-image Test Vision path has a bounded end-to-end deadline and is
selection-scoped. Changing the row selection aborts the old browser request, and
a late result from the previous model cannot overwrite the newly selected row.
User-facing failures are localized; low-level provider details are retained only
as diagnostic detail rather than primary UI copy.

## Background measurement

Background work fills only missing capability axes and never becomes persistent
behavioral learning. The fixed measurement order is axis-first:

```text
all eligible OCR
→ all eligible General
→ all eligible Document
→ all eligible Structured
→ all eligible Grounding
```

Priority is:

```text
real visual execution
> manual Benchmark
> background measurement
```

Real visual work immediately preempts background work and restarts the normal
idle window. Manual Benchmark pauses background work, but when manual work ends
background resumes after only its normal short gap rather than manufacturing a
new full foreground-idle delay.

Within an explicitly enabled background mode, Host text-only metadata does not
silently remove an otherwise eligible configured model from measurement. This is
intentional: standing background authority is the user's permission to verify
capability within the selected local/free/paid cost boundary, not permission to
trust possibly stale Host modality metadata as ground truth.

Transient failure state is scoped to the exact deployment fingerprint plus model
and axis. Network, timeout, and rate-limit conditions receive retry backoff.
Clear deployment-level non-retryable failures such as authentication failure,
unavailable model, and unsupported protocol are persisted for the same exact
fingerprint and stop unattended measurement across axes, including after process
restart. Visual-proof and Benchmark-infrastructure failures remain axis-scoped;
they do not manufacture a text-only verdict or disable other axes. An explicit
image-input rejection is persisted separately as a measured text-only verdict.
Ordinary settings refreshes, adapter notifications, and process restart do not
silently clear these same-fingerprint stops. A changed deployment fingerprint
creates a new evidence scope, and an explicit successful Test Vision clears the
same-fingerprint stop. Public background status exposes only a sanitized failure
class/code; raw provider responses and credentials are not published to the
browser.

Changing authorization while work is running is enforced immediately. `all →
off` aborts background work; `all → local-free` aborts a no-longer-authorized
paid cloud request while allowing still-authorized local/trusted-free work to
finish; `local-free → all` keeps the current work and expands later candidates.
Changing or deleting a configured route prevents obsolete work or half-finished
results from publishing evidence for a replacement identity.

## Security boundaries

- Plugin mutation routes are loopback-only and same-origin protected.
- Remote settings expose only the public allow-list; internal routing evidence
  and prototype fields are not remotely readable or writable.
- Capability identity and public errors exclude credentials, raw responses, and
  private endpoint material.
- Auto authority cannot grant background or paid-request authority.
- Prototype controls from pre-release settings documents are ignored. The Host
  may preserve unknown keys so an upgrade does not destroy the user's document,
  but those keys are absent from the public schema and never affect routing.
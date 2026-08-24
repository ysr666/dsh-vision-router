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

Host text-only metadata remains advisory for a user-selected generative model.
It does not become a generic permanent blacklist for normal execution or an
explicit user test. Unattended Background Benchmark is deliberately more
conservative: when the Host positively declares a model text-only, standing
background authority does not spend requests trying to contradict that
advisory. The user may still use **Test Vision** or **Force Verify** explicitly.

## Capability Benchmark

Auto model rows expose **Benchmark** alongside the independent **Test Vision**
control. Ordered mode retains **Test Vision** but does not need Benchmark as an
Auto-routing control.

- **Test Vision**: one request to the exact current model, with fallback disabled.
  It verifies whether that model can actually inspect an image and does not
  create an Auto capability score.
- **Quick**: OCR + General, about three requests.
- **Full**: Structured + OCR + Document + Grounding + General, about six
  requests.
- **Force Verify**: available when Host metadata says text-only and the user
  explicitly wants to challenge that advisory with a manual capability test.

Benchmark uses generated fixtures rather than user images. It targets the exact
selected backend with fallbacks disabled. All fixtures and attachment
materialization are preflighted before the first model request. A failed or
cancelled run does not publish partial evidence, and a failed retest preserves
the prior valid profile.

Cloud Benchmark requests may cost money. Manual tests require an explicit user
action; background paid tests require `backgroundBenchmarking: all`.

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

Failure state is scoped to the exact deployment fingerprint plus model and axis,
so one model or axis cannot block another. Transient failures such as network,
timeout, and rate-limit conditions receive retry backoff. Clear non-retryable
conditions such as authentication failure, unsupported image input, unavailable
model, unsupported protocol, or Benchmark infrastructure failure stop automatic
retry for that exact work item until relevant settings/topology/identity changes
or the user explicitly tests again. Public background status exposes only a
sanitized failure class/code; raw provider responses and credentials are not
published to the browser.

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

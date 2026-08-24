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
  measurement only for local or free routes. `all` also permits configured
  cloud routes that may incur charges.

Enabling Auto does not start a Benchmark and does not imply background
measurement permission.

## Evidence boundaries

Capability evidence belongs to an exact non-secret deployment identity and the
current Benchmark suite. A new model, changed provider/model identity, or
wrong-suite record is unmeasured until it is tested under the current contract.

The planner does not infer capability from a model name, family, provider
reputation, another capability axis, or a generic prior. An unmeasured or
otherwise incomparable route is an information barrier, so configured order is
preserved across it.

Credentials determine access, not capability identity. Credential values are
never stored in capability evidence.

Benchmark latency is historical information about the test run. Balanced and
Speed routing use only recent successful real visual-tool runtime observations;
Benchmark duration is never substituted as runtime-speed evidence.

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
The model can be explicitly force-verified, but generic text-only metadata does
not become a permanent blacklist.

## Capability Benchmark

Each configured model has one **Benchmark** entry:

- **Quick**: OCR + General, about three requests.
- **Full**: Structured + OCR + Document + Grounding + General, about six
  requests.
- **Force Verify**: shown only when Host metadata says text-only and the user
  explicitly wants to test image support.

Benchmark uses generated fixtures rather than user images. It targets the exact
selected backend with fallbacks disabled. All fixtures and attachment
materialization are preflighted before the first model request. A failed or
cancelled run does not publish partial evidence, and a failed retest preserves
the prior valid profile.

Cloud Benchmark requests may cost money. Manual tests require an explicit user
action; background paid tests require `backgroundBenchmarking: all`.

## Background measurement

Background work fills only missing capability axes and never becomes persistent
behavioral learning. Priority is:

```text
real visual execution
> manual Benchmark
> background measurement
```

Real visual work preempts background work. Provider failures use retry backoff.
Changing or deleting a configured route prevents obsolete work from granting
authority to the replacement route.

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

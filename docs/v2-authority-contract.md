# Vision Router v2 Authority Contract

Status: **normative design contract for the v2 Draft**

This document defines who is allowed to make each class of decision in Vision Router v2. It is intentionally stricter than an implementation toggle: a feature being technically possible does not grant Vision Router authority to perform it.

The governing rule is:

> **Auto is delegated control, not assumed control.**
>
> **The user grants authority; evidence informs the decision; the router acts only within that authority.**

A second rule follows from it:

> **No authority may be inferred from another authority.**

In particular, enabling automatic routing does not authorize background measurement, background measurement does not authorize execution-changing routing, and a successful Benchmark does not authorize either of them.

## 1. Scope

This contract applies to v2 behavior that can:

- change which visual backend is actually called;
- create an additional provider/model request for measurement or verification;
- persist evidence that was created by an active measurement;
- observe real visual-call performance for future routing decisions;
- later persist user-specific runtime/outcome learning;
- mutate any setting that grants one of those authorities.

Pure read-only computation, sanitized diagnostics, and side-effect-free availability inspection do not gain execution authority merely because they can recommend a different route.

## 2. Product model

Vision Router v2 is an authority-first routing system:

```text
User Authority
      ↓
Visual Task
      ↓
User Preference
      ↓
Candidate Eligibility
      ↓
Evidence
      ↓
Routing Decision
      ↓
Authority Enforcement
      ↓
Execution
      ↓
Observation
```

`Quality / Balanced / Speed / Local` are **preferences**, not permissions.

A preference answers:

> If Vision Router is allowed to choose, what should it optimize for?

Authority answers:

> Is Vision Router allowed to choose, measure, observe for future routing, or persist learning at all?

Those questions must remain separate in configuration, planner inputs, diagnostics, tests, and the future executor.

## 3. Authority domains

### 3.1 Execution Authority

Execution Authority controls whether a routing recommendation may change the real backend order/result.

Current product intent:

```text
routingMode: ordered -> no execution-changing Auto authority
routingMode: auto    -> user delegates backend-selection authority to Auto
```

Rules:

1. `ordered` is the fail-closed/default state.
2. Missing, malformed, legacy, or ambiguous state must not grant execution authority.
3. `routingPreference` never grants execution authority.
4. Benchmark evidence never grants execution authority.
5. Shadow/preview output never grants execution authority.
6. A future executor must re-check live Execution Authority immediately before applying a routing decision; planner-time authority alone is insufficient.
7. Revoking Auto must take effect for future routing decisions without requiring a restart.
8. While this PR remains preview-only, `routingMode:auto` records the user's product intent but must still report `executionActive:false` and must not change v1 execution.

### 3.2 Measurement Authority

Measurement Authority controls requests created **only to obtain evidence**, rather than to satisfy the user's current visual task.

There are two distinct forms.

#### Manual measurement

A user action that explicitly starts an exact smoke test or a Quick/Full capability Benchmark grants authority only for that requested job.

Rules:

- manual Benchmark does not require Auto to be enabled;
- manual Benchmark does not authorize future background Benchmarking;
- manual smoke test does not authorize capability-profile persistence beyond the behavior of that explicit action;
- Stop/Cancel revokes the remaining authority for that job;
- failure/timeout does not create a new authority grant.

#### Background measurement

Background measurement is standing authority to create additional requests while idle.

Normative semantics:

```text
backgroundBenchmarking: off        -> no background measurement authority
backgroundBenchmarking: local-free -> explicitly permit eligible local/known-free background measurement
backgroundBenchmarking: all        -> explicitly permit eligible configured cloud background measurement, including potentially chargeable requests
```

Rules:

1. **Absence, invalid state, migration fallback, or schema default must resolve to no background measurement authority.**
2. `routingMode:auto` must not implicitly grant `local-free` or `all` measurement authority.
3. `local-free` is still an active-work permission: zero monetary price does not mean zero CPU/GPU/network/resource cost.
4. `all` is a stronger grant than `local-free` and must never be inferred from provider configuration, credentials, capability gaps, or Auto preference.
5. Revocation must be checked before work starts and while work is running; an active background measurement must yield/abort when its authority disappears.
6. Foreground visual work and explicit manual Benchmark remain higher priority than background measurement.

### 3.3 Learning / Observation Authority

Learning Authority controls whether facts derived from real user work may be retained for future routing decisions.

This contract distinguishes two levels.

#### Ephemeral runtime-performance observation

Current v2 runtime performance is process-local, bounded, and non-persistent. It creates no additional provider request.

Normative rule:

> Ephemeral performance evidence may be collected for future routing only while the user has explicitly enabled Auto.

Therefore:

- `ordered` mode should not accumulate future-routing performance evidence;
- `auto` may use successful real visual calls as short-lived performance evidence;
- failures/aborts must not become positive performance evidence;
- Benchmark, background Benchmark, and smoke-test calls must not enter the runtime-performance store;
- restarting DSH clears this evidence.

Execution Authority does **not** authorize persistent behavioral learning.

#### Persistent runtime/outcome learning

There is currently no v2 authority field for persistent user-specific runtime/outcome learning.

Therefore it is **prohibited by default**.

A future feature that persists facts such as historical success rate, retries, model replacements, task outcomes, or long-lived user-specific performance must introduce a separate explicit authority contract before implementation. It must not be smuggled in as an extension of `routingMode:auto`, Benchmark cache, diagnostics, or process-local runtime observation.

## 4. Evidence is not authority

Evidence answers what the router knows. Authority answers what the router may do.

The following evidence sources do not grant permission by themselves:

- exact capability Benchmark scores;
- Benchmark latency observations;
- process-local runtime latency;
- breaker/availability state;
- model metadata;
- endpoint identity;
- configured credentials;
- previous routing recommendations;
- high decision confidence.

A high-confidence recommendation without Execution Authority remains a recommendation only.

A capability gap without Measurement Authority remains a gap; Vision Router must not manufacture a measurement request to fill it.

## 5. Authority non-implication matrix

| Existing fact / grant | Must **not** imply |
| --- | --- |
| `routingMode:auto` | background Benchmark permission |
| `routingMode:auto` | persistent runtime/outcome learning |
| `routingPreference: quality/balanced/speed/local` | execution or measurement permission |
| `backgroundBenchmarking: local-free` | execution-changing Auto |
| `backgroundBenchmarking: all` | execution-changing Auto |
| manual Quick/Full Benchmark | future background Benchmark permission |
| manual smoke test | capability Benchmark permission |
| valid capability cache | permission to select a different backend |
| runtime-performance samples | permission to select a different backend |
| breaker says backend unavailable | permission to rewrite stored capability |
| `capabilityRoutingShadow:true` | execution, measurement, or persistent learning permission |
| configured API credential | permission to spend it on background measurement |

## 6. Authority-bearing settings

Authority-bearing settings must fail closed.

Current authority-bearing product settings are:

```text
routingMode
backgroundBenchmarking
```

`routingPreference` is not authority-bearing.

Rules for authority-bearing settings:

1. Safe defaults grant no active side-effect authority.
2. A missing field must not be normalized into a grant.
3. Migration/backward-compatibility logic must never silently upgrade authority.
4. A setting write must be persisted/read back through the Host-authoritative settings path before code relies on the new grant.
5. Runtime code must read live settings at the point where revocation matters.
6. Authority-changing writes from a trusted remote settings client are valid only because the user separately delegated remote settings control via `allowRemoteSettings`; that meta-authority must remain explicit and revocable.

## 7. Remote settings delegation

`allowRemoteSettings` is a meta-authority: when explicitly enabled after its risk confirmation, a trusted-host settings client may act on the user's behalf for fields on the reviewed mutable allow-list.

This does not weaken this contract:

- remote mutation of an authority-bearing field must still be an explicit settings mutation;
- default values, connection establishment, page load, diagnostics refresh, or mere remote access must not grant Auto/background authority;
- disabling `allowRemoteSettings` revokes future remote mutations;
- adding a new authority-bearing field to the remote mutable allow-list requires explicit review.

## 8. Planner contract

The planner may always compute a recommendation from permitted read-only facts. It must not treat the ability to compute a recommendation as permission to execute it.

The target v2 decision contract should make authority explicit, for example:

```js
{
  task: 'ocr',
  configuredOrder: ['A', 'B'],
  effectiveOrder: ['B', 'A'],
  selected: 'B',
  preference: 'quality',
  confidence: 'high',
  authority: {
    executionAllowed: true,
    backgroundMeasurementAllowed: false,
    persistentLearningAllowed: false,
  },
  reason: {
    type: 'direct-capability-advantage',
    axis: 'ocr',
  },
}
```

The exact shape may evolve, but these invariants may not:

- decision evidence and decision authority are separate fields/concepts;
- a recommendation can exist with `executionAllowed:false`;
- the future executor must reject or ignore an execution-changing decision if live authority no longer permits it.

## 9. Executor contract

The future execution-changing Auto seam must be an independent enforcement boundary.

Before changing the configured v1 order, the executor must establish all of the following:

1. live `routingMode` still grants Auto execution;
2. the decision was produced for the current task/configuration identity;
3. no authority-bearing setting has been revoked or changed incompatibly;
4. the selected backend remains eligible under hard policy/access constraints;
5. falling back to the configured v1 behavior remains possible when authority or evidence is insufficient.

Fail closed:

```text
missing authority -> configured v1 order
stale/ambiguous authority -> configured v1 order
planner failure -> configured v1 order
insufficient evidence -> configured v1 order unless policy itself explicitly decides otherwise
```

## 10. Revocation semantics

Revocation is a first-class operation, not an eventual preference.

- Auto -> Ordered: future execution-changing decisions stop immediately.
- Background `local-free/all` -> `off`: queued work must not start; running background work must yield/abort.
- `all` -> `local-free`: cloud background work loses authority immediately; only eligible local/known-free work may remain.
- manual Benchmark Cancel: remaining requests for that job must stop.
- future persistent-learning opt-out: no new persistent learning may be written after revocation; retention/deletion semantics must be separately documented before that feature exists.

## 11. Current v2 Draft boundaries

Until a later executor commit explicitly changes this state:

```text
autoPreviewOnly: true
executionActive: false
```

The current Draft may:

- compute Auto previews;
- show sanitized evidence/diagnostics;
- run an explicitly started manual Benchmark/smoke test;
- persist capability evidence produced by an authorized Benchmark;
- run background measurement only under valid Measurement Authority;
- collect ephemeral runtime performance only under valid runtime-observation authority;
- inspect breaker health without mutating breaker state.

It may not:

- change the real v1 backend order/result;
- infer background measurement permission from Auto;
- infer Auto execution permission from Benchmark/background settings;
- persist user-specific runtime/outcome learning without a new explicit authority contract.

## 12. Acceptance rule

Every v2 side effect must answer:

> **Where did the user authorize this, and what exactly was the scope of that authorization?**

If the answer is a default, a heuristic, an inferred preference, a capability gap, an implementation convenience, or another unrelated permission, the action is not authorized.

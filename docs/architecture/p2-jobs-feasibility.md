# P2-F — `ctx.jobs` Feasibility Spike

Status: **NO-GO: retain current scheduler**

Reviewed against:

- DeepSeek Harness `main` at `cd5ef8148158c3a752a658978873241fdf8e2bbc` (`dsh@0.1.2-alpha.1` release merge, 2026-08-27).
- Official Jobs subsystem contract: `docs/subsystems/jobs.md` at the same commit.
- Vision Router `createBackgroundCapabilityProfiler()` and its current regression suites.

This is a feasibility result, not a rejection of `ctx.jobs` as a Host feature. Jobs is the correct generic long-running-work registry when its ownership model matches the producer. The question here is narrower: **would replacing Vision Router's background capability scheduler with `ctx.jobs` reduce custom lifecycle code without weakening routing authority, priority, or restart semantics?** The answer is no on the current Host contract.

## Host contract observed

The current DSH Jobs contract provides:

- atomic registration and lifecycle state;
- optional exact `Agent` ownership with session-fenced access;
- unowned jobs when no owner is supplied;
- cancellation, bounded wait, output/status reads and completion listeners;
- owner disposal and service disposal cancellation/await semantics;
- an attached-controller admission fence: `start()` refuses work when no attached job controller serves the selected owner;
- one registry across process compositions, with visibility/delivery determined by the registering context and owner.

It does **not** define a producer-independent priority scheduler. In particular, the Jobs contract has no native concept of:

```text
foreground visual work
  > manual capability benchmark
  > unattended background benchmark
```

Nor does it know Vision Router's live measurement authority, endpoint identity/fingerprint, local-free eligibility, topology revision, or publish fence.

## Ten required checks

| # | Requirement | Current scheduler | `ctx.jobs` as replacement | Result |
|---|---|---|---|---|
| 1 | profile-wide job ownership | Profiler is installed once on the plugin composition/capability store and is not session-owned. | An **unowned** Job can be profile/process-visible, but an owned Job is tied to an exact Agent and requires a serving controller. Choosing unowned preserves profile scope but gains no useful owner lifecycle over the current profiler. | **No migration benefit** |
| 2 | Web settings page close must not stop work | Background profiler lives in the plugin fiber; the Web route is only a status/control projection. Closing the page does not own the profiler. | Possible only if the Job registration/controller is kept outside the page/client scope. This adds composition/controller placement constraints rather than removing them. | **Current is simpler** |
| 3 | plugin dispose immediately terminates work | `installBackgroundCapabilityProfiling()` registers an effect disposer that unregisters listeners and calls `profiler.stop()`, which aborts current work. | Jobs service/owner disposal can cancel and await compliant producers. | **Jobs capable, no decisive gain** |
| 4 | `all → off` immediately aborts | Policy polling and `settingsChanged()` revoke authorization and abort the active controller; yielded work does not receive provider backoff. | Jobs can carry a `cancel()` hook, but it does not observe Vision Router settings or infer authority revoke. We would retain the same settings watcher/policy logic to call it. | **No lifecycle reduction** |
| 5 | `all → local-free` narrows correctly | `workStillAuthorized()` re-evaluates live authority and candidate eligibility; paid work aborts while eligible local work may continue. | Jobs has no backend/authority semantics. The same Vision Router eligibility code must remain outside the registry. | **No lifecycle reduction** |
| 6 | manual Benchmark preempts background | `manualStart()` increments a lease, aborts current background work, and blocks new background ticks until all manual work releases. | Jobs has no cross-kind priority/preemption contract. We would have to rebuild the same arbitration above Jobs. | **FAIL as replacement** |
| 7 | foreground visual work has highest priority | `foregroundStart()` immediately aborts background work and resets the idle window; foreground tool wrappers bracket activity. | Jobs has no producer-independent priority/preemption contract. | **FAIL as replacement** |
| 8 | headless behavior | Scheduler depends on settings/core/store/timers, not on a browser page or Agent owner. | An unowned Job can be headless, but an owned Job adds owner/controller admission requirements. Using unowned Jobs again removes the principal ownership benefit. | **Current is simpler / fewer assumptions** |
| 9 | process restart semantics | Work itself is intentionally not resumed. On restart the scheduler reconstructs from persisted measured evidence, image verdicts and bounded background-stop records, then chooses fresh work. | Current JobRegistry is a process-local lifecycle registry; the documented contract does not provide durable replay/resume of producer work. We would still need Vision Router's persisted evidence/stop semantics. | **No migration benefit** |
| 10 | background stop/evidence publish fencing | Before `store.put`, `assertBackgroundPublishable()` rechecks live authority, current candidate existence, benchmarkability, endpoint fingerprint and current background eligibility. Persistent stops are separately bounded and credential-aware. | Jobs settlement records generic lifecycle state; it does not validate model identity, fingerprint, routing authority, or evidence publication. The full fence must remain. | **FAIL as simplification** |

## GO criteria evaluation

The implementation plan allows migration only if Jobs satisfies all of these architecture outcomes.

| GO criterion | Evaluation |
|---|---|
| Reduce custom lifecycle code | **FAIL.** Priority, settings/topology invalidation, eligibility and publish fencing all remain; Jobs adds registration/controller placement. |
| Do not weaken authority revoke | Achievable only by retaining the current revoke logic around Jobs; therefore no simplification. |
| Preserve priority | **FAIL natively.** Current DSH Jobs has no foreground/manual/background priority contract. |
| Preserve Web-close continuation | Achievable only with careful unowned/profile-scoped registration, which adds scope assumptions. |
| Do not add session-owner assumptions | **FAIL for owned Jobs;** unowned Jobs avoid the assumption but also discard the ownership benefit. |

## Decision

```text
NO-GO: retain current scheduler
```

This is a successful P2-F outcome under the implementation plan.

The current `createBackgroundCapabilityProfiler()` remains production authority for unattended benchmark scheduling. `ctx.jobs` should be reconsidered only if a future Host contract adds a generic priority/resource scheduler or a profile-scoped owner/controller seam that demonstrably eliminates Vision Router's custom arbitration rather than wrapping it.

## Evidence / regression coverage

Current repository tests already exercise the semantics that a migration would have to preserve:

- `tests/vision-background-benchmark.test.js`
  - foreground abort/preemption;
  - manual benchmark lease/preemption;
  - `all → off` revoke;
  - `all → local-free` narrowing;
  - topology-change abort;
  - local-free eligibility.
- `tests/vision-background-lifecycle.test.js`
  - bounded persistent-stop lifetime;
  - credential-rotation release;
  - failure-lifetime separation.
- `lib/vision-background-benchmark.js`
  - plugin effect disposal;
  - headless timer ownership;
  - pre-publish live authority / candidate / fingerprint fence.

Official DSH reference used for the spike:

- `https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/jobs.md`

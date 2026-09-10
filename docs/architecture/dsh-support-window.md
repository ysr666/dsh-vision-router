# DSH Host support window

Status: normative for the current DVR 2.x compatibility program.

## Public support policy

The public support policy contains only released Host semantics. Preview/canary versions are intentionally excluded from this table.

| Role | DSH train | Meaning |
|---|---|---|
| Minimum Supported Host | `0.1.0-rc.8` | Oldest Host generation that DVR 2.1.x publicly supports. |
| Current Stable Host | `0.1.5-rc.1` | Current npm stable-channel release covered by required exact Host and browser evidence. |

DVR `2.1.x` therefore keeps `0.1.0-rc.8` as its public floor and supports released Host trains through the current stable channel. Runtime branching remains capability-based rather than version-string-driven.

No later support-floor increase is currently announced.

## Verification evidence — not support policy

Compatibility evidence answers a different question: what exact upstream releases and moving channels have current CI proof? It must never be interpreted as a public support-floor change.

| Evidence role | DSH source | Meaning |
|---|---|---|
| Exact stable evidence | `0.1.5-rc.1` | Required Host/wire and real Host + Chromium coverage for the current stable release. |
| Exact preview evidence | `0.1.5-alpha.2` | Required preview Host/wire/lifecycle/browser evidence. This is not a preview support promise. |
| Stable drift canary | npm dist-tag `latest` | Scheduled, dynamically resolved surveillance. A failure starts compatibility investigation; it does not rewrite support policy. |
| Preview drift canary | npm dist-tag `alpha` | Scheduled, dynamically resolved surveillance with preview-specific lifecycle coverage. A failure does not rewrite support policy. |

The exact evidence values may move in a patch-level maintenance PR when CI proof advances. The public minimum may move only under the support-floor protocol below.

Historical release notes under `docs/releases/` are release-time snapshots and are not rewritten when later evidence advances.


The optional peer-dependency range may admit an exact preview version so CI/users can install a verified preview Host without peer-resolution noise. That install admission is compatibility evidence, not a public preview support promise.

## Floor transition from DVR 2.0.x

DVR 2.0.x was released with DSH `0.1.0-rc.6` as its minimum Host. The 2.1.0 boundary was announced in advance and raised the public minimum to DSH `0.1.0-rc.8`.

```text
DVR 2.0.x minimum: DSH 0.1.0-rc.6
DVR 2.1.x minimum: DSH 0.1.0-rc.8
```

Users still on rc.6/rc.7 should upgrade DSH before upgrading to DVR 2.1.x.

This support-floor transition does **not** require deleting every rc.6-era compatibility seam in the same release. Compatibility code is retired only after a separate proof shows it is unreachable or unnecessary on every supported Host and durable-history path.

## Support-policy change protocol

A public Host support-floor change is valid only when all of the following are true:

1. the floor change is announced in a DVR minor or major release, never only in a patch release;
2. README / support documentation and release notes state the old and new floors;
3. Doctor reports the effective public support policy and gives a capability-based upgrade result for Hosts below the active floor;
4. required CI proves the public floor and current stable Host, while preview and dynamic canaries remain separately labelled verification evidence;
5. compatibility seams are removed only after the new minimum Host proves the replacement capability;
6. removal PRs keep restart, settings, native-image coexistence, tool execution, Node 22/24 and supported-platform regressions green.

Advancing an exact stable/preview evidence version or a moving canary target does **not** by itself change the public support floor.

## Capability-first rule

Version labels describe support policy and CI evidence; runtime branching still uses capabilities.

DVR must not turn these tables into widespread version-string conditionals. Runtime compatibility continues to feature-detect the concrete Host seam it needs. If a capability cannot be proven safely, the compatibility path fails open or reports an explicit unsupported/unknown state according to that seam's contract.

## Compatibility-retirement rule

The 2.1.x floor makes rc.6-only compatibility candidates eligible for a fresh deletion audit, but does not automatically authorize deletion. Durable session formats, replay envelopes, adapter wire shapes, and other historical inputs may outlive the Host version that originally produced them.

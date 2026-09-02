# DSH Host support window

Status: normative for the DVR 2.x compatibility program.

## Current DVR 2.1.x window

| Role | DSH train | Meaning |
|---|---|---|
| Minimum Supported Host | `0.1.0-rc.8` | Oldest Host generation that DVR 2.1.x publicly supports. |
| Previous Supported Train | `0.1.1-rc.1` | Previous released Host train kept in the compatibility matrix. |
| Current Supported Train | `0.1.1-rc.2` | Current released train used by the required current-contract gate. |
| Canary only | `0.1.2-alpha.4` | Latest upstream prerelease evidence at v2.1.0 release preparation time. It is not a released support-floor claim and does not authorize compat deletion by itself. |

DVR `2.1.x` therefore supports DSH `0.1.0-rc.8` and newer released trains covered by the published matrix. Runtime branching remains capability-based rather than version-string-driven.

## Floor transition from DVR 2.0.x

DVR 2.0.x was released with DSH `0.1.0-rc.6` as its minimum Host. The 2.1.0 boundary was announced in advance and raises the public minimum to DSH `0.1.0-rc.8`.

```text
DVR 2.0.x minimum: DSH 0.1.0-rc.6
DVR 2.1.x minimum: DSH 0.1.0-rc.8
```

Users still on rc.6/rc.7 should upgrade DSH before upgrading to DVR 2.1.x.

This support-floor transition does **not** require deleting every rc.6-era compatibility seam in the same release. Compatibility code is retired only after a separate proof shows it is unreachable or unnecessary on every supported Host and durable-history path.

No later support-floor increase is currently announced.

## Support-window change protocol

A Host support-floor change is valid only when all of the following are true:

1. the change is announced in a DVR minor or major release, never only in a patch release;
2. README / support documentation and release notes state the old and new floors;
3. Doctor reports the effective support window and gives a capability-based upgrade result for Hosts below the active floor;
4. required CI has stable minimum, previous, current, and canary evidence for the declared window;
5. compatibility seams are removed only after the new minimum Host proves the replacement capability;
6. removal PRs keep restart, settings, native-image coexistence, tool execution, Node 22/24 and supported-platform regressions green.

## Capability-first rule

Version labels describe the public support window; runtime branching still uses capabilities.

DVR must not turn this table into widespread version-string conditionals. Runtime compatibility continues to feature-detect the concrete Host seam it needs. If a capability cannot be proven safely, the compatibility path fails open or reports an explicit unsupported/unknown state according to that seam's contract.

## Compatibility-retirement rule

The 2.1.x floor makes rc.6-only compatibility candidates eligible for a fresh deletion audit, but does not automatically authorize deletion. Durable session formats, replay envelopes, adapter wire shapes, and other historical inputs may outlive the Host version that originally produced them.

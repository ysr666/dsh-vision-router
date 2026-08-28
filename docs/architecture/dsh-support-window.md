# DSH Host support window

Status: normative for the DVR 2.x compatibility program.

## Current DVR 2.0.x window

| Role | DSH train | Meaning |
|---|---|---|
| Minimum Supported Host | `0.1.0-rc.6` | Oldest Host generation that DVR 2.0.x must continue to boot and preserve its documented product behavior on. |
| Previous Supported Train | `0.1.0-rc.8` | Legacy train kept in the compatibility matrix because it contains the attachment/settings transition that many existing profiles still use. |
| Current Supported Train | `0.1.1-rc.2` | Current released train used by the required current-contract gate. |
| Canary only | `0.1.2-alpha.1` | Upstream development/release-candidate evidence only. It is not a released support-floor claim and does not authorize compat deletion. |

DVR `2.0.x` therefore continues to support DSH `0.1.0-rc.6` through the end of the 2.0 patch train.

## Announced next floor

The next compatibility-floor change is reserved for **DVR 2.1.0 or a later minor/major release**:

```text
DVR 2.0.x minimum: DSH 0.1.0-rc.6
DVR 2.1.0 minimum: DSH 0.1.0-rc.8
```

A DVR patch release must never silently raise the minimum Host.

When the 2.1.0 boundary is actually released, release notes and Doctor output must repeat the new floor. Until then, rc.6 remains supported and rc.6-only compatibility seams remain eligible production code.

## Support-window change protocol

A Host support-floor change is valid only when all of the following are true:

1. the change is announced in a DVR minor or major release, never only in a patch release;
2. README / support documentation and release notes state the old and new floors;
3. Doctor reports the effective support window and gives a capability-based upgrade recommendation before a user crosses the new floor;
4. required CI has a stable `minimum`, `previous`, and `current` contract definition for the new window;
5. compatibility seams are removed only after the new minimum Host proves the replacement capability;
6. removal PRs keep restart, settings, native-image coexistence, tool execution, Node 22/24 and supported-platform regressions green.

## Capability-first rule

Version labels describe the public support window; runtime branching still uses capabilities.

DVR must not turn this table into widespread version-string conditionals. Runtime compatibility continues to feature-detect the concrete Host seam it needs. If a capability cannot be proven safely, the compatibility path fails open or remains installed according to that seam's existing contract.

## Why rc.6 is not removed inside 2.0.x

DVR 2.0.1 has already been released with rc.6 in its declared/validated support range. Raising the floor in a later 2.0.x patch would turn an ordinary patch upgrade into an undeclared Host-breaking change.

The architecture program therefore separates two decisions:

- **P3-A:** announce when the floor may move;
- **P3-B:** delete a seam only after that new floor is in force and the minimum Host supplies the replacement capability.

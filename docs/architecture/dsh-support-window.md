# DSH Host support window

Status: normative for the current DVR 2.x compatibility program.

## Public support policy

The public support policy contains only released Host semantics. Preview/canary versions are intentionally excluded from this table.

| Role | DSH train | Meaning |
|---|---|---|
| DVR train | Minimum Supported Host | Current Stable Host | Ordinary development Host |
|---|---|---|---|
| `2.2.x` | `0.1.0-rc.8` | `0.1.5-rc.3` | historical 2.2 development baseline |
| `2.3.x` | **`0.1.5-rc.3`** | `0.1.5-rc.3` | **exact `0.2.0-rc.2`** |

DVR `2.2.x` keeps `0.1.0-rc.8` as its historical public floor.

DVR `2.3.0` deliberately raises the public minimum to **DSH `0.1.5-rc.3`**. All DSH Hosts older than `0.1.5-rc.3`, including the complete `0.1.0-rc.6/rc.7/rc.8` line and intermediate pre-stable 0.1.x trains previously admitted by older DVR releases, are outside the DVR 2.3 supported Host matrix.

Ordinary DVR 2.3 development is pinned to **exact DSH `0.2.0-rc.2`** so `pnpm install && pnpm test` exercises the latest fully verified Host/Desktop generation rather than an obsolete compatibility floor. This exact development pin is evidence policy, not a reason to turn runtime behavior into version-string checks.

Runtime branching remains capability-based rather than version-string-driven.

### DSH 0.2.x forward admission

DVR 2.2.x peer-admits the DSH `0.2.x` train from the verified rc.1 boundary (`>=0.2.0-rc.1 <0.3.0-0`) without raising its historical `0.1.0-rc.8` minimum Host floor.

DVR 2.3 retains forward admission of the `0.2.x` train but uses exact `0.2.0-rc.2` as its ordinary development Host while keeping the public minimum at `0.1.5-rc.3`. Initial forward admission was backed by public pre-0.2.0 master `21638c56315ae6a2b552d6091945d3144c9af32e`. Exact release evidence has now advanced to immutable `dsh-v0.2.0-rc.2` commit `639ed015397290b3745d163aafe02ffee4aa3f84`, published on 2026-09-29. Required gates cover three-OS source contracts, real Host + Chromium, Settings mount/save/reload/readback, mixed attachments, bundle recomposition, Windows Node 22/24 Desktop authentication, the Node 24 multi-plugin isolation adversary, and Host-owned Sharp resolution.

The final immutable upstream `0.2.0` stable tag and signed official Desktop installer remain release-time revalidation targets. The rc.1 evidence is next-channel verification, not a preview support promise and not a support-floor increase.

## Verification evidence — not support policy

Compatibility evidence answers a different question: what exact upstream releases and moving channels have current CI proof? It must never be interpreted as a public support-floor change.

| Evidence role | DSH source | Meaning |
|---|---|---|
| Exact stable evidence | `0.1.5-rc.3` | Required Host/wire and real Host + Chromium coverage for the current stable release. |
| Exact next/rc evidence | `0.2.0-rc.2` (`next/rc`) | Required Host/wire/lifecycle/browser evidence. This is not a preview support promise. |
| Stable drift canary | npm dist-tag `latest` | Scheduled, dynamically resolved surveillance. A failure starts compatibility investigation; it does not rewrite support policy. |
| Next/rc drift canary | npm dist-tag `next` | Scheduled, dynamically resolved surveillance for the rc channel. A failure does not rewrite support policy. |
| Alpha/pre-release drift canary | npm dist-tag `alpha` | Scheduled, dynamically resolved surveillance for the alpha channel. A failure does not rewrite support policy. |

The exact evidence values may move in a patch-level maintenance PR when CI proof advances. The public minimum may move only under the support-floor protocol below.

Historical release notes under `docs/releases/` are release-time snapshots and are not rewritten when later evidence advances.

The optional peer-dependency range may admit an exact preview version so CI/users can install a verified preview Host without peer-resolution noise. That install admission is compatibility evidence, not a public preview support promise.

## Floor transitions across DVR 2.x

DVR 2.0.x was released with DSH `0.1.0-rc.6` as its minimum Host. DVR 2.1.0 raised the public minimum to DSH `0.1.0-rc.8`; DVR 2.2.x inherited that rc.8 floor. DVR 2.3.0 raises the floor again to DSH `0.1.5-rc.3`.

```text
DVR 2.0.x minimum: DSH 0.1.0-rc.6
DVR 2.1.x minimum: DSH 0.1.0-rc.8
DVR 2.2.x minimum: DSH 0.1.0-rc.8
DVR 2.3.x minimum: DSH 0.1.5-rc.3
```

Users on any DSH release older than `0.1.5-rc.3` must upgrade DSH before upgrading to DVR 2.3.x.

The 2.3 floor increase authorizes a fresh deletion audit for Host-version compatibility whose only purpose was keeping pre-`0.1.5-rc.3` Hosts running. It does **not** authorize deleting compatibility for durable data merely because the Host that originally produced that data is no longer supported. Session logs, replay envelopes, persisted settings and other long-lived inputs require separate reachability evidence on supported Hosts.

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

The 2.3.x `0.1.5-rc.3` floor makes any compatibility path used only by pre-`0.1.5-rc.3` Hosts eligible for a fresh deletion audit, but does not automatically authorize deletion. Durable session formats, replay envelopes, adapter wire shapes, and other historical inputs may outlive the Host version that originally produced them.

See [DSH 0.2.0-rc.2 compatibility audit](dsh-020-rc2-adaptation.md) for the upstream seam review and validation plan.

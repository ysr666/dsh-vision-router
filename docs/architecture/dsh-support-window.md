# DSH Host support window

Status: normative for the current DVR 3.x compatibility program.

## Public support policy

The public support policy contains only released Host semantics. Preview/canary versions are intentionally excluded from this table.

| DVR train | Minimum Supported Host | Current Stable Host | Ordinary development Host |
|---|---|---|---|
| `2.2.x` | `0.1.0-rc.8` | `0.1.5-rc.3` | historical 2.2 development baseline |
| `2.3.x` | **DSH `0.1.5` train** | `0.1.5-rc.3` | historical 2.3 baseline |
| `3.0.x` | **DSH `0.1.5` train** | `0.1.5-rc.3` | **exact `0.2.0-rc.2`** |

DVR `2.2.x` keeps `0.1.0-rc.8` as its historical public floor.

DVR `2.3.0` deliberately resets the public minimum to the **DSH `0.1.5` train**. The earliest admitted release in that train is `0.1.5-rc.1`; current stable evidence is `0.1.5-rc.3`. DVR 2.3 no longer publishes a jagged list of `0.1.0` / `0.1.1` / `0.1.3` / `0.1.7` exceptions.

Ordinary DVR 2.3 development is pinned to **exact DSH `0.2.0-rc.2`** so `pnpm install && pnpm test` exercises the latest fully verified Host/Desktop generation rather than an obsolete compatibility floor. This exact development pin is evidence policy, not a reason to turn runtime behavior into version-string checks.

Runtime branching remains capability-based rather than version-string-driven.

### DSH 0.2.x forward admission

DVR 2.2.x peer-admits the DSH `0.2.x` train from the verified rc.1 boundary (`>=0.2.0-rc.1 <0.3.0-0`) without raising its historical `0.1.0-rc.8` minimum Host floor.

DVR 2.3 uses exact `0.2.0-rc.2` as its ordinary development Host while keeping the public minimum at the `0.1.5` train. Peer admission is intentionally train-shaped: `>=0.1.5-rc.1 <0.2.0-0` for the continuous supported 0.1.x line from 0.1.5, plus `>=0.2.0-rc.2 <0.3.0-0` for the 0.2.x train from the verified rc.2 boundary. Initial forward admission was backed by public pre-0.2.0 master `21638c56315ae6a2b552d6091945d3144c9af32e`. Exact release evidence has now advanced to immutable `dsh-v0.2.0-rc.2` commit `639ed015397290b3745d163aafe02ffee4aa3f84`, published on 2026-09-29. Required gates cover three-OS source contracts, real Host + Chromium, Settings mount/save/reload/readback, mixed attachments, bundle recomposition, Windows Node 22/24 Desktop authentication, the Node 24 multi-plugin isolation adversary, and Host-owned Sharp resolution.

The final immutable upstream `0.2.0` stable tag and signed official Desktop installer remain release-time revalidation targets. The verified `0.2.0-rc.2` boundary is already part of DVR 2.3's peer-admitted supported 0.2.x train; it does not raise the public minimum above the DSH 0.1.5 train.

## Verification evidence and drift canaries

Exact evidence answers which admitted Host points have current CI proof; moving canaries answer whether upstream has drifted beyond those points. Evidence inside an already declared train does not by itself change the minimum support floor, while peer-admission boundaries remain explicit support policy.

| Evidence role | DSH source | Meaning |
|---|---|---|
| Exact stable evidence | `0.1.5-rc.3` | Required Host/wire and real Host + Chromium coverage for the current stable release. |
| Exact supported 0.2.x boundary | `0.2.0-rc.2` (`next/rc`) | Required Host/wire/lifecycle/browser/Desktop evidence for the peer-admitted 0.2.x train; it does not raise the 0.1.5 minimum floor. |
| Stable drift canary | npm dist-tag `latest` | Scheduled, dynamically resolved surveillance. A failure starts compatibility investigation; it does not rewrite support policy. |
| Next/rc drift canary | npm dist-tag `next` | Scheduled, dynamically resolved surveillance for the rc channel. A failure does not rewrite support policy. |
| Alpha/pre-release drift canary | npm dist-tag `alpha` | Scheduled, dynamically resolved surveillance for the alpha channel. A failure does not rewrite support policy. |

Exact evidence points may advance inside an already admitted train when CI proof advances. The public minimum and any peer-admission boundary change remain explicit support-policy changes.

Historical release notes under `docs/releases/` are release-time snapshots and are not rewritten when later evidence advances.

Peer-dependency admission is itself part of the compatibility contract. DVR 2.3 deliberately admits the 0.2.x train from verified `0.2.0-rc.2`; moving npm `next`/`alpha` canaries outside that declared boundary remain surveillance only.

## Floor transitions across DVR 2.x

DVR 2.0.x was released with DSH `0.1.0-rc.6` as its minimum Host. DVR 2.1.0 raised the public minimum to DSH `0.1.0-rc.8`; DVR 2.2.x inherited that rc.8 floor. DVR 2.3.0 raises the floor again to the DSH `0.1.5` train.

```text
DVR 2.0.x minimum: DSH 0.1.0-rc.6
DVR 2.1.x minimum: DSH 0.1.0-rc.8
DVR 2.2.x minimum: DSH 0.1.0-rc.8
DVR 2.3.x minimum: DSH 0.1.5 train (earliest admitted release: 0.1.5-rc.1)
DVR 3.0.x minimum: DSH 0.1.5 train (unchanged from 2.3.x; earliest admitted release: 0.1.5-rc.1)
```

Users on DSH trains older than `0.1.5` must upgrade DSH before upgrading to DVR 2.3.x or 3.0.x.

The 2.3 floor increase authorizes a fresh deletion audit for Host-version compatibility whose only purpose was keeping pre-`0.1.5` Hosts running. It does **not** authorize deleting compatibility for durable data merely because the Host that originally produced that data is no longer supported. Session logs, replay envelopes, persisted settings and other long-lived inputs require separate reachability evidence on supported Hosts.

## Support-policy change protocol

A public Host support-floor change is valid only when all of the following are true:

1. the floor change is announced in a DVR minor or major release, never only in a patch release;
2. README / support documentation and release notes state the old and new floors;
3. Doctor reports the effective public support policy and gives a capability-based upgrade result for Hosts below the active floor;
4. required CI proves the public floor, current stable Host, and every declared forward-admission boundary, while moving canaries remain separately labelled surveillance;
5. compatibility seams are removed only after the new minimum Host proves the replacement capability;
6. removal PRs keep restart, settings, native-image coexistence, tool execution, Node 22/24 and supported-platform regressions green.

Advancing exact evidence inside an already declared train or moving a canary target does **not** by itself change the minimum support floor. Changing the peer-admitted train boundary is a support-policy change and must be explicit.

## Capability-first rule

Version labels describe support policy and CI evidence; runtime branching still uses capabilities.

DVR must not turn these tables into widespread version-string conditionals. Runtime compatibility continues to feature-detect the concrete Host seam it needs. If a capability cannot be proven safely, the compatibility path fails open or reports an explicit unsupported/unknown state according to that seam's contract.

The same rule binds the contract gate. `scripts/dsh-host-contract-smoke.mjs` derives the settings
seam from the Host it is pointed at (`EXPECT_SETTINGS_MODE=auto`): the `0.1.5` train exposes
`SettingsProvider.register()`, while the `0.1.7` release and every `0.2.x` Host since — `0.2.0-rc.2`
through the `0.2.1` alpha line — replace it with `SettingsForms.describe()` plus ConfigEditor
`configuration()`/`edit()`. A gate that pins one shape reports an unsupported Host for a Host DVR
supports, so the floating canaries derive the seam, the pinned legs keep naming theirs explicitly,
and a Host with neither reviewed seam fails the gate by name instead of passing silently.

## Compatibility-retirement rule

The 2.3.x `0.1.5` train floor makes any compatibility path used only by pre-`0.1.5` Hosts eligible for a fresh deletion audit, but does not automatically authorize deletion. Durable session formats, replay envelopes, adapter wire shapes, and other historical inputs may outlive the Host version that originally produced them.

See [DSH 0.2.0-rc.2 compatibility audit](dsh-020-rc2-adaptation.md) for the upstream seam review and validation plan.

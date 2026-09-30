# DSH compatibility matrix — DVR 2.3

This document is the normative Host-evidence matrix for dsh-vision-router 2.3.

Runtime code remains capability-based: version labels below identify immutable CI evidence only. They must not become runtime version branches.

## Support and admission policy

DVR 2.3 supports the DSH 0.1.x line continuously from the first admitted 0.1.5 release candidate and the 0.2.x line from the exact rc.2 boundary that is exercised by the current Desktop/Host gates:

```text
>=0.1.5-rc.1 <0.2.0-0
||
>=0.2.0-rc.2 <0.3.0-0
```

Ordinary DVR development is pinned to exact `0.2.0-rc.2`. Hosts below the 0.1.5 train are not part of the DVR 2.3 support contract.

The `0.1.5-alpha.2` browser fixture may remain as historical drift surveillance. It is deliberately outside peer admission, outside the normative exact-source matrix, and must never be described as DVR 2.3 support evidence.

## Gating evidence

| Evidence | DSH version | Role |
| --- | --- | --- |
| `minimum-contract` | `0.1.5-rc.1` | Public 2.3 minimum. Packed-plugin install, public entry, Settings persistence, batch attachment, SessionQuery and core Host contracts. |
| `current-contract` | `0.1.5-rc.3` | Current stable 0.1.5 Host evidence. |
| exact-source matrix | `0.1.5-rc.1`, `0.1.5-rc.3`, `0.1.7-rc.2` on Ubuntu/macOS/Windows | Proves the continuous supported 0.1.x line at the floor, current stable point and a later mid-train point. |
| `2.3 Critical Architecture Gate` / rc.2 reusable workflow | `0.2.0-rc.2` | Default development/next boundary: exact source on three OSes, real Host + Chromium, Windows Desktop Node 22/24 and macOS Desktop lifecycle. |
| preview browser historical canary | `0.1.5-alpha.2` | Non-support surveillance only; catches browser drift in an older immutable Host. |
| upstream Web overlay watch | moving DSH `master` | Retirement/drift sentinel only. It never changes the public support window by itself. |

Node 22 and Node 24 remain the general runtime matrix. Minimum/current Host jobs and exact-source/Desktop evidence are additive.

## Current capability evidence

| Capability / boundary | 2.3 verdict | Evidence / detection |
| --- | --- | --- |
| Batch attachment ownership | native on every supported Host | `attachments.saveImages`; minimum/current Host contracts; immutable 0.1.5/0.1.7/0.2 source evidence. The pre-floor Android single-attachment fallback was retired in R2.3. |
| Official DeepSeek provider ownership | Host-owned throughout the supported window | DVR no longer reconstructs `deepseek-official`; `protectHostProviderOwnership()` prevents synthetic takeover. |
| Settings persistence | native, but lifecycle shape changes across the supported window | minimum Host real Settings persistence plus current/rc.2 browser contracts. `installHostSettingsCompatibility()` remains the narrow runtime bridge. |
| Session event/log reads | native minimum/current contract | `SessionQuery.readEvent/readSession/observeSession` capability probes; bounded Session recovery remains capability-based. |
| DVR duck-typed adapter contract | DVR normalization still required | `ensureAdapterContracts()` supplies missing Host base-class defaults such as `prepareCall` / `imageRequestPricing` to DVR-owned plain adapters only. |
| Client module loader lifecycle | supported Hosts still replace live `load` during `create()` | immutable 0.1.5-rc.1 through 0.2.0-rc.2 source review. The current Settings client lifecycle bridge therefore remains reachable. |
| modules -> webServer overlay | `shim-required` | exact supported/rc source contracts plus moving upstream watch. |
| connection -> webServer overlay | `shim-required` | exact supported/rc source contracts plus moving upstream watch. |
| Router-specific proxy override | product compatibility | explicit `proxy` / `proxyHosts` remain supported; Host-first default egress stays authoritative. |
| OpenCode Go session wire projection | Host gap remains | current pi-ai transports generic `sessionId`, but upstream does not yet emit the required `x-opencode-session` carrier. |

## R2.3 retirement result

The support-floor reset produced real removals rather than a cosmetic reclassification:

- retired the pre-floor no-batch Android attachment fallback;
- retired legacy DeepSeek provider reconstruction/keep-alive takeover;
- retired rc.7-labelled public compatibility aliases in favor of capability-named APIs;
- removed pre-floor `0.1.5-alpha.2` from the normative exact-source support matrix.

The remaining compatibility seams are retained only for one of four reasons:

1. a capability/lifecycle difference still exists on a supported 0.1.5+/0.2 Host;
2. supported Hosts can still consume durable data/profile state produced by older DVR/Host generations;
3. the behavior is an intentional current product compatibility contract;
4. the behavior closes a runtime/platform gap rather than a Host-version gap.

Detailed owners and removal conditions live in `compat-inventory.md`.

## Rules

1. Runtime behavior branches on capabilities, not DSH version strings.
2. A pre-floor Host may be kept as an explicitly labelled non-support drift canary, but it may not be a required support fixture or broaden peer admission.
3. Durable historical data compatibility is independent of Host support: old Session/settings/replay state is retained when a supported Host can still load it.
4. A compatibility seam is removed only when its current-Host/product/durable-data/platform removal condition is proven.
5. Moving upstream/canary evidence may reveal drift but never silently redefine the public support policy.

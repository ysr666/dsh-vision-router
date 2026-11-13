# DVR 3.2 DSH Host support window

**Status: DVR 3.2.x support policy; this document is not a release or npm publication assertion.** The previous DVR 3.1.x support policy remains available in [historical support window](dsh-support-window-3.1-historical.md).

| Policy | DVR 3.2 candidate |
|---|---|
| Minimum DSH Host | 0.2.1-rc.5 |
| Current recommended Host | 0.2.2-rc.1 (an RC, not a stable release) |
| DSH range | >=0.2.1-rc.5 <0.3.0-0 |
| Minimum Node.js | 24.9.0 |
| Retired | DSH 0.1.x, 0.2.0, 0.2.1-rc.4 or earlier; Node 22 |

The prior DVR 3.1.4 release retains its historic support contract. The new support floor is a breaking compatibility-policy change, never a silent patch update.

The published `engines.dsh` train allows later 0.2.x releases, including
prereleases, as a compatibility *admission policy*; it cannot guarantee their
runtime behavior. Doctor distinguishes **admitted**, **exact-release verified** and **recommended** Hosts.
The exact-source/real-Host gates have verified `0.2.1-rc.5`, `0.2.2-rc.1`,
`0.2.2-rc.2` and `0.2.2-rc.3` on the exercised Node 24 matrix. The conservative
**recommended** Host remains `0.2.2-rc.1`: verification of a newer prerelease
is not, by itself, a recommendation to upgrade. Future/unpinned 0.2.x Hosts
and Node 25+ are marked `unknown`, not `ok`, until separately validated. This does not rewrite the Host admission range
or block a user whose separately reviewed deployment works.

The active compatibility CI is organized by responsibility: the **minimum Host**
(`0.2.1-rc.5`), the **recommended Host** (`0.2.2-rc.1`) and the **latest
qualified RC** (`0.2.2-rc.3`) retain normal automated gates. The RC2 full
matrix is preserved for explicit `workflow_dispatch` replay, with its prior
immutable verification recorded; it no longer duplicates every PR/main run.
This is a CI scheduling policy, not a withdrawal of RC2 compatibility evidence.
When the recommendation or latest RC advances, move the active lane instead
of permanently adding another full automatic historical matrix.

## Core Host ownership

The verified DSH 0.2.1-rc.5 and DSH 0.2.2 release candidates own webStartup trustedHosts and all Connection authorization. DVR 3.2 retires the cross-generation Connection config override and private readiness provider. However, a real Windows six-order foreign-plugin test caught HTTP 405 from generic connection.rpc.handle() when the Connection provider Fiber omitted a webServer injection. Thus DVR retains one **minimal ordering-only patch**: Connection inject: [webStartup, webServer], with **no config/trustedHosts override**. DSH still exclusively owns cookies, /api, WebSocket, trust authority and all other Connection config. Never extend, guess or bypass the official trust list.

Keep the independent modules/webServer activation dependency and DVR disabled:false recompose guard until each replacement is independently proven; their root causes are not fixed merely by raising the Host floor.

DSH 0.2.1-rc.5+ uses `engines.dsh` as its sole native plugin-admission authority. **DSH 0.2.0-rc.2 still ignores engines.dsh** and only inspects DSH peers, so DVR retains exactly one optional `@deepseek-ai/dsh-llm-deepseek` peer with the same minimum as a defensive *old-Host rejection guard*. DVR retires the redundant anonymous-user-id and storage-domain peers, which can produce strict pnpm conflicts; no actual Host runtime service or type-only import is removed. The `sharp` optional peer remains.

## Acceptance and safety

The initial unmodified Windows DSH 0.2.2-rc.1 Electron experiment on DVR 3.1.3 verified native Connection after disabling the bundle, preserving token 303, unauthenticated 401 and core-probe 200. One transient /connect timeout was observed. The initial zero-Connection-overrides design was later found to return HTTP 405 for third-party RPC endpoints
despite passing DVR's own Vision end-to-end tests. On Windows 0.2.2-rc.1, reproducing with identical
multi-plugin fixtures proved HTTP 405 before the minimal ordering patch and HTTP 200 after it for
all six plugin load orders. These observations are not proof of all cross-platform requirements.
The minimal patch must preserve the exact Host-owned trustedHosts config in both supported versions.

The new release requires both exact Host boundaries, Node 24.9 and newer 24 LTS, three OSes, cold/reenable/restart, authenticated and unauthenticated transport, trusted/untrusted LAN checks, real image-tool E2E, Settings persistence and historical-data readback.

Old profile-owned Connection overrides may still exist after package upgrade because profile patches take precedence; Doctor should identify them without rewriting user files. Historical session formats, replay envelopes, attachment pixels and settings migrations remain supported independently of which Host produced them.

[Retirement execution and rollback](dvr32-host-retirement.md).

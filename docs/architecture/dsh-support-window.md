# DVR 3.2 DSH Host support window

**Status: 3.2.0-rc.0 development branch; NOT released.** The previous DVR 3.1.x support policy remains available in [historical support window](dsh-support-window-3.1-historical.md).

| Policy | DVR 3.2 candidate |
|---|---|
| Minimum DSH Host | 0.2.1-rc.5 |
| Current recommended Host | 0.2.2-rc.1 (an RC, not a stable release) |
| DSH range | >=0.2.1-rc.5 <0.3.0-0 |
| Minimum Node.js | 24.9.0 |
| Retired | DSH 0.1.x, 0.2.0, 0.2.1-rc.4 or earlier; Node 22 |

The prior DVR 3.1.4 release retains its historic support contract. The new support floor is a breaking compatibility-policy change, never a silent patch update.

## Core Host ownership

Both DSH 0.2.1-rc.5 and DSH 0.2.2-rc.1 own webStartup trustedHosts and all Connection authorization. DVR 3.2 retires the cross-generation Connection config override and private readiness provider. However, a real Windows six-order foreign-plugin test caught HTTP 405 from generic connection.rpc.handle() when the Connection provider Fiber omitted a webServer injection. Thus DVR retains one **minimal ordering-only patch**: Connection inject: [webStartup, webServer], with **no config/trustedHosts override**. DSH still exclusively owns cookies, /api, WebSocket, trust authority and all other Connection config. Never extend, guess or bypass the official trust list.

Keep the independent modules/webServer activation dependency and DVR disabled:false recompose guard until each replacement is independently proven; their root causes are not fixed merely by raising the Host floor.

## Acceptance and safety

The initial unmodified Windows DSH 0.2.2-rc.1 Electron experiment on DVR 3.1.3 verified native Connection after disabling the bundle, preserving token 303, unauthenticated 401 and core-probe 200. One transient /connect timeout was observed. The initial zero-Connection-overrides design was later found to return HTTP 405 for third-party RPC endpoints
despite passing DVR's own Vision end-to-end tests. On Windows 0.2.2-rc.1, reproducing with identical
multi-plugin fixtures proved HTTP 405 before the minimal ordering patch and HTTP 200 after it for
all six plugin load orders. These observations are not proof of all cross-platform requirements.
The minimal patch must preserve the exact Host-owned trustedHosts config in both supported versions.

The new release requires both exact Host boundaries, Node 24.9 and newer 24 LTS, three OSes, cold/reenable/restart, authenticated and unauthenticated transport, trusted/untrusted LAN checks, real image-tool E2E, Settings persistence and historical-data readback.

Old profile-owned Connection overrides may still exist after package upgrade because profile patches take precedence; Doctor should identify them without rewriting user files. Historical session formats, replay envelopes, attachment pixels and settings migrations remain supported independently of which Host produced them.

[Retirement execution and rollback](dvr32-host-retirement.md).

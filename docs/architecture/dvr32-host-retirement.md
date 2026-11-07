# DVR 3.2 Host retirement and rollback

**Branch:** feat/dvr32-retire-legacy-host. **Not merged, not released.** Scope: DSH >=0.2.1-rc.5 <0.3.0-0; Node >=24.9.0.

1. Remove only DVR's core Connection patch and the private web-connection-ready plugin; do not change official Host authentication or add trusted authorities.
2. Preserve modules/webServer ordering, the DVR disabled:false recompose guard and old user-data migrators until separately proven obsolete.
3. Change engines.dsh, all DSH peer ranges, engines.node, development fixture pins, Doctor and release notes together.
4. Negative admission must reject DSH 0.1.x, DSH 0.2.0, DSH 0.2.1-rc.4, Node 22 and Node 24.8.
5. Require real DSH 0.2.1-rc.5 and 0.2.2-rc.1 installs: cold start, three enable-disable-reenable cycles, reconnection, 303/401/200, authenticated/unauthenticated API, WebSocket, trusted/untrusted LAN, actual Vision image turn and Settings/restart readback.
6. Windows, macOS and Linux exact-source gates plus build, typecheck, reproducible pack and migration tests must be green.
7. Retired Host workflows become historical/manual checks, not mandatory 3.2 release gates. Preserve old 3.1.4 packages and the historical support document.

**Rollback:** Revert the isolated 3.2 branch. Never auto-rewrite the user's profile patches, delete sessions, or release a partial change. Review manual profile-owned Connection overlays separately before user migration.
\n## CI security pre-release hardening

The 3.2 DSH rc5 fixture introduced an unsafe transitive zod@4.4.3 (GHSA-mrhx-c7xc-m3w5). The workspace forces zod@4.6.7 across development fixtures, including DSH's transitive packages; the release manifest also consumes the patched runtime version. Recheck the entire lockfile and GitHub dependency review before publishing.

The floating DSH Alpha surveillance lane checks out an upstream commit chosen from a separately reviewed pin and runs on schedule or dispatch. It must never restore or save a shared Actions build cache that a later trusted branch could consume. All three Alpha Host job families now build in disposable job state; this costs CI time intentionally. Do not put the cache back merely to optimize the Alpha lane.

The weekly/dispatch Alpha settings workflow uses a literal reviewed immutable
SHA in all three upstream checkouts, and checks the config pin against that SHA
before fetching any upstream code. A config-only pin refresh bot cannot change
workflow execution authority; the human reviewer must explicitly update all
three static refs to the newly approved commit. A stale pin fails closed.

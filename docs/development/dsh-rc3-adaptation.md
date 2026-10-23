# DSH 0.2.1-rc.3 next-channel compatibility qualification

- **Channel:** next / RC only; not stable, and not alpha.
- **Exact upstream tag:** `dsh-v0.2.1-rc.3`.
- **Immutable upstream commit:** `1f81c047fc48fa190a683e469daa699857e9afe8`.
- **GitHub release:** 2026-10-23 15:26:39 UTC (2026-10-23 23:26:39 Asia/Shanghai).
- **Previous qualified next:** RC2 `687f282e8625c6b8d11ff58211a90524be2e4317`, covered by merged PR #724.
- **Baseline DVR:** latest `main` at branch creation (`6bce1d87bacb472b84e30b281ee573d9862d679e`).
- **Upstream compare:** https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.2...dsh-v0.2.1-rc.3

## Upstream changes and potential compatibility impact

Six upstream commits: navigation-entry customization (including More menus and pinned launcher state), navigation/preset analytics, menu and tooltip fixes, official DeepSeek API-key model listing refresh, release metadata, and release merge. The published RC3 notes explicitly call out More menus, restoration of an unsent New Session draft, and API-key adapter model list parity with account login.

| Surface | RC3 review / regression focus |
| --- | --- |
| Host / peer admission | Pin exact source and run official Host evaluator. Do not change DVR `engines.dsh`, optional peer ranges, or the historical minimum supported Host. |
| Session | New Session now reuses an eligible blank session; verify Session identity, draft/attachment ownership, cold resume and lifecycle boundaries. |
| Settings | New entry pin persistence and provider model listing must not alter DVR Settings mount, save, reload or readback. |
| Bundle | `web-app/cordis.patch.yml` adds `ui-entry-customization`; verify DVR overlay ordering and three actual recompositions. |
| Web/client | New `sidebar.panellist.actions`, `conversation.view.actions`, and guide actions plus pinned state/menus; exercise real Chromium, Vision toggle and settings UI. |
| Model/attachments | API-key official `/models` discovery changes model catalog freshness; preserve explicit image-capability checks and mixed attachment routing, not model-name assumptions. |
| Service injection | New UI plugin and model-listing services must not interfere with existing DVR client inject, Web/connection overlay, Desktop, or Host-Sharp lifecycle. |

## Qualification gates (not yet claimed passed)

The dedicated `.github/workflows/dsh-021-rc3-validation.yml` duplicates the proven RC2 matrix but pins RC3's **exact SHA** and retains RC2, alpha and stable lanes separately. It must execute on an ordinary PR, including Node 22/24, Linux/macOS/Windows exact-source and Host-Sharp, Windows Node 22/24 + macOS Desktop, real Web + Chromium cold Vision, mixed attachments, Settings mount/save/reload/readback, three bundle recomposes, source/peer/proxy contracts and existing adversarial/security regression suites.

**State:** Await final-head CI and actual Host/Chromium evidence. Any failure must be investigated and fixed at the root before merge. No Copilot review gate; no workflow_dispatch substitute; no automatic DVR release.

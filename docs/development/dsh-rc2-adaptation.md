# DeepSeek Harness 0.2.1-rc.2 next-channel compatibility qualification

- **Channel:** `next` / RC; independent of stable and alpha. Do not conflate with historical DSH `0.2.0-rc.2`.
- **Upstream immutable release commit:** `687f282e8625c6b8d11ff58211a90524be2e4317` (`dsh-v0.2.1-rc.2`).
- **Released:** 2026-10-17 08:16:33 UTC (16:16:33 China Standard Time).
- **Previous qualified next baseline:** `dsh-v0.2.1-rc.1`, `1600d8a1e140dcde43a1a0941940a0480712c011`.
- **Known upstream changes to review:** new DeepSeek-V4.1-Flash-1017 model identifier; optional DeepSeek Search/Fetch API; Web service wiring, Settings namespaces and bundle composition. New functionality does not imply DVR runtime compatibility without independent Host and browser evidence.

## Compatibility review

| Area | Primary RC2 concern | Evidence required |
| --- | --- | --- |
| Host and peer admission | Do not raise public minimum Host range (including legacy `>=0.1.5-rc.1 <0.2.0-0 \|\| >=0.2.0-rc.2 <0.3.0-0`) | Official Host peer evaluator and historical lanes |
| Session | Existing Session lifecycle, ownership, event ordering and cross-version persistence | Exact source contract, real Host and adversarial/contract regression |
| Settings | New Search/Fetch namespaces must not displace DVR Settings mount/save/reload/readback | Real DSH Web + Chromium lifecycle |
| Bundle and web/client | Search/Fetch module additions must coexist with DVR overlays and Vision slots | Three bundle recomposes, cold Vision toggle and client checks |
| Model and attachments | New Flash model label and attachment pathways must retain image handling | Host-Sharp, mixed attachments and native-image regression |
| Service injection | Search/Fetch injection must not interfere with DVR bounded overlay, webServer and Desktop injection | Host injection / multi-plugin ordering on actual RC2 |

## Acceptance conditions

Create a dedicated `dsh-021-rc2-validation.yml` workflow pinned to the exact upstream SHA. Run it on ordinary `pull_request` CI, with Node 22/24, Linux/macOS/Windows exact-source and Host-Sharp, Windows/macOS Desktop injection/renderer, real DSH Web+Chromium cold Vision, mixed attachments, Settings lifecycle, and three bundle recomposes. Reuse existing exact-source validators, extending assertions only for genuinely new RC2 seams. Preserve all stable/RC1/alpha lanes.

**Qualification state:** Pending dedicated RC2 PR CI and real Host evidence. Earlier local upstream build/tests do not qualify DVR against RC2. If the workflow or integration tests reveal failures, repair the underlying cause, commit through the normal PR workflow, and rerun CI before merging. No automatic DVR npm publication or support floor change.

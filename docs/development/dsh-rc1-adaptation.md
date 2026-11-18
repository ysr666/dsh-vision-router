# DeepSeek Harness 0.2.1-rc.1 next-channel compatibility qualification

> Historical record, not current support or CI policy. Exact historical workflow files remain in [this DVR checkout](https://github.com/ysr666/dsh-vision-router/tree/e278b7ca1f305d27b11cb987c004d0632bf43633). The retired Host versions are outside the current support floor; see the current support-window policy for live qualification.

- **Channel:** `next` / RC; not stable or alpha. The alpha.5 and historical 0.2.0-rc.2 lanes remain independent.
- **Upstream immutable tag / commit:** `dsh-v0.2.1-rc.1` / `1600d8a1e140dcde43a1a0941940a0480712c011`.
- **GitHub Release:** 2026-10-17 05:22:10 UTC (13:22:10 China time).
- **Baseline:** `dsh-v0.2.1-alpha.5` / `1517a4dbca0a2789ff1d41ba439600f8547d23fa`.
- **Source toolchain:** `pnpm@11.28.5` and Node 22.19.0 or 24.x per published upstream manifest.
- **Upstream delta:** four commits, including the 0.2.1-rc.1 release and vendor-release merges. Observed changed manifests advance the internal DSH release train and vendor libraries (Cordis 4.0.5, Schemastery 3.18.5, Cosmokit 1.8.6, etc.). Do not confuse a manifest-only change with proof that runtime composition cannot change; use real Host gates below.

## Compatibility review and contracts

| Area | RC1 risk/contract | Verification |
| --- | --- | --- |
| Host and admission | Preserve published `engines.dsh` and legacy peer support range `>=0.1.5-rc.1 <0.2.0-0 \|\| >=0.2.0-rc.2 <0.3.0-0`. New RC1 must be admissible without changing the lower bound. | Exact DSH plugin compatibility evaluator, old Host matrix |
| Session | Existing producer-owned Session v4 and event ordering; no package-version substitution for durable Session checks. | Exact source contracts, Desktop Host, adversarial regressions |
| Settings | Preserve Host-owned Settings mount, save, reload, and readback. | Real DSH Web + Chromium lifecycle |
| Bundle | Cordis/vendor version upgrades could affect injection and recompose even when DVR code is unchanged. | Three consecutive bundle recomposes, original historical validation lane unchanged |
| Web/client | Model label slot, skill-cache invalidation and terminal inventory from alpha.5 must remain present. | Exact source assertions plus live cold Vision toggle and renderer |
| Model and attachments | Preserve Host-owned Sharp canonical dimensions, native-image noninterference, clipboard/mixed image-file handling and model selection. | Windows/macOS/Linux exact-source, real Chromium mixed attachments and Vision |
| Service injection | Preserve bounded webStartup compatibility overlay, module/connection webServer seams, and Desktop injection boundaries. | Real Desktop injection, web overlay contracts, multi-plugin ordering |

## CI and evidence policy

- Dedicated `.github/workflows/dsh-021-rc1-validation.yml` runs on ordinary PR changes against the immutable upstream SHA, with the RC1 pnpm toolchain.
- Exact-source and Host-Sharp on Linux/macOS/Windows, native Windows Desktop Node 22/24, macOS Desktop, and Linux real DSH Web+Chromium are blocking evidence points.
- The existing stable 0.2.0-rc.2 and alpha.5 workflows remain intact and must not be replaced or mislabeled as RC1 coverage.
- Node 22/24 unit, package, security, adversarial, and contract regressions remain required on the PR's actual head. No workflow_dispatch substitute for PR CI.
- **Status:** creating the gate and the extra RC1 exact-source assertions is *not* a passing validation. Inspect the PR jobs and repair their actual root causes before marking the adapter qualified.
- No DVR npm package publication, GitHub release, support floor change, Host-global monkeypatch, or Copilot review requirement.

# DSH 0.2.0-rc.2 compatibility audit

- Channel: next/rc (kept distinct from stable and alpha/pre-release)
- Upstream tag: `dsh-v0.2.0-rc.2`
- Upstream commit: `639ed015397290b3745d163aafe02ffee4aa3f84`
- Published: 2026-09-29 09:21:31 UTC
- Comparison baseline: `dsh-v0.2.0-rc.1` at `4878cdabd87d4041bdaff61d04c966883b9fd07a`

## Seam review

| Area | rc.1 → rc.2 finding | DVR action |
| --- | --- | --- |
| Host / Desktop | Desktop now ships a bundled CLI entry, command installation management, login-shell environment import, and Windows console signal bridging. Existing Web profile plugin injection remains available. | Re-run exact-source on Windows/macOS/Linux plus Windows Desktop on Node 22 and 24. |
| Session | Session controller source is unchanged; its package version advances only. New timed user-question persistence is additive outside DVR's session image ownership seam. | Retain session/adversarial regressions and real Host lifecycle checks. |
| Settings | Settings controller source is unchanged. Web preset/default and Creator controls are no longer gated by Coding Tools. | Re-run Settings mount/save/reload/readback in real Chromium; no compatibility shim added. |
| bundle | Published bundle package sources are unchanged apart from versions. Desktop/Host bundles become more self-contained for CLI launch. | Re-run bundle recomposition and cache-manifest validation. |
| web/client | Model picker search, shortcut modal caching, preset Settings behavior, and long-session rendering changed. | Re-run Vision toggle, mixed attachments, Settings, and client/browser contract suites. |
| model / attachment | Attachment package sources are unchanged; model-facing work is UI/search and pi-ai/Mistral compatibility. | Re-run mixed-attachment and provider wire contracts. |
| service injection | API Remotes adds the user-question remote; Gateway adds additive `hasLiveClient()`. DVR's declared injected services and Host-owned proxy authority are unchanged. | Re-run injection, proxy-egress, multi-plugin ordering, and Host-Sharp contracts. |

## Policy

The public minimum Host remains DSH `0.1.0-rc.8`. The current stable evidence remains `0.1.5-rc.3`. The peer range remains `>=0.2.0-rc.1 <0.3.0-0`; rc.2 advances exact next/rc verification evidence and does not widen the range or turn preview evidence into a stable support claim.

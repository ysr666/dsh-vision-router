# DSH 0.2.1-alpha.1 compatibility audit

## Release identity and channel

- Upstream tag: `dsh-v0.2.1-alpha.1`
- Upstream commit: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- npm publication: `2026-10-03T04:53:22.343Z`
- GitHub release: `2026-10-03T06:42:00Z`
- Channel: `alpha` only. At publication time both `latest` and `next` remain
  `0.2.0-rc.2`.

This release is inside the already peer-admitted
`>=0.2.0-rc.2 <0.3.0-0` train. It does not move the exact supported evidence
boundary away from `0.2.0-rc.2`, and it does not raise the public DSH 0.1.x
minimum.

## Compatibility review from 0.2.0-rc.2

| Surface | Upstream change | DVR conclusion |
| --- | --- | --- |
| Host / Desktop | Desktop defaults to a system-assigned port. Boot/profile resolution and plugin package metadata were reworked. | Keep capability-based startup and authenticated Desktop tests. No version branch is needed. |
| Session | Session list generation yields between work slices and honors cancellation. Core Session event signatures and the durable v4 admission surface remain compatible. | The existing post-commit `session/event(session, event)` observer and v4 admission contracts stay valid. |
| Settings | No breaking Settings controller API change. Client Settings and Agent preset composition changed, and a Host may expose a different reachable Settings seam. | DVR already derives the seam from the installed Host and verifies mount/save/reload/readback in a real browser. |
| Bundle / HMR | Web adds Schedule rows and `publicUrl`; HMR now reloads package entry/dependency maps and removes stale mappings. | Re-run real bundle recomposition and plugin lifecycle tests; do not pin private HMR helper names. |
| Web / client | Draft preservation, plugin creation, inspector/devtools, tool preparation, layout, and document frontmatter rendering changed. | DVR's client injection remains capability/slot based. Real Chromium cold Vision, mixed attachment, and Settings tests cover the integration points. |
| Model / LLM | The LLM base adapter exposes the synchronous `imageRequestPricing()` default used by the Host. | DVR's adapter registration boundary already supplies the inherited undefined default to duck-typed adapters. |
| Attachment | Published attachment API shapes remain compatible. The alpha line retains the extended image and normalization limits. | DVR's root repair reconciles stale whole-row Cordis configs to the full Host policy and exercises the Host-owned Sharp pipeline. |
| Service injection | Public `modelCatalog`, credential update, connection rejection, WebServer route, and Cordis lifecycle seams remain present. | Structured injection and authenticated Desktop RPC stay under exact-source and real-Host tests. |

## Validation gate

`.github/workflows/dsh-alpha-settings-host-gate.yml` pins the immutable commit
above and runs:

- exact-source and Host-owned Sharp contracts on Ubuntu, macOS, and Windows;
- public 0.2.x peer admission and Host proxy ownership without changing the
  minimum support window;
- real macOS Desktop renderer lifecycle;
- Windows Desktop authentication on Node 22 and 24, plus Node 24 renderer and
  multi-plugin ordering adversaries;
- real DSH Web + Chromium cold Vision, mixed attachments, Settings
  mount/save/reload/readback, and bundle recomposition.

The floating npm alpha canaries remain surveillance. Advancement of the
ordinary development pin or exact supported evidence boundary is a separate,
reviewed decision. This audit does not authorize a DVR package release.

# DSH 0.2.2-rc.2 exact-source compatibility audit

## Immutable basis

- Host: `deepseek-ai/deepseek-harness@ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c` (`dsh-v0.2.2-rc.2`, published 2026-11-11 11:33:06 UTC).
- DVR baseline: `300ec9828d7769fabd0ae423a4b3331f6b79d462` (`3.2.0`).
- Prior RC1 Host: `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` (`dsh-v0.2.2-rc.1`).
- This audit is an acceptance candidate, **not** a compatibility certification or release.

## RC2 surface deltas and DVR risks

1. Session gained atomic batch `append([...])`. Its public `session/event(session,event)` contract remains per-event after the entire batch commits. DVR's feed-based vision index, surface repair and model-selection ownership depend on observing each event exactly once; test upstream batch acceptance/observer behavior on the exact release, then test DVR actual Host lifecycles.
2. Agent model selection still occurs before `tools.resolve` and `agent/pre-step`. Keep DVR's early inbox-based model selection and verify real image->text route recovery. Never reinstate model changes at `agent/request`.
3. Host changes include plugin startup failure handling, tool-error categories, dynamic MCP and LLM retry settings. Verify plugin mount/disposal, tool error propagation, Settings revisioned save/readback and native/Desktop route behavior instead of treating this release note as proof of parity.
4. Web/desktop overlay and Settings compatibility shims remain subject to the exact-source contract, authenticated browser lifecycle, cold image/tool activation, mixed attachments and multi-plugin ordering. Do not delete overlays without an upstream-specific red/green proof.

## Exit gates

- RC2 pin and workflow static tests; `pnpm build`, `pnpm build:check` and standard DVR tests.
- RC2 upstream Session append `append.spec.ts` (including atomic rollback, reentry and post-commit observer timing).
- Three-OS exact Host source and peer/proxy contracts on Node 24.9; no shared untrusted build caches.
- Real Chromium: cold Vision ON/OFF, mixed paste, Settings/save/reload, bundle recompose, Desktop Host wiring.
- Real macOS/Windows Desktop model route and reverse-text flow, Windows default tool-only path, multi-plugin ordering on Node 24.9/24.21.
- Follow-up triage for any failure using first failing product assertion versus infrastructure/bootstrap failure. Until all gates pass, keep the PR draft; no merge, tag or publish.

## Actual acceptance evidence

- The previous fully reviewed PR head `fa58884352a5dbc9b0a67d6672262b5e787d98d4` completed [61 checks (59 success, 2 skipped, zero failure)](https://github.com/ysr666/dsh-vision-router/pull/830/checks) and the exact [RC2 Host Gate (six jobs successful)](https://github.com/ysr666/dsh-vision-router/actions/runs/43123077322). This is **historical SHA-specific evidence**, never a waiver for a changed head.
- On actual RC2 `SessionStore`, the DVR observer/index repaired 272 guards committed in **one** atomic append, with **16** precise overflow reads, **0** whole-log reads, exactly-once surface repair, isolated attachment indices and no dirty state after a failed batch. The upstream Session 14-test batch suite also passed.
- The current-PR candidate `.tgz` was built and inspected with `verify-packed-public-api.mjs`, then actually installed through the official RC2 CLI Host, with 3 successful bundle recompositions. A source-directory install alone is not the evidence.
- Real RC2 macOS Desktop, Windows Desktop (Node 24.9 and 24.21), browser cold Vision toggling, Settings save/reload, mixed attachment handling and multi-plugin ordering passed at that SHA.
- This validates **the PR checkout after later commits**. The published immutable `v3.2.0@676c6d7a` is **not** the audited main baseline `300ec982`: main includes Settings patches #823/#828 and VTracer migration #829 after the tag. A new **advisory-only** step runs the actual published `dsh-vision-router@3.2.0` from npm with an isolated RC2 Host and probes the local Settings transport. Its outcome must be examined separately; it cannot retroactively repair npm 3.2.0 and must not be counted as candidate certification.
- Issue [#826](https://github.com/ysr666/dsh-vision-router/issues/826) concerns the **Dataelem third-party Desktop generation installer**, not the official DeepSeek Harness Desktop or CLI installer. Its upstream bug [dataelement/dsh-desktop#563](https://github.com/dataelement/dsh-desktop/issues/563) and proposed fix [#565](https://github.com/dataelement/dsh-desktop/pull/565) remain open as of 2026-11-12. We have not tested the reporter's actual installed third-party Desktop; no success claim or issue closure is authorized.

## Status

**RC2 current-checkout capability evidence: green at the prior tested head.** Any later commit must pass the full exact RC2 Host Gate again. The immutable npm 3.2.0 historical diagnostic and third-party generation installation are distinct evidence boundaries.

**No merge, release, or issue-state changes** follow automatically from this audit. A clean current-head CI matrix and an explicit owner decision remain required.


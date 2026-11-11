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

## Status

**Pending exact RC2 CI execution.** Static source inspection showed RC2 retains pre-step Agent selection and per-event post-commit Session notifications. This observation is *not* a runtime pass. The PR/CI history is the authoritative evidence record.

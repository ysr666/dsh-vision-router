# DSH 0.2.2-rc.3 immutable-source compatibility audit

## Release identity

- Official prerelease: [dsh-v0.2.2-rc.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3), published **2026-11-13 07:56:55 UTC**.
- Immutable Git tag target: `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`; RC2 predecessor `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`.
- DVR candidate baseline: `33429bd39d7302daec1ceb842f3fca145cbea96b` (v3.2.1). This document and PR do **not** authorize merge or publication.

## Audited RC2 → RC3 changes

The six upstream commits include an experimental DeepSeek website chat-export importer (new Host route, Session persistence, attachments, authenticated Web upload, client sidebar slot), Windows desktop update restart working-directory fix, CI bubblewrap archive cache changes, and version bumps. This is **not** evidence that the pre-existing DVR Session/Settings/Host contracts remain compatible.

- **Host/service injection:** the importer registers its own Remote/connection route, scoped services and bundle. Confirm it neither shadows DVR local Settings routes nor changes plugin mount/dispose ordering.
- **Session and attachment:** imported sessions and images use upstream-owned persistence. DVR must not take ownership of pending files, import archives, Session binding or attachment binaries. Verify existing event index/guard repair with the exact RC3 SessionStore and no cross-session attachment leakage.
- **Web/client:** upstream adds `sidebar.session.action` HOC and a third directory-picker flow slot. Verify DVR's composer Vision ON/OFF, sidebar and Settings injection do not interfere with those owners. Imported Session continuation is an upstream feature, not a DVR-owned migration.
- **Desktop/OS:** Windows installer restart-status fix changes the child process working directory. Run Windows 24.9/24.21 and macOS Desktop smoke; do not extrapolate from the Windows installer fix to runtime correctness.
- **Security:** do not inherit upstream CI caches or run untrusted fork code; all DSH source checkouts are pinned to the tag target, read-only and credential-free.

## Candidate verification

The separate `dsh-022-rc3-host-gate.yml` runs normal `pull_request` CI (not `workflow_dispatch`) with immutable RC3 source on Linux/macOS/Windows, Node 24.9/24.21, source/host-sharp contracts, upstream Session batch tests, DVR event/attachment integration, Agent selection order, peer admission, proxy egress, real Chromium cold Vision/mixed attachments/Settings save-reload-readback, bundle recomposition, packed candidate CLI installation, Desktop Host injection and multi-plugin ordering. The legacy Host floor lanes remain independent; RC3 requires Node >=24.9, and DVR 3.2 does not advertise Node 22 support.

Historical published npm `dsh-vision-router@3.2.1` is a separate **advisory-only** diagnostic. The historical package allowlist was amended to admit immutable 3.2.1; an early harness failure must never be misreported as a tested incompatibility. A successful candidate tarball install does not certify third-party Desktop generation installation, and no source CI result can rewrite a published artifact.

**Status: the initial RC3 head `5b994d6` passed all six exact-Host jobs; each later PR head must pass its own normal CI before final acceptance.** Do not call RC3 compatible until the real Host, Desktop, Chromium, adversarial and contract jobs pass. Investigate first failing product assertions before considering a code fix. No release or merge is authorized.

## Maintainable qualification policy

Normal CI retains the supported minimum Host, conservative recommended RC1,
and latest qualified RC3 as distinct evidence boundaries. The validated RC2
workflow remains available through explicit manual replay, not every main push
or ordinary PR. This avoids retiring RC2's evidence while preventing each
upstream prerelease from permanently adding another six-job automatic matrix.
Doctor reports RC1/RC2/RC3 as exact-version verified only when runtime
attachment capabilities are confirmed on Node 24; recommending an upgrade
remains a separate policy decision, with RC1 still recommended. New DSH
versions do not become verified solely by satisfying `engines.dsh`.

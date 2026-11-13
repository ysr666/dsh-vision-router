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

The `dsh-022-rc3-host-gate.yml` reusable workflow is called by branch-protected `CI` for every PR (and separately allows manual replay) with immutable RC3 source on Linux/macOS/Windows, Node 24.9/24.21, source/host-sharp contracts, upstream Session batch tests, DVR event/attachment integration, Agent selection order, peer admission, proxy egress, real Chromium cold Vision/mixed attachments/Settings save-reload-readback, bundle recomposition, packed candidate CLI installation, Desktop Host injection and multi-plugin ordering. The legacy Host floor lanes remain independent; RC3 requires Node >=24.9, and DVR 3.2 does not advertise Node 22 support.

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

## Required fail-closed acceptance
The latest exact RC is invoked as a reusable workflow by the existing `CI` workflow.
Both branch-protected `contract (24.9.0)` and `contract (24.21.0)`
checks depend on the complete six-job Host gate, explicitly failing if it
fails, is cancelled, or is skipped. They cannot silently succeed because a
separate optional Host workflow failed or was never triggered. The reusable
workflow has an isolated concurrency group to avoid canceling its CI caller.
This preserves existing required check names without repository ruleset edits.

This previously invoked the latest Host for documentation-only PRs. The
three-tier convergence below adds a trusted-base impact classifier: only
non-runtime Markdown and version-only package metadata can skip the heavy
Host matrices. An unknown, failed or inconsistent classifier fails closed.

## Required coverage of minimum, recommended, and latest

The follow-up CI convergence on the same draft PR removes the older
standalone automatic RC5/RC1 gates, retaining their full immutable reusable
workflows and manual replay. Protected `CI` now qualifies all three named
Host contracts for runtime or unclassified changes. The two protected
`contract` statuses require all three successful results; a failed or missing
trusted-base impact classification fails closed. Only reviewed Markdown-only
documentation and version-only package metadata can bypass these expensive
matrices. The decision is made using the classifier at the PR's protected base
commit, not modifiable PR-head code. Non-host changes still run the protected
Node 24 `test` and `contract` checks.

The change deliberately avoids doubling the Host job count: it moves the
previous separate minimum/recommended matrices under the existing required
CI rather than running new copies. Exact qualification and original run URLs
remain preserved by immutable refs in this audit/PR history.

## Durable acceptance evidence ledger

This source-controlled summary remains in the Git history after hosted
Actions logs expire. It preserves verified commit and source identities,
verification scope, official run links and outcome; it is not a substitute
for permanently archived full logs or a guarantee for untested workflows.

| Verified DVR candidate | Immutable Host identity | Real verification | Recorded outcome |
| --- | --- | --- | --- |
| [4dfba17fadfbe21305083054a44dcbbc773212ef](https://github.com/ysr666/dsh-vision-router/commit/4dfba17fadfbe21305083054a44dcbbc773212ef) | DSH 0.2.2-rc.3 @ 38a6a5c965aa99ab525161efb7cc5cf1fe62fced | [Protected CI run #43416019566](https://github.com/ysr666/dsh-vision-router/actions/runs/43416019566): six exact RC3 Host jobs (Linux/macOS/Windows, real Chromium, Windows Node 24.9/24.21), core/contract checks | 16 of 16 workflows succeeded |
| [4dfba17fadfbe21305083054a44dcbbc773212ef](https://github.com/ysr666/dsh-vision-router/commit/4dfba17fadfbe21305083054a44dcbbc773212ef) | DSH 0.2.1-rc.5 @ b830ec950faba0a46dda564be3e2d854afed94f1 | [Minimum Host run #43416019215](https://github.com/ysr666/dsh-vision-router/actions/runs/43416019215) | Success |
| [4dfba17fadfbe21305083054a44dcbbc773212ef](https://github.com/ysr666/dsh-vision-router/commit/4dfba17fadfbe21305083054a44dcbbc773212ef) | DSH 0.2.2-rc.1 @ 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db | [Recommended Host run #43416019244](https://github.com/ysr666/dsh-vision-router/actions/runs/43416019244) | Success |
| [d4ea0f973a9daeb8376fcc6abcad9af9396a1fd6](https://github.com/ysr666/dsh-vision-router/commit/d4ea0f973a9daeb8376fcc6abcad9af9396a1fd6) | DSH 0.2.2-rc.3 | [Chromium job #131828321004](https://github.com/ysr666/dsh-vision-router/actions/runs/43408342770/job/131828321004): published npm 3.2.1, packed candidate, source, three recompositions each | All three install forms succeeded |

**Evidence boundary:** the new three-tier protected CI changes postdate the
above successfully verified heads and must independently pass on their final
commit. These immutable prior successes do not pre-certify a newer PR head.

## Required process for the next upstream Host RC

1. Pin the *official immutable* upstream tag target and review Host ABI,
   Session, Web, model selection, image ownership, and security changes.
2. Promote the new latest exact workflow through protected CI. Keep the old
   latest source pin and run references available for manual replay, but do
   not permanently duplicate its full automatic matrix.
3. Preserve both minimum and recommended exact Host obligations until an
   explicit supported-window policy change is approved.
4. Run real three-OS, Chromium and Windows Node 24.9/24.21 Desktop gates,
   with fail-closed trusted-base classification and required contract checks.
5. Update Doctor's exact verified-version evidence only after a successful
   immutable real-Host gate; update the recommended version separately.
6. Record the **tested DVR SHA**, **DSH SHA**, **CI run/job IDs**, supported
   scope, limitations and findings in this ledger and in the PR description.
   A passing semver range or a source-only pin is never runtime proof.


## No-worktree trust-boundary hardening (CodeQL follow-up)

The protected `CI` impact classifier no longer uses `actions/checkout` at
all. In a fresh empty Git repository it fetches only the trusted base SHA
and the official base-repository `refs/pull/<number>/head`, verifies that
ref is **exactly** the event's pinned PR head SHA, and fails closed if the
PR moved. It extracts the classifier script from the immutable base Git tree,
while the untrusted head supplies only `package.json` data and path diffs.
No worktree, PR action or installation script from the head is executed.
No credentials or privileged GitHub token are needed for this public repo.
The source-controlled security contract tests assert the absence of checkout
and the SHA fence. The new commit must separately pass its own GitHub Actions
and CodeQL annotations; prior green checks are not proof the alert is closed.

## API-only Host impact classification (CodeQL follow-up)

The CodeQL medium rule models PR-head Git fetch as well as `actions/checkout`.
The protected CI classifier no longer fetches PR Git refs or checks out a
worktree. Instead its read-only token (`contents: read` and `pull-requests:
read`) retrieves pinned contents and complete changed-path metadata from
GitHub API. It checks the PR base/head SHAs both before and after reading the
files, refuses missing/incomplete results, treats every rename/copy/unknown
status and PRs above 100 files as **heavy**, and only executes the classifier
from the immutable trusted base. SHA races/API failures fail protected CI
closed. New head CI and CodeQL alert adjudication are separate obligations.

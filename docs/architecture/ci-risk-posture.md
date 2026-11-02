# CI risk posture

This file records security-posture decisions that are deliberate rather than pending, so a
later reader does not re-litigate them or mistake them for oversights.

## Resolved: Scorecard `TokenPermissionsID` on workflows that publish or open pull requests

Three alerts in this class were open on 2026-10-04 and are now `fixed` (2026-10-04T14:17:06Z):

| Alert | Location | Grant then | Outcome |
| --- | --- | --- | --- |
| `#127` | `.github/workflows/dsh-alpha-pin-refresh.yml` | workflow-level `contents: write` + `pull-requests: write` | fixed by moving both grants onto the job that pushes the pin branch and opens its pull request |
| `#125` | `.github/workflows/release.yml` | job-level `contents: write` (materialize the release tag) | fixed on re-analysis |
| `#126` | `.github/workflows/release.yml` | job-level `contents: write` (publish the GitHub Release) | fixed on re-analysis |

Scorecard's rule asks for top-level permissions to be `read-all` or `contents: read`, and
job-level least-privilege grants are accepted. Every workflow here now has that shape:
`release.yml` declares top-level `permissions: {}`, the alpha gate and the pin refresh declare
`contents: read`, and each write grant lives on the single job that needs it.

A previous revision of this file claimed the opposite — that the rule reports the grants
themselves, so moving one between levels could not clear the alert. That claim was wrong. It
generalised from the presence of alerts on `release.yml`'s job-level grants instead of measuring
the level change itself; moving the pin refresh's grants to job level cleared its alert, and the
two `release.yml` alerts cleared on re-analysis. The measurement is recorded above so the next
reader does not repeat the inference.

What remains true regardless of the score:

- the pin refresh never checks out or executes upstream code: it reads npm and GitHub metadata
  and rewrites one line, so the write token is never exposed to third-party code;
- it has no access to secrets beyond the default token, and its pull request is opened with
  `GITHUB_TOKEN`, which by design starts no workflow runs;
- the gate that *does* execute upstream code keeps top-level `contents: read`, pins the upstream
  commit literally, and neither writes nor restores any shared cache;
- the platform-side control (a protected environment with required reviewers on the publishing
  jobs) is available but deliberately not adopted: it would break unattended pin discovery, and
  every write path here is already a reviewed pull request or a dispatched release.

## How to revisit

If the write tokens ever need to shrink, the order is: attach the publishing jobs to a protected
environment, then drop `pull-requests: write` from the pin refresh by opening the bump as an
issue instead of a pull request. Both trade automation for score, which is why they are not the
default.


## Reviewed Alpha Settings pin: least-privilege update lane

The Alpha Settings Host Gate uses a reviewed version / immutable SHA pair
from config/dsh-alpha-settings-pin.json. Its three job families load that pair
and reject an invalid or incomplete pin. The gate runs on pull requests that
touch the config or loader and on the merge to main. The updater stages only
the JSON config, never workflow YAML; do not grant the bot workflow-edit
permission. Merging a pin PR is the upstream execution review boundary.

The pin step writes both current and changed through GITHUB_OUTPUT. The bot
updates its dedicated branch using an explicit lease against the remote SHA,
not an unsafe force push.

Repository settings may separately prohibit GitHub Actions from creating PRs,
even with pull-requests: write. Under that policy the refresh action pushes
the config-only branch but fails with an actionable compare/PR URL, not a
misleading success. Opening the PR requires an authorized person or a
separately scoped PR-writing app token. Changing that security setting is
outside this code fix.

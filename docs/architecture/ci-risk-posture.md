# CI risk posture

This file records security-posture decisions that are deliberate rather than pending, so a
later reader does not re-litigate them or mistake them for oversights.

## Accepted: Scorecard `TokenPermissionsID` on workflows that publish or open pull requests

Open alerts in this class (checked 2026-10-04):

| Alert | Location | Grant |
| --- | --- | --- |
| `#125` | `.github/workflows/release.yml:236` | job-level `contents: write` (materialize the release tag) |
| `#126` | `.github/workflows/release.yml:494` | job-level `contents: write` (publish the GitHub Release) |
| `#127` | `.github/workflows/dsh-alpha-pin-refresh.yml` | job-level `contents: write` + `pull-requests: write` (push the pin branch, open its pull request) |

Scorecard's rule asks for top-level permissions to be `read-all` or `contents: read`. That part
is already satisfied everywhere: `release.yml` declares top-level `permissions: {}`, the alpha
gate and the pin refresh declare `contents: read`, and each write grant lives on the single job
that needs it. The alerts persist because the rule also reports the write grants themselves, so
**moving a grant between levels cannot clear it** — the only ways out are to stop publishing
(`release.yml`) or to stop proposing the pin bump (`dsh-alpha-pin-refresh.yml`), which are the
workflows' purpose.

What is in place instead:

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

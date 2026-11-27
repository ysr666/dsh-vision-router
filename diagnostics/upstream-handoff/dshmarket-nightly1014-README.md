# dshmarket update response handoff

Upstream target per its PR template: `nightly1014` (not main).
Immutable base: b6af7524fcab3d1e6ab78ab66f032768d9af9cb7 (package.json 1.84.2).
Production changes reproduce the previously verified 1.82.0 two-file root-loader fix, with one additional regression for the official branch's root lookup. No version bump or unrelated edits.

`git apply --check dshmarket-nightly1014-post-update-loader.patch` then apply from that exact checkout. Run `npm test` and `npm run check`. New test has not yet run; original 1.82.0 Windows positive/negative evidence:
- Unmodified market 500 after DVR ACTIVE: https://github.com/ysr666/dsh-vision-router/actions/runs/45984791250/job/140457506015
- Patched market 200 + new process: https://github.com/ysr666/dsh-vision-router/actions/runs/45944400579/job/140325685677

External issue submission via current GitHub connection returned 403 Resource not accessible by integration; no upstream fork/PR created. User-authorized external contribution requires a connected personal GitHub session. This patch is a handoff, not upstream acceptance.
# Upstream handoff candidates — #864 and #877

Not a DVR runtime change; not an upstream PR or publication.

## DSH shared model directory (#864)

Base: deepseek-ai/deepseek-harness 4b399c39a6d1479cd84ca591b4d7c88e24d38a96 (0.2.3-alpha.2).

`git apply --check dsh-shared-model-directory.patch` then `git apply dsh-shared-model-directory.patch` from that checkout. Run the focused Host/client tests and full build. The patch contains only the tested shared Host API implementation and three upstream-native regressions, not the DVR/Claude Style diagnostic fixtures. DVR-side companion: ysr666/dsh-vision-router#898. Combined diagnostic evidence: https://github.com/ysr666/dsh-vision-router/actions/runs/45944437754 (57/57, full build 10/10). The ordinary directory projects explicit equivalent aliases; rawDirectoryFor keeps exact route selection. Old Hosts cannot supply this shared view. The upstream design and review remain required.

## Market stale Loader readback (#877)

Base: dsh-market/dsh-market 18004a19b1c5bca1cd3ea405e2171a5fb3c089ce (1.82.0).

`git apply --check dshmarket-post-update-loader.patch` then `git apply dshmarket-post-update-loader.patch` from that checkout. The patch captures the root in the official Desktop branch and reads the current loader only after a successful update, leaving pre-update and legacy paths untouched. It excludes the runner-local registry override and diagnostic fixtures. Real Windows combined repair and restart: https://github.com/ysr666/dsh-vision-router/actions/runs/45944400579/job/140325685677 (HTTP 200, live/hot=true, fresh Electron restart). This does not prove released 1.82.0 contains the repair. The original reporter's exact Windows 10 nightly was not reproduced.

Both patches were generated against immutable source with exact anchors and line-diff reconstruction checks. The isolated patches separately passed `git apply --check` on their exact upstream checkouts; both checkouts remained unchanged. Evidence: https://github.com/ysr666/dsh-vision-router/actions/runs/45946663399/job/140332808900. Their full integration results are the combined diagnostics cited above; the standalone patches have not separately undergone full build and runtime tests. No external repository has been modified. The pinned upstream heads were rechecked on 2026-11-27 and remain current.

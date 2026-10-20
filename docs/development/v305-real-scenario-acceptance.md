# v3.0.5 release-candidate acceptance record

Release candidate must be tested on the final PR head, then on the exact main SHA before publishing. Evidence below refers to the merged change PRs; it is not a claim that the future v3.0.5 package has already been installed by a user.

| Scenario | Evidence | Scope and verdict |
| --- | --- | --- |
| `vision_describe` succeeds and assistant visibly answers (#727) | #731 23/23, #733 22/22, trusted combined #732 23/23 | Actual Desktop automated PNG upload → vision tool execution → final visible assistant reply; canonical tool-result and Session V3/V4 notice attribution preserved. **NOT** a separately installed/published 3.0.5 artifact |
| Contributor attribution of #728 | Main merge `0fc51c3` / #733; original commit `14c67c7` | Git ancestor/merge-base verified; original GitHub #728 recognized as merged, no squashed/copied authorship |
| Latest DSH Alpha JSONL CI loader | #730 (Node 22/24 real published-alpha lifecycle) | Canary runner/export compatibility only; no production transport, minimum Host or settings change |
| Optional peers missing at activation | #722, CI run 39019198833 | Passed isolated actual Node ESM entry-load probe and negative control; not a manual end-user Desktop install |
| DSH 0.2.1-rc.1 real Host/Web+Chromium | #721, run 39017893115; #723, run 39020741495 | Pinned source, Vision cold toggle, image+text, Settings save/reload/readback, bundle recomposes |
| DSH 0.2.0-rc.2 compatibility | #723, run 39020741454 | Pinned original Host and Desktop/Chromium cross-platform gates |
| DSH alpha.5 and legacy 0.1.7 | #723, alpha Settings Host and 0.1.7 real Host smoke | Tested against published pinned source; older support window remains unchanged |
| Node 22 and 24, packed API | #723, CI run 39020741423 | Passed both Node versions, packed public API and Ubuntu/macOS/Windows Host-Sharp |
| Official OVH 10 MB JSON request boundary | #723, tests/http-compat.test.js | Passed mocked negative and positive wires; **not** an online request to OVH |
| billion-context coexistence | Issue #704 | **NOT VERIFIED** in a pinned dual-real-plugin runtime; reporter must identify which package/version |
| Windows native-disabled click suppression | #735 / Issue #684 closed | **MITIGATED:** bounded cached-pair actionability during catalog loading, with Host authority intact; not a blanket guarantee against all intermittent failures |
| Windows delivered-click Host RPC failure | Issue #738 / diagnostics #737 | **UNRESOLVED:** a real 0.1.7 Windows Node24 run recorded `gateway/internal` after both clicks arrived. #737 adds only safe error-origin telemetry, with independent exact real-Host CI 6/6 alpha, 5/5 legacy, 7/7 rc.2 |
| Multi-provider HTTP 400 | Issue #716 | **NOT REPRODUCED**, needs redacted response body; do not claim success |

## Acceptance matrix for a final install / upgrade

For the final v3.0.5 candidate, record exact OS, Node, DSH, DVR package and git SHA for every row. Protect API keys, image contents and personal profile paths in shared logs.

1. **Clean install (isolated profile):** install the actual packed v3.0.5 tarball through the supported DSH plugin mechanism. Ensure the two optional DSH peer modules can be absent; restart the Desktop, confirm Host Connection and Vision settings mount and that no ERR_MODULE_NOT_FOUND occurs.
2. **Upgrade from v3.0.4:** preserve profile Settings and Session data, change only the plugin package, restart and verify the displayed version and unchanged stored values. Do not delete a live package.json.lock.
3. **Cold Web + Desktop:** check Vision OFF by default, toggle OFF to ON to OFF once, paste a small PNG alongside text, run a vision tool, open Settings, save/reload/read back and test a second window. Capture button pointer traces if OFF fails; do not simulate retries.
4. **Payload boundary:** for the exact official OVH HTTPS model, a small PNG should reach the selected mocked or test endpoint unchanged. Oversized aggregate JSON should stop locally with INVALID_REQUEST, no outbound call, and no image content in diagnostics. A non-OVH provider must not inherit OVH's size limit.
5. **Privacy and ecosystem:** local-only mode must not call an external vision provider; verify remote text model caveat. Co-install with either billion-context package only when its exact package/version and user-reported failure are known; check both plugin load orders and first failure.
6. **Release supply chain:** pnpm frozen install, reproducible build, source-artifact map, Node 22/24 tests, packed public API, Host support contract and npm version uniqueness must all pass on exact final main commit. Release workflow verifies one tarball, provenance, registry hash and immutable GitHub assets.

## Release decision

Do not label any unexecuted row green. GitHub Actions real Host + Chromium gates are automated integration tests, **not** a manually observed installation on the user's computer. Release notes must explicitly state that #738 and #716 remain open, and must not turn #684's bounded mitigation or #704's closed disposition into a claim of fully reproduced root-cause repair. The manual trusted release workflow remains an independent action after this candidate PR is accepted.

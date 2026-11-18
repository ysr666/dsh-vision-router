# DSH 0.2.2-rc.4 qualification candidate

Status: **pending CI and runtime acceptance**; not a release or support recommendation.

- Official tag `dsh-v0.2.2-rc.4`, immutable commit `3f321d32bfe382212a8ed8785c1d47a5a300aa23`; predecessor `dsh-v0.2.2-rc.3` at `38a6a5c965aa99ab525161efb7cc5cf1fe62fced` (8 commits ahead, 0 behind).
- [Upstream refusal-code guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.4/docs/upgrade-guide/v0.2.2-rc.3/deepseek-refusal-code/guide.zh.md): `CONTENT_REFUSED` replaces `MALFORMED_RESPONSE` for explicit DeepSeek refusals. The upstream stream test is now included in the candidate gate. DVR-specific propagation, fallback and failure classification require separate runtime review; this qualification PR does not claim to fix those semantics.
- Existing engines, Node floor and recommended Host remain unchanged. RC3 retains explicit historical replay; no extra automatically triggered full matrix. Do not add RC4 to Doctor exactVerified until exact acceptance succeeds.
- #860 reports installed npm 3.4.0 failing activation through dsh-plugin-shop with `cannot create effect on inactive context`; Host version and full stack are unknown. The advisory published 3.4.0 install/recompose check is separate from the packed candidate and is not a reproduction of the Shop path. Keep #860 open until cause and actual regression are verified.
- Local Mac remote execution quota unavailable; no local test result claimed. No merge, tag, npm, Release or native distribution authorized.

# Issue #865 — Stage 2 immutable-prefix contracts (Draft source)

## First principle

Provider cache eligibility depends on the **actual serialized provider request**,
not only persisted Session events. Under an unchanged provider, model, prompt,
active-tool policy and unchanged past turns, DVR must not mutate old model-visible
messages. New OCR/caption evidence is a new durable user message, not a
replacement for an earlier image occurrence.

This is intentionally narrower than “all requests always hit provider cache”.
Provider-side eviction, Files IDs, image offload and protocol-specific tool
changes can still invalidate a cache.

## What changes in this Draft

1. Both stable text-only image projection paths call one pure renderer.
   The pre-step v1 `history` marker and generated-twin v1 `wrapper` marker are
   **not byte-identical to each other**. They were already distinct on the
   pre-existing Draft. They MUST remain individually byte-identical after this
   refactor. Route changes do not create a cross-adapter prefix guarantee.
2. A committed producer-owned `user/message` is the only delivery proof for
   synthetic image evidence. Its deterministic v1 ID is recomputed from the
   recorded OCR text and original `[messageId, attachmentId]` pair.
   The latest committed OCR version is recovered from the actual Session log,
   so a 512-ID in-memory eviction does not alone reissue an unchanged result.
3. Line-ending and edge-whitespace-only differences do not create new visual
   evidence. Corrections to substantive OCR content remain new append-only
   messages; no semantic similarity guess is allowed to discard evidence.
4. OFF must keep protected DVR tools out of the model-visible declaration and
   reject direct tool execution. ON and OFF each need deterministic schema
   order and byte-identical declarations when unchanged.

## Invariant tests

- `tests/issue-865-append-only-image-evidence.test.js`: prior v1 wire bytes,
  original source image unchanged, no memory-dependent historical mutation,
  >512 committed versions, independent-process-style cold restoration, and
  uncommitted pre-step retry.
- `tests/issue-512-tool-restriction.test.js`: OFF/OFF, ON/ON, ON/OFF,
  foreign tools and executable permission denial.
- `scripts/issue-865-wire-characterization.mjs`: actual pinned DSH
  `LlmRuntime` -> official DeepSeek Messages serializer for unchanged-policy
  prefix, addition-only incremental additions and safe removal baseline reset.
- Existing production JSONL and original-image tests remain mandatory.

## What is deliberately NOT changed

- Existing `stableImageHistory` remains explicit opt-in (default false).
  The separate `stableImageHistoryNewSessions` switch remains EXPERIMENTAL and defaults false; an architecture review found unaddressed first-turn classification, runtime Settings override, and missing-sidecar restart hazards. It
  applies only when the official DSH Storage Domain can persist a per-Session
  format decision **before the first LLM request**. In old or imported Sessions
  with committed model history, the first decision is `legacy`, and stays
  `legacy` on future requests and across cold resume. If already stored,
  neither current Settings nor later request headers silently change it.
- The optional domain `vision_router_image_projection` is distinct from
  Session Vision permission. Its `modes` table stores only
  `{revision:1,mode:'legacy'|'stable'}`, keyed by Session ID; no OCR text,
  image contents, private Session events, or credentials are stored. Missing
  or untrusted storage fails closed to legacy, never a process-local guess.
  A genuinely interrupted/failed sidecar write cannot justify a stable-mode
  request, and ambiguous provider/cache outcomes still require testing.
- Source histories retain their original image events. Existing opt-in v1
  text-wrapper and history markers are unchanged. No unapproved retroactive
  migration of old Session prefixes occurs.
- DeepSeek `toolUpdate: addition-only` cannot represent tool removal as an
  incremental change. On OFF, the Host must rebuild declarations. DVR must
  **not** preserve protected tools just to make the header look cache-stable.
- No claim of provider cache hits, user billing savings, or final Issue closure.
  Actual per-request cache read/miss and itemized charges remain separate
  evidence to collect with authorization.

## Verification still required

- Exact-HEAD CI on supported Windows/macOS/Linux Host and Desktop.
- Provider-backed read/miss and billing comparisons remain part of the final
  #865 issue closure, not of the offline Stage 2 prefix contract.
- Real Chinese screenshots/low-resolution documents and the PP-OCRv6 quality
  acceptance are not replaced by these synthetic image/pixel-preservation gates.

## Deployment

Source candidate only. Do not merge the Draft, publish, bump formal version,
create tag/release, or upload native binaries without distinct authorization.

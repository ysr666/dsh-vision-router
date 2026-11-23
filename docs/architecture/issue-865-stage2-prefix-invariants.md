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

- `stableImageHistory` stays **opt-in**. An unconditional default flip would
  switch already-running Sessions from mutable legacy history to v1 markers
  and cause the very historical prefix reset this fix seeks to prevent.
- Do not infer a persistent projection version from process-local Maps or
  whether OCR memory happens to be populated. A future default-on rollout
  needs durable per-Session format/version identification, a legacy migration
  boundary, quality tests with real OCR and native/text-only image inputs,
  and specific cold-resume validation. This Draft does not invent one.
- DeepSeek `toolUpdate: addition-only` cannot represent tool removal as an
  incremental change. On OFF, the Host must rebuild declarations. DVR must
  **not** preserve protected tools just to make the header look cache-stable.
- No claim of provider cache hits, user billing savings, or final Issue closure.
  Actual per-request cache read/miss and itemized charges remain separate
  evidence to collect with authorization.

## Deployment

Source candidate only. Do not merge the Draft, publish, bump formal version,
create tag/release, or upload native binaries without distinct authorization.

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
- `tests/issue-865-session-image-projection-mode.test.js`: witness commit-vs-plan,
  source authentication, deleted-sidecar cold restore, fork inheritance and
  missing-storage legacy guard.
- `tests/issue-512-tool-restriction.test.js`: OFF/OFF, ON/ON, ON/OFF,
  foreign tools and executable permission denial.
- `scripts/issue-865-wire-characterization.mjs`: actual pinned DSH
  `LlmRuntime` -> official DeepSeek Messages serializer for unchanged-policy
  prefix, addition-only incremental additions, safe removal baseline reset,
  and an actual pinned DSH Session witness, cold reconstruction and fork.
- Existing production JSONL and original-image tests remain mandatory.

## What is deliberately NOT changed

- Existing `stableImageHistory` remains explicit opt-in (default false).
  The separate `stableImageHistoryNewSessions` switch remains EXPERIMENTAL and
  defaults false. A genuinely new Session can choose stable at its
  pre-step and persist its proof as a normal DSH user/message **with the first
  LLM request**, without relying on optional storageDomain. Current DSH
  `agent/pre-step` claims the inbox before user/message is committed; the
  format guard uses `requestHeader()`, `firstLiveSeq`, `header.isSeeded`,
  inherited fork cuts and existing requests, not a user message alone, to
  distinguish genuine first requests from seeded/restored history. The persisted
  per-Session mode always wins over live Settings thereafter.
- The optional domain `vision_router_image_projection` is separate from
  Session Vision permission. Its `modes` table stores only
  `{revision:1,mode:'legacy'|'stable'}`, keyed by Session ID; no OCR or image
  bytes. It remains a compatibility accelerator for previously written rows.
- Each opted-in stable Session receives **one short, model-visible DSH
  `user/message` witness** with an exact, versioned `stable-v1` or
  `stable-v2` body. Its deterministic ID and DVR producer attribution
  are checked. A v1 Session is never silently rewritten to v2.
  The event is only committed upon successful pre-step admission, never merely
  planned. DSH Session JSONL, cold restore and forks carry this witness even
  when the sidecar is deleted or unavailable. It costs a small one-time
  model-visible prompt prefix; this cost must be measured, not concealed.
  The Host explicitly forbids external use of `appendPluginRecord`, and
  SessionHeader has no extension fields, so no unsupported private event is
  introduced.
- When the witness and sidecar disagree, the committed versioned witness
  takes precedence. Conflicting v1/v2 witnesses in the same Session fail
  closed, rather than selecting a convenient byte layout. The first eligible stable request needs no storageDomain:
  sidecar write failures fall back to the ordinary committed Session witness,
  and aborted pre-step plans remain retryable. The v2 choice is not written
  into the v1-only sidecar row schema. Older candidate Sessions with
  sidecar `stable` but no witness receive one on their next admitted step.
  Without either proof, an established image-bearing Session is `unknown`,
  never guessed legacy. Text-only continuation is permitted if inspection
  proves it cannot alter image history. Lost pre-witness experimental state
  remains a rollout limitation.
- Source histories retain their original image events. Existing opt-in v1
  text-wrapper and history markers are unchanged. No unapproved retroactive
  migration of old Session prefixes occurs.
- DeepSeek `toolUpdate: addition-only` cannot represent tool removal as an
  incremental change. On OFF, the Host must rebuild declarations. DVR must
  **not** preserve protected tools just to make the header look cache-stable.
- No claim of provider cache hits, user billing savings, or final Issue closure.
  Actual per-request cache read/miss and itemized charges remain separate
  evidence to collect with authorization.

## Canonical v2 isolation (new, explicitly opted-in Sessions only)

- `stableImageHistoryNewSessions: true` selects `stable-v2` only for a
  demonstrably fresh Session, while the older `stableImageHistory: true`
  opt-in remains `stable-v1`. Both decisions become immutable when a
  versioned DVR-source-attributed normal DSH `user/message` witness commits.
  A restored/forked Session always reads its original witness, even when
  the sidecar is missing; contradictory v1/v2 witnesses fail closed.
- The v2 representation is **identical** for the pre-step history rewriter
  and the generated text twin. It is made only from a JSON-quoted durable
  attachment ID, and never from filenames, OCR results, clock time, current
  permission, or mutable adapter memory. The prior v1 path-specific English
  and Chinese markers are retained byte-for-byte.
- The official DSH Session lifecycle and DeepSeek Messages serializer are
  exercised by `scripts/issue-865-wire-characterization.mjs`; unit tests
  cover v2 direct/wrapper parity, OCR/filename mutations, saved v1 continuity,
  fork recovery, hostile attachment IDs, and conflicting witness formats.
- This is **text-only path parity**, not a promise of equality across native
  multimodal image serialization, provider/model changes or tool ON→OFF.
  Rolling back to a pre-v2 DVR binary can also lose v2 awareness: rollback is
  a separate compatibility boundary, not silently supported.
- Explicit opt-in only. The global new-Session default remains **false**;
  actual cache-hit/miss billing comparisons and full supported Host/Desktop
  approval remain required.

## Verification still required

- Exact-HEAD CI on supported Windows/macOS/Linux Host and Desktop.
- Provider-backed read/miss and billing comparisons remain part of the final
  #865 issue closure, not of the offline Stage 2 prefix contract.
- Real Chinese screenshots/low-resolution documents and the PP-OCRv6 quality
  acceptance are not replaced by these synthetic image/pixel-preservation gates.

## Deployment

Source candidate only. Do not merge the Draft, publish, bump formal version,
create tag/release, or upload native binaries without distinct authorization.

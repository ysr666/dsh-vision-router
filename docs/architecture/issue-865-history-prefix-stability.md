# Issue #865: Immutable image history request projection

This is a *characterization* of a remaining cache-prefix correctness problem, **not a runtime fix**. The official DSH Host may cache long, identical request prefixes, but a model-visible historical user message changing on a later request invalidates prefix identity even if the durable Session event itself is unchanged.

## Actual current behavior

Both `rewriteHistoryImages(messages, memory)` and `createWrapperStreamBody().stream()` inspect the **current** per-Session image description cache when converting **any** image occurrence in all historical messages.

For the same historical `user` message:

- Before the description is present, the image is serialized as a static attachment/visual-tool marker.
- After OCR or vision tool work stores a description, the *same old user message* serializes with that description.

The source attachment is preserved in the Session log and UI (good), but the model-facing historical text is not immutable (bad for request-prefix reuse). The characterization test asserts this present failure mode without requiring paid API calls.

This matters separately from #868's adapter replay and double-projection fixes. Merely bypassing the outer wrapper runtime does not stabilize the text-only model's historical image markers.

## Fix design constraints

1. Existing image/attachment event data remains unchanged and image tool permission boundaries stay fail-closed.
2. Model-facing representation of an image occurrence **must not change after the first committed request that includes it**, including after OCR descriptions improve, hot cache eviction, cold resume or process restart.
3. New OCR/vision evidence must arrive as a **new durable append-only event** (e.g. first successful tool result, or a correctly identified pre-step injected message when instant-local description is ready), not by modifying an old image occurrence.
4. Do not blindly remove image descriptions: pure-text models rely on that evidence, while native-multimodal routes must continue to receive original pixels.
5. Any future durable first-seen projection table must be scoped by Session and message/attachment identity, carry bounded retention and an explicit migration/fallback behavior; an in-process Map alone cannot guarantee restart stability.
6. Prove identical prefix (ordered system/tool/message JSON) for normal continuation after an image, after subsequent OCR evidence, after memory eviction, and after cold resume. Compare with legacy behavior and detect any loss of image-answer quality. Never promise 100% provider cache hit because cache eviction is server-owned.

### Files involved

- `src/lib/core-primitives.js`: `rewriteHistoryImages`, `createWrapperStreamBody`, `buildInstantLocalMap`.
- `src/index.js`: legacy pre-step image fallback, structured bootstrap, `SessionVisionStateStore` description views.
- `src/lib/session-vision-state.ts`: bounded process-local per-Session description map.

This characterization is intentionally separate from the adapter fix in #868; a subsequent implementation PR should flip the regression from a *known drift* assertion to a *stable prefix* assertion.

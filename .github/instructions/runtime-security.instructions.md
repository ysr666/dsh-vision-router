---
applyTo: "index.js,lib/**/*.js,scripts/**/*.mjs"
---

When reviewing runtime code, treat all Host services, settings documents, provider responses, attachment metadata, session events, model output, filesystem paths, URLs, MIME labels, and environment-derived values as potentially malformed.

Require explicit bounds for bytes, counts, retries, recursion/depth, timers, queues, caches, screenshots, image dimensions, subprocess work, and network bodies where applicable.

Cancellation must prevent stale publication even when the underlying Host operation cannot be physically cancelled. Session/attachment/model authority must remain scoped to the correct DSH context and session.

Credential values and deterministic hashes derived from credential values must not become durable cache identity or diagnostic output when a non-secret identity/event can provide the same invalidation semantics.

Do not infer DSH capabilities from version strings when a capability seam exists. Exact preview verification evidence is not a public support promise.

# #865 unified source candidate / default-on and request-accounting gates

**Status:** disposable integration Draft for review, **not** a release and **not** an authorization to merge any upstream PR. Parent: #884 `bf2972bef1175cdf29ad218603ca4d46227644f5`. This candidate carries the accumulated runtime fixes in #876 → #878 → #880 → #884; it does not replace the independent source PRs.

## Source-owner reconciliation (blob review, 2026-11-23)

| Owner | Integrated result | Source review |
| --- | --- | --- |
| #866 | Session-scoped wrapper reasoning effort; both dedicated Core and runtime-e2e tests match its source blob | core-primitives also includes later fixes; do not overwrite it with an older blob |
| #867 → #868 | Stable owned-twin stream boundary, DeepSeek delegated replay provenance, fallback and tests | 4 critical library/test blobs equal #868 source; integrated Host script is a later joint fixture |
| #870 → #871 | Legacy characterization + append-only evidence and real JSONL tests | stable-image-evidence and Core are superseded by v2 / witness fixes; never revert to old v1 code |
| #872 | Session policy command, permission boundary, wire state and tests | main policy command and Session permission owned files match #872; client/remote are later adapted |
| #874 | Manual Session cache report and offline provider A/B | core command/test blobs match; A/B comparator has later provider-identity evidence and stricter accounting; legacy Host script was extended |
| #876 | v2 image history, immutable witness, mode store, migration admission | integrated as parent of #878 |
| #878 | Final wire fingerprint, safe migration/downgrade checks, upstream usage comparator | integrated as parent of #880 |
| #880 | Provider Usage and identity correctness, native Desktop settling | integrated as parent of #884 |
| #884 | Prevent duplicate auto-mount history, concurrent registration, implicit route/progressive activation | HEAD includes all fixes |

**Do not copy old per-PR `src/index.js`, `core-primitives.js`, `package.json`, or Host workflow files over this candidate.** They overlap, and the newer integrated versions contain additional v2/safety changes.

## Default stable-image history readiness

- Existing Sessions / forks cannot silently switch image-history projection format: their prior wire bytes may have been sent already. A prior stable-v1 witness or stable-v2 witness outranks later settings. Legacy Sessions require explicit, authorized idle migration.
- New Sessions may use canonical stable-v2, with append-only OCR evidence and immutable original image blocks. Source acceptance includes a real Host, compressed JSONL cross-process, wire-prefix invariance and stable identity.
- **Blocker to unconditional default-on:** if both durable attachment identity and originating message identity are unavailable, stable-v2 admission deliberately refuses an unsafe witnessed session; a genuinely fresh Session falls back to legacy. A global default-on claim would therefore be inaccurate. Also, the new-session first-request/cold-resume performance and representative Chinese/image-quality audit is not a completed product gate.
- Do not silently flip `stableImageHistory` or `stableImageHistoryNewSessions` before the documented compatibility and performance/quality gate. A default that is conditionally legacy for some new image inputs is *not* a verified stable default.
- Read/scan cost: authoritative witnesses require at most one full committed-event scan per live Session object after cold resume; the append-only image evidence index retains the most recent 64 image occurrences and a bounded committed-evidence ID list. Remaining CPU/memory evidence should be measured at realistic long-Session scales; the scan is not repeated every pre-step.
- A user-opted legacy v1 format remains supported and cannot be reinterpreted as v2 merely because Settings changes.

## Request and Usage closure definition

- `/vision-cache` inspects **committed main-Session assistant usage**, not uncommitted retries, background title generations or external vision HTTP calls. It cannot be advertised as a full billing ledger.
- The offline A/B analyzer accepts true provider-final usage, categorizes main/vision calls and rejects conflicting totals; it does not know whether the user supplied *all* provider calls. Comparison is meaningful only with a separately proven complete call inventory, including title/retry/vision and cross-route identity.
- Prevent duplicate model dispatch when a call can be safely coalesced; do not share an image request between unrelated Sessions, distinct permissions, different cancellation domains, or uncertain attachment identity.
- No paid call or provider billing estimate is authorized. DeepSeek server cache TTL/eviction is out of product control, not a source-code defect.

## Remaining decisions / delivery

1. Run the exact integration HEAD full Node, native Host/Desktop, Alpha and security matrices, alongside focused long-history default-performance tests.
2. Repair only confirmed implementation or coverage gaps, without weakening OFF execution permission.
3. Make any future main merge and version/npm/release/tag subject to separate owner approval. No source PR is being merged by creating this Draft branch.
4. OFF/ON system + tool prefix unification is **deferred**; current OFF permissions are not traded away for cosmetic cache equivalence.

## Mainline compatibility reconciled (2026-11-23)

The integration branch now also includes current-main `d5eae7cc` changes for #869
(official DeepSeek delegated model image capability) and #881 (authenticated
DSH 0.2.3-alpha.2 Settings root transport), while keeping the #865
`stableImageHistory` option adjacent to the new wrapper capability guard.
Mainline acceptance workflow and original transport/smoke/test file blobs
are reused unchanged; the overlapping index, runtime-e2e and package script
were composed semantically, not overwritten.

## Added targeted closure tests and in-process subcall observation (2026-11-24)

The private Vision tool LLM proxy now captures only **actual streamed** tool-invoked
LLM calls while executing a Vision Router tool. It stores up to 64 results per
live Session object in a WeakMap, tracks finished/failed/incomplete status and
the *last* cumulative Usage chunk, and exposes only anonymous counts/totals
through `/vision-cache`. It records no prompt, attachment, file path, account,
provider route or raw error; it never starts a new model call. A stream that
is constructed but never consumed is not counted as a started execution.

This **does not close the fully automatic billing ledger**: Host-originated
titles, native main provider transactions, unobserved adapter retries and
direct HTTP bridges do not necessarily cross this proxy; cache hits are not
provider calls; provider billing records cannot be inferred from token Usage.
Missing usage is explicitly `?`, not a zero or a free call. For full-cost
analysis, reconcile independent provider gateway call inventory, including
all `main`, `vision`, `title` and `retry` rows.

The new isolated `#865 targeted final closure` CI matrix executes focused
immutable-history, single-flight, sidecall observation and offline Usage
tests on Node 24.9 and 24.21 with an explicit 20-minute per-job timeout.
It supplements, never replaces, the required full CI and exact Host gates.

**Release candidate guard:** neither the stable-v2 default nor a shipped
version is enabled here. Existing Sessions/forks remain locked to their
original format; full quality and representative real-Host performance
remain user-visible acceptance gates. OFF/ON full tool-prefix parity remains
deferred by the owner and must not weaken OFF permissions.

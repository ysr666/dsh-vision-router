# Issue #865 combined acceptance candidate

This disposable test branch combines the exact reviewed source contributions of
B native control, C transparent twin delegation, and D history-stability opt-in.
It does not merge any PR, change main, change a formal version, publish npm or
create a release. Separate PRs remain the owners of their changes.

- Base main: fdba08e062923ab0c230bce71f9d0a16254c8705
- B (#872): 4469ee0763cb5ad0393ec98ec7bc236912646bcf
- C (#868, includes #867): 2ec419c4632cffe91d20b99fac9cbc8514ecb47d
- D (#871, includes #870): ad63018dbb171d8d835cbc82b00fa6ad3eae77a0

Overlapping files use verified base-coordinate nonoverlapping edits, with the
workflow checks and explicit npm test list combined rather than overwritten.
All individual real Host tests must run together on this candidate. In
particular, keep OFF admission denial, native image passthrough, durable
original attachment, replay provenance, provider usage, and opt-in history
projection semantics. Stable image history remains OFF by default.

This is a combined regression candidate, not an approval to ship and not
evidence of live provider cache-hit rate or billing.

The B compatibility/effort follow-up is synchronized to 4469ee0763cb5ad0393ec98ec7bc236912646bcf. The exact
public-plugin twin fixture now additionally enables stable history and runs both
an image-capable and a text-only model on the same registered provider. It
checks raw native attachment identity, stable text marker, append-only evidence
visibility, text twin replay provenance, and unchanged original image. This
joint check uses synthetic evidence and does not execute OCR or paid requests.

### Integrated acceptance expansion

- B ClientRemote production-bridge smoke from `4469ee0` is included unchanged.
- Current exact Desktop lane additionally uses the stock model picker to select an image-capable fixture, then actuates the real native Vision policy button OFF→ON→OFF. Both transitions must preserve the session's complete model-selection projection and event count, preserve the client model identity, and generate zero model requests. Existing text-twin and minimum Host tests remain intact. This additional gate is pending execution, not claimed as passing.

The first combined real Desktop run correctly selected desktop-native but
reported ON. Keep the ordinary-route OFF baseline assertion (do not hide a
permission leak by accepting either state); improve diagnostics and qualify
scoped Session event delivery through the actual Cordis plugin fiber.
The two additional native clicks now have a separate exact DOM click-count
assertion from the frozen legacy two-click diagnostic.

### Final integration source inventory

Add independent #866 reasoning-effort isolation (`3eac5bc77d005edf38f6a5140673e99feb1a38b6`): the Core twin's
cache is keyed by Session, delegate provider and model, bounded to 512 entries.
Its two modified test files are byte-for-byte unchanged from base on the
combined candidate before adoption. Only the two exact old sections of the
shared Core implementation are replaced; C's provenance/delegation and D's
stable image mode remain intact. Add D3 (`19089dc6f42c5a0a4f641b28869e2dd47cd80177`) long production JSONL
serializer-prefix test and its architecture notes. The previous test results
do not automatically qualify the additional delta.

### Desktop positive-control correction

Exact Desktop log (run 44543399083, job 135628379961) shows the original
same-provider picker choice was intentionally mapped to desktop-e2e-vision /
desktop-native by the frozen #284 presentation contract. The observed ON
was a valid DVR wrapper state, NOT proof of an ordinary-route permission
leak. Use a distinct offline native provider to positively exercise an
ordinary route; require native state OFF and the two actual native clicks,
and retain the existing same-provider legacy semantics. The earlier scoped
Host regression independently verifies the actual ordinary-route reset and
is kept. D3 independently passed on job 135631632894 with 685402 serialized
bytes, exact header and prefix across JSONL restart and late memory refresh.

### Host-pinned prepared dispatch integration

Adopt #868 `e7fac2d1a066cfd92b1b4d57ce405c1875d6f743` after its current-host exact source job
135639479192 passed both same-wire assertions and the old-generation probe
(`baselineGeneration=["prepared-old"]`, `candidateGeneration=["prepared-old"]`).
The previous combined Desktop positive control also passed actual native
clicks with zero new model-selection events or model requests. This change
retains D3 and #866 in the shared Core declaration; changes to the projection
boundary require a fresh joint acceptance run. No release or default change.

### D4 — actual public-entry cold-resume proof

Extend the existing D3 script with a separate production-plugin mode. It
mounts the npm public entrypoint in a real Cordis fiber, creates a generated
text twin, and runs a warm-up turn to acquire the actual Session-local
recognition cache. Only the recognition text is synthetic and injected into
that existing cache; **no test-only pre-step appends evidence** in this mode.
The real DVR pre-step must retain the original image and commit exactly one
producer-owned evidence message. The next process must have empty recognition
memory but replay the evidence and all prior serialized wire entries; a late
volatile memory refresh must not rewrite history. D3's isolated helper mode
remains independently exercised. This is not real OCR accuracy or online
provider-cache evidence. If the product path fails these assertions, do not
weaken them to claim production readiness.

### Current-main joint acceptance candidate — 2026-11-20

This disposable **DO NOT MERGE** candidate includes the prior #865 B/C/D/effort
integration, owner-authorized main PP-OCRv6 commit `3b1bf425a015dc9fcd89b1d239c23cae8218aab0`,
and independent diagnostic draft #874 at `f581950e6c437e8809d8b698982e76281b017c49`.
The main tree is the base: PP-OCRv6 files remain unchanged except for *additive*
compositions of package test list, Desktop renderer gate and bundle regression
checks. The pinned current Host workflow includes all earlier checks plus
an offline real public-plugin /vision-cache Command/Agent/Session fixture.
All earlier success results are historical; this HEAD requires fresh gates.
The diagnostic does not send prompts, does not provide billed cost data, and
does not prove server cache hit rates. Stable image history is still opt-in.
Original source PRs remain authoritative and unmerged; this combined PR is
test-only and must never be merged into main.

### D4 late memory-only recognition candidate (2026-11-20)

This disposable integration candidate now includes D4 source Draft #871 at
`3e2d8f94c9fb05b1b2c89bde5eaebe62e5f0c6ec`, without changing the
default `stableImageHistory: false` or merging any source PR into main.
The producer retains a bounded, per-Session image-occurrence index and
recognizes a later memory-only OCR description even after the initial image
inbox was committed. The image itself and historical serialized request
prefix remain unchanged. Already committed evidence is filtered *before*
the four-message-per-step budget, preventing pending fifth images from
being permanently starved.

The source branch's real pinned Host/production JSONL validation has
already succeeded with two separate OS processes: `serializedBaselineBytes=685402`,
`lateMemoryEvidenceCommitted=true`, `evidenceCount=2`,
`coldResumeWirePrefixUnchanged=true`, and
`lateMemoryWirePrefixUnchanged=true`. This is synthetic OCR and offline
model traffic, not a billing experiment. D4 source and combined *full*
workflow qualification must be reported for their respective exact SHAs,
not inherited from the prior combined candidate.
**Never merge this integration-only PR.**

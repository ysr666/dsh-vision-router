# Issue #865 — cost forensics, explicit old-Session stabilization and rollback gate

Status: **stacked experimental Draft source (#878 on #876), not merged or released**.

## Which problem this solves

The original complaint concerned a *previously long* conversation after switching 👁
Vision. An aggregate input-token count is neither a provider cache miss count
nor an invoice. Actual final upstream provider/model, header, ordered effective
tools, serialized historical messages and *each paid request's* official
usage/billing must be distinguished.

Four independent contracts:

1. **Semantic correctness:** no wrong model, replay loss, double tool projection,
   cross-Session reasoning carryover or unauthorized vision tool.
2. **Local prefix preservation:** under the same true upstream/model, tools,
   prompt and old Session events, the final serialized old messages must remain
   unchanged. Legitimate ON/OFF tool changes **can** reset a prefix.
3. **Provider evidence:** DeepSeek cache read/miss and itemized billing are
   provider observations. Local SHA-256 is a change detector, not a cache key.
4. **History compatibility:** new v2 rendering is selected only by a committed
   format witness; old Sessions never migrate by a global default.

## P0 — real final-request structural attribution

Two local-only tools in this stacked candidate:

- `node scripts/issue-865-final-wire-diff.mjs --before path/to/before.json --after path/to/after.json`
  compares **actual native DSH DeepSeek Messages serialized request objects**.
  The local JSON record shape is `{"wire":{"messages":[...],...},"upstream":{"provider":"actual","model":"actual"}}`.
  `upstream` is optional, but omitting it makes upstream identity **UNKNOWN**.
  Output is only structural category flags, prefix lengths, first changed
  historical index/kind and one-way SHA-256 digests; no prompt, tool name,
  provider ID, image or attachment is printed. The files remain local. The
  digests are diagnostic JSON identities, **not** signed provider evidence.
- `node scripts/issue-865-cache-ab-report.mjs --input /private/path/observations.json`
  is imported, with its tests, from independent #874. It checks native
  DeepSeek final usage / disjoint counters and counts *every* main, delegated
  vision and billed retry attempt, requiring itemized actual billing before
  claiming a money delta. It does **not** make provider calls.

`scripts/issue-865-wire-characterization.mjs` now exercises the first
analyzer through the actual pinned Host LlmRuntime and DeepSeek native
serializer, including OFF->OFF, OFF->ON, ON->ON, and canonical-v2 wrapper parity.
This is synthetic, offline Host evidence, **not a measurement from the affected
user's account**.

## P2 — explicit old-conversation baseline stabilization

Existing old Sessions are never silently converted by the global v2 toggle.
The experimental Host command is **manual and consent-bound**:

`/vision-history-stabilize` — shows the warning, writes nothing.

`/vision-history-stabilize CONFIRM` — requests the change. It:

1. Checks exact live Agent/Session ownership and reserves DSH's official
   **idle-only** `agent.runMaintenance()` boundary; a running turn fails.
2. Requires authoritative historical events and no conflicting/unknown format
   marker or protected v1 mode.
3. Requires the official Session persistence `sessions.flush()` to have an
   actual durability participant **before** writing.
4. Adds one attributed ordinary `user/message` stable-v2 witness using
   `Session.append(...,{surfaceOp:'append'})`, without changing previous
   messages, image blobs, IDs, or deleting history.
5. Awaits `sessions.flush()` again. If it cannot confirm durability, does
   **not** report success. Repeating the command re-flushes the existing witness
   without appending a duplicate.

The next request may incur a large **one-time cold cache baseline** because the
old image representation changes. It is not possible to retroactively reconstruct
a missing historical provider-wire prefix from the Session log. This action is
not reversible by simply turning the setting OFF.

**Back up the Session separately** before consenting. Do not downgrade to
an unaware DVR binary. The command does not automate backups, assert that a
previously unseen older version supports v2, or produce real cost savings.

## P3 — downgrade capability preflight, not magical old-binary protection

The candidate Doctor accepts an **explicit target reader capability**, not a
guessed SemVer mapping:

`dsh-vision-router doctor --no-runtime --downgrade-preflight stable-v1`

Supported target capabilities: `legacy-only`, `stable-v1`, `stable-v2`.
The feature scans current `DSH_HOME/sessions` JSONL and Zstd artifacts using
the project's existing bounded, sequential and integrity-checked parser.
It reports aggregate counts of allowed/incompatible/unwitnessed/unreadable
Sessions only; original paths, IDs, prompts and errors are not included in
the result. Missing storage, unrecognized witnesses, damaged frames and
unwitnessed historical image formats cannot be guessed compatible.

- A stable-v2 witness **blocks** a v1-only or legacy-only target.
- A stable-v1 witness **blocks** a legacy-only target.
- An unwitnessed Session is **UNKNOWN**, not "legacy therefore safe".
- A failed/unknown preflight yields nonzero Doctor status.
- A `stable-v2` target can read known stable-v1/v2 witnesses, but does not
  certify unknown prior wire bytes or real cache reuse.

No code running today can force an **old installed binary** to execute a newly
added preflight. Integrating this check into all future supported installers
remains a separate gate; manual package-manager overrides are outside it.
A successful scan also does not constitute proof of OCR accuracy, source
compatibility or provider cache hits.

## What this source work does not finish

- **Affected user's actual cause and charge attribution:** capture authorized
  per-request DeepSeek final usage, real upstream identity, serialized request
  comparisons and itemized bills. No key/prompt/user Session should be committed
  or uploaded to CI/GitHub.
- **Any automatic legacy conversion:** unsafe. Only the above explicit command
  makes a new baseline, and it must be quality-tested on a real restored Host.
- **Automatic downgrade interception by installers:** only the read-only
  capability check exists here. Old binaries do not honor it.
- **Cross-native/image text cache equality:** impossible to promise when actual
  model routing, permission-visible tools or provider image encoding changes.
- **v2 images with no durable attachment/message ID:** the existing v2 request
  index fallback cannot be called a permanent identity across history reorders;
  future format evolution requires a new version, never silent rewriting of
  already witnessed stable-v2 Sessions.
- **Chinese/complex/low-quality PP-OCRv6 recognition acceptance:** separate
  native OCR quality gate, not a substitute for the #865 cost gate.

The only qualified final state for this work is a reviewed exact-HEAD
Windows/macOS/Linux Host/Desktop matrix, deterministic safety/invariance tests,
and separately authorized real provider cache/billing evidence. **No merges,
version bumps, tags, npm publication, Releases or public native packages.**

# Vision Router doctor / repair

Vision Router ships a standalone diagnostic CLI. It can inspect a broken DSH profile even when DSH cannot boot, and it can optionally probe a running Web instance without executing any Vision Router action.

The commands have a deliberately conservative split:

- `doctor` is read-only by default;
- `repair` changes only the two known profile-level faults described below;
- `repair-sessions` changes only exact, known Vision Router session-corruption signatures and always makes a byte-for-byte backup first.

## Normal installation stays unchanged

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router
npx @deepseek-ai/dsh web
```

For a DeepSeek Harness source checkout:

```sh
pnpm dsh plugin --profile web add dsh-vision-router
pnpm dsh web
```

The doctor is a recovery/diagnostic tool, not a replacement installer.

## Doctor v2

Run the normal health check:

```sh
npx dsh-vision-router doctor
```

Or inspect one profile explicitly:

```sh
npx dsh-vision-router doctor --profile web
```

The doctor now separates **"the profile JSON parses"** from **"Vision Router is actually healthy"**. A requested profile is unhealthy when the package is missing, declared but not installed, installed but not mounted, registered twice, or otherwise cannot form one valid activation path.

It recognizes both supported profile shapes:

- **bundle mode** — `dsh-vision-router` is declared in `dependencies` and registered once in `dsh.profile.bundles`;
- **manual mode** — the dependency is declared and the profile's `cordis.patch.yml` contains one Vision Router row.

It reports a hard failure for a bundle+manual double registration, duplicate bundle/manual rows, a missing installed package, or an installed/declared package with no activation row. Profiles that do not use Vision Router are shown as unrelated when scanning all profiles; they do not make another healthy Vision Router profile fail.

The offline profile check also keeps the existing diagnostics for:

- a leading UTF-8 BOM or otherwise invalid profile JSON;
- stale version-pinned `minimumReleaseAgeExclude` entries;
- coexisting vision plugins;
- legacy profile patches that statically disable `llm-deepseek`;
- recent structured `settings save failed field=... operation=... reason=...` records from the Vision Router log. Raw log lines, API keys and arbitrary values are not copied into the report.

### Running-DSH route probe

When DSH Web is reachable, doctor checks that the Vision Router exact routes are really registered. This catches the class of regressions where the plugin partly loads but routes such as `update-check` or `model-capabilities` silently disappear and the SPA fallback returns HTML instead.

The probe sends an intentionally unsupported **DELETE** request to each known route. Every current Vision Router handler rejects that method with `405 Method Not Allowed` and its exact `Allow` contract **before** executing GET/POST behavior. Doctor verifies that exact method contract, so it does **not** run an update check, model discovery, connection test, settings mutation, self-update or log-opening action. Using the expected `Allow` set also prevents a generic SPA/unknown-route response from being mistaken for a registered Vision Router route.

Default target:

```text
http://127.0.0.1:3080
```

Override it with:

```sh
npx dsh-vision-router doctor --runtime-url http://127.0.0.1:4000
```

or `DSH_WEB_URL`. To perform offline checks only:

```sh
npx dsh-vision-router doctor --no-runtime
```

An unreachable DSH process is advisory rather than a doctor failure; offline checks still complete. When `--profile` is used against a reachable runtime, doctor does not attribute green route health to that profile unless the runtime exposes a verified Vision Router profile identity. If ownership cannot be proven, the human report shows `? runtime profile ownership unknown` instead of a false green binding.

### Local capability diagnostics

Doctor reports the local platform, Node version, and whether it can find:

- Tesseract (PATH plus the common Windows install location);
- Chromium / Chrome / Edge (PATH plus common Windows and macOS locations);
- `sharp` and selected DSH host package versions when they are present inside the inspected profile.

Tesseract, Chromium and profile-local Sharp are advisory because the corresponding optional tool may be unused or supplied by the host through another resolution path.

### Scan historical sessions

Session scanning is opt-in because a large session store can take longer to read/decompress:

```sh
npx dsh-vision-router doctor --sessions
```

This is read-only. It looks only for the exact known Vision Router corruption signatures supported by `repair-sessions`.

### Shareable JSON report

```sh
npx dsh-vision-router doctor --profile web --sessions --json
```

The JSON report is schema-versioned and includes the running Doctor/Vision Router version. It is intentionally minimized for issue reports: it does not contain the raw profile manifest, raw log lines, API keys, raw dependency specs, local dependency paths, URL credentials/query strings/fragments, session ids, or raw runtime error text. It keeps only structured diagnostic facts such as install mode, installed version, route status, failure counts, optional capability versions and known session-repair kinds.

## Repair the UTF-8 BOM startup failure

If DSH fails before plugins can load with an error such as:

```text
SyntaxError: Unexpected token ... is not valid JSON
at readProfileManifest (.../profile.ts:...)
```

run:

```sh
npx dsh-vision-router repair --profile web
```

`repair` removes only the three-byte UTF-8 BOM prefix (`EF BB BF`) when it is present, then validates the remaining JSON. It does not reformat, regenerate, or otherwise rewrite the profile contents. If JSON is still invalid for another reason, the command reports that and stops rather than guessing a repair.

`doctor --fix` remains accepted for backward compatibility, but new troubleshooting instructions should prefer the explicit `repair` command so that ordinary doctor runs stay obviously read-only.

## Repair a stale release-age exemption (the "update does nothing" gate)

pnpm v11 defaults `minimumReleaseAge` to 1440 minutes. A version-pinned exemption such as `dsh-vision-router@1.2.0` exempts only that version and goes stale on the next release.

Doctor flags version-pinned entries for `dsh-vision-router` and `@deepseek-ai/*`. Run:

```sh
npx dsh-vision-router repair --profile web
```

to rewrite only those stale targets to bare names (`dsh-vision-router`, `@deepseek-ai/*`). Unrelated entries and the rest of the workspace file are left untouched.

## Repair conversations that only break after restarting DSH

Two historical Vision Router defects can leave already-persisted sessions unable to cold-resume even though current builds no longer create the bad events.

### Legacy missing message id

A very early build persisted the automatic vision-tool mount reminder as a `user/message` without an `id`. DSH can later reject it with an error containing:

```text
lacks an identified message
```

### Duplicate structured guard-stop id

Older structured-flow builds could persist the same exact guard message more than once in one turn, for example:

```text
vision-router-structured-guard-stop-1
```

DSH then sees more than one `input-message...` start when the conversation is reloaded and can fail with an error containing:

```text
received more than one start Match
```

To repair either known case, **stop DSH first**, then run:

```sh
npx dsh-vision-router repair-sessions
```

The repair is intentionally narrow and fail-closed:

- the old missing-id repair still matches only the exact historical Vision Router auto-mount reminder;
- duplicate guard repair recognizes only Vision Router `user/message` events with the exact historical guard id shape, plugin source and one of the exact known budget/depth exhaustion texts;
- the first legitimate guard is preserved; later exact duplicates keep their original event and `seq`, but receive deterministic unique recovery ids so the durable event stream is not shortened;
- if the same guard id appears with a different/near-miss shape or text, automatic repair aborts instead of deleting data;
- raw `session.jsonl` and DSH's checksummed `session.jsonl.zstd` are supported;
- duplicate detection is preserved across separate Zstandard frames, and packed chunk rows are understood when validating the contiguous durable `seq` stream;
- unaffected Zstandard frames remain byte-for-byte identical;
- mutation refuses torn/incomplete logs so DSH can perform its own crash recovery first; read-only `doctor --sessions` treats only an incomplete live tail as advisory while committed structural corruption remains a failure;
- source file identity is rechecked immediately before replacement so a live writer aborts the operation;
- every changed log receives a byte-for-byte backup next to the original before replacement;
- the repaired file is re-read and verified before success is reported.

After repair, restart DSH and reopen the affected conversation. Running `repair-sessions` again is idempotent.

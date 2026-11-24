# Vision Router recovery and preflight

The legacy general-purpose `doctor` command, its runtime probes, JSON health report and issue-template output are retired. Invoking it fails with a usage error and performs no repair. The package binary remains for explicit offline recovery and narrowly scoped read-only checks.

| Command | Behavior |
| --- | --- |
| `npx dsh-vision-router repair --profile web --check` | Read-only profile check |
| `npx dsh-vision-router repair --profile web` | Explicit profile repair |
| `npx dsh-vision-router repair-sessions --check` | Read-only known-corruption scan |
| `npx dsh-vision-router repair-sessions` | Explicit offline Session repair; stop DSH first |
| `npx dsh-vision-router upgrade-preflight --profile web --json` | Known profile migration blockers only |
| `npx dsh-vision-router downgrade-preflight stable-v2 --json` | Read-only Session format compatibility with the explicitly supplied target reader capability |

Use a target of `legacy-only`, `stable-v1` or `stable-v2` only when the target binary's actual reader capability is known. Unknown or incompatible history blocks downgrade. Neither preflight verifies the running Desktop Host or grants release approval. Back up Profiles, Settings, Sessions and attachments before changing versions. No command sends a report or probes the running DSH server. Historical release notes describe the commands available in their respective versions.

For support, provide a minimal reproduction, exact DVR/DSH versions and sanitized errors; never paste keys, raw prompts, private images or unredacted paths.

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

The retired `doctor --fix` invocation no longer performs repair. Use the explicit `repair` command.

## Repair a stale release-age exemption (the "update does nothing" gate)

pnpm v11 defaults `minimumReleaseAge` to 1440 minutes. A version-pinned exemption such as `dsh-vision-router@1.2.0` exempts only that version and goes stale on the next release.

The profile check flags version-pinned entries for `dsh-vision-router` and `@deepseek-ai/*`. Run:

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
- mutation refuses torn/incomplete logs so DSH can perform its own crash recovery first; read-only `repair-sessions --check` treats only an incomplete live tail as advisory while committed structural corruption remains a failure;
- source file identity is rechecked immediately before replacement so a live writer aborts the operation;
- every changed log receives a byte-for-byte backup next to the original before replacement;
- the repaired file is re-read and verified before success is reported.

After repair, restart DSH and reopen the affected conversation. Running `repair-sessions` again is idempotent.

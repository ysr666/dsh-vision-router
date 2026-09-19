# Vision Agent Quality Round 2

This lab measures user-visible vision failures with a small deterministic corpus and an isolated real-Host runner. It is failure-oriented: exact transcription, multi-image identity, small targets, UI state, uncertainty, and relevance/noise resistance.

## Corpus and scoring

The seed corpus contains 36 deterministic PNG cases across six categories. There is no weighted quality score and no LLM judge. Each case has one or more exact accepted answers.

Exact-answer matching is case-sensitive after trimming only leading/trailing whitespace. This is deliberate: `O/0`, `I/l/1`, punctuation, exact codes, and unwanted explanatory prose remain visible failures.

`toolCalls` is a side metric. Extra calls never turn a correct answer into a failure or a wrong answer into a pass. A Host deadline is recorded as `completed:false`; it is still a benchmark result rather than a runner crash.

## 1. Render the fixtures

```sh
pnpm quality:round2:render
```

This creates `.artifacts/vision-quality-round2/manifest.json` and the PNG fixtures. Re-render after a suite-revision change; the Host runner rejects a manifest from another revision.

## 2. Prepare an isolated runtime template

The Host runner requires `--runtime-template <dir>`, where `<dir>/.dsh/` contains the DSH profile, Vision Router installation/configuration, model settings, and any credentials required by the deployment being measured.

Use a dedicated benchmark template, not your everyday mutable DSH home, and never commit it. The runner treats the template as read-only. For every case it creates a fresh temporary DSH home and copies only reusable `.dsh` state; `sessions/`, `attachments/`, `logs/`, `storages/`, and the DeepSeek attachment/file cache `llm-deepseek/` are intentionally excluded. The Agent home is fresh and empty.

This isolation is part of the benchmark contract. A stuck Agent must not be able to discover an earlier case's OCR files, attachment objects, result JSONL, or history and use them as evidence.

For development templates, the clone is also reduced to the `dsh-vision-router` package's declared `package.json#files` surface before the Host starts. This removes repo-only Round 2 corpus/tests/scripts that could reveal expected answers and makes a worktree overlay behave like the intended npm package. An installed plugin symlink that resolves outside the cloned runtime fails closed instead of letting the runner mutate or expose the source checkout.

## 3. Run through the real Session Remote API

Example for the v2.1.7 / DSH 0.1.5-rc.1 reference setup:

```sh
pnpm quality:round2:run -- \
  --runtime-template /path/to/disposable-round2-runtime \
  --dsh-spec @deepseek-ai/dsh@0.1.5-rc.1 \
  --provider deepseek-vision \
  --model deepseek-flash \
  --expect-vision-tools 14 \
  --overwrite
```

The runner starts one real DSH Host per case, creates a separate empty workspace and Session, explicitly selects the requested model, and sends the fixture bytes through the official `session/prompt` image content part. It does not use Chromium, clipboard paste, a workspace chooser, OCR preprocessing, or UI state left by an earlier case.

It then reads completion through `session/list` + the Session projection cursor + `session/page`. Before accepting a result it verifies that a model request actually occurred, that the selected provider/model reached `request/header`, and that Vision Router tools were published. `--expect-vision-tools` makes the current tool-surface size an exact gate when desired.

The launch-token URL is redacted from persisted Host logs. Per-case history and results are written outside the Agent workspace. Temporary runtime/workspace directories are deleted unless `--keep-runtimes` is explicitly requested.

Useful selectors:

```sh
# One or several cases
pnpm quality:round2:run -- ... --ids text-confusable-01,text-code-01 --overwrite

# One failure category
pnpm quality:round2:run -- ... --category text_precision --overwrite

# Continue an interrupted run without duplicating completed ids
pnpm quality:round2:run -- ... --resume
```

`--timeout-ms` bounds one case. `--between-cases-ms` can throttle providers with request quotas. Provider rate limits are infrastructure conditions, not visual-quality evidence; use a backend/quota and delay appropriate for the run you intend to compare.

The default result file is `.artifacts/vision-quality-round2/results-host-api.jsonl`; per-case histories and redacted Host logs go under `.artifacts/vision-quality-round2/history-host-api/`.

## 4. Report

```sh
pnpm quality:round2:report -- .artifacts/vision-quality-round2/results-host-api.jsonl
```

The report exposes raw pass/fail counts by category, missing cases, and cases exceeding advisory `maxUsefulCalls`. It does not collapse those facts into a synthetic score.

For a manual or non-Host experiment, `pnpm quality:round2:template` still creates one blank JSONL row per case. Do not manually correct, normalize, or reinterpret model answers before scoring.

## Change policy for 2.2

The first reference version is v2.1.7. Suite revision 2 clarifies `multi-id-01` to require the complete IDs, including their letter prefixes, because revision 1 used the ambiguous Chinese term “编号” while expecting `A17` / `B42`. Production changes should target an observed failure class and be compared against the same suite revision, DSH version, model/provider configuration, timeout, and provider-availability conditions. New fixtures should represent a distinct real failure mode, not inflate the suite with easy variants.

Use `--reasoning-effort none` when the selected model exposes no reasoning levels; the runner then omits the field instead of sending a synthetic effort.

# Vision Router doctor / repair

Vision Router ships a small standalone diagnostic CLI. It does not need DSH to boot first, so it can still run when DSH exits while parsing a broken profile manifest.

## Normal installation stays unchanged

Use DSH's own plugin command:

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

## Diagnose profiles

```sh
npx dsh-vision-router doctor
```

To inspect only the Web profile:

```sh
npx dsh-vision-router doctor --profile web
```

The command locates the DSH home (`$DSH_HOME` when set, otherwise `~/.dsh`), scans profile `package.json` files, reports UTF-8 BOM bytes, validates the JSON after ignoring a leading BOM for diagnosis, reports whether `dsh-vision-router` is present as a profile dependency and bundle layer, and flags version-pinned `minimumReleaseAgeExclude` entries in the profile's `pnpm-workspace.yaml` that would hold back the next release.

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

## Repair a stale release-age exemption (the "update does nothing" gate)

pnpm v11 defaults `minimumReleaseAge` to 1440 minutes: a version published less than 24 hours ago is not resolved, so `dsh plugin update` silently keeps the previous version and prints `downloaded 0 / added 0`. An exemption entry that pins a version — `dsh-vision-router@1.2.0` — only exempts that one version and goes stale on the next release, which is why "a new release is out but the update does nothing" keeps recurring.

The doctor flags version-pinned entries for `dsh-vision-router` and the `@deepseek-ai/*` host packages:

```text
✗ web — … — release-age exemption version-pinned (dsh-vision-router@1.2.0) — releases younger than 24h will not be picked up
```

Run:

```sh
npx dsh-vision-router repair --profile web
```

to rewrite them to bare names (`dsh-vision-router`, `@deepseek-ai/*`), which exempt every future version, so upgrades take effect immediately again. Unrelated entries and the rest of the file are left untouched.

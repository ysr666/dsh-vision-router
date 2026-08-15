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

The command locates the DSH home (`$DSH_HOME` when set, otherwise `~/.dsh`), scans profile `package.json` files, reports UTF-8 BOM bytes, validates the JSON after ignoring a leading BOM for diagnosis, and reports whether `dsh-vision-router` is present as a profile dependency and bundle layer.

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

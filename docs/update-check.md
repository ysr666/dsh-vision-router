# Update checks

Vision Router checks for newer published package versions and can offer a safe one-click update when the running DSH CLI can be verified.

- A non-blocking check starts once when the plugin starts with DSH.
- Opening the settings card reuses the process-local result; if no check has completed yet, it joins/starts one.
- **Check for updates** forces a fresh check after the current request finishes.
- The checker uses the npm registry inherited by the DSH process (`npm_config_registry` / `NPM_CONFIG_REGISTRY`) when present, otherwise `https://registry.npmjs.org`.
- If an inherited registry/mirror times out, is unreachable, or returns unusable metadata, the read-only version check automatically retries against the official npm registry. Each attempt has its own bounded timeout.
- If every registry attempt fails, the settings card reports the registries that were tried so proxy/mirror problems are easier to diagnose.
- Network/registry failures never block plugin startup or vision features.
- Version comparison follows SemVer, including prerelease versions. A source/prerelease build newer than the registry is never told to downgrade.

## One-click update safety

DSH and the plugin may have been launched through different paths, including `npx`, a globally installed CLI, a source checkout using pnpm, or another wrapper. Vision Router therefore does **not** guess npm/pnpm/npx/bun commands.

When an update is available, the plugin inspects the CLI entry of the current process. One-click update is enabled only when that entry can be traced to a real `@deepseek-ai/dsh` package and can be executed safely by the current Node runtime. In that case Vision Router runs the documented DSH updater through the **same DSH CLI that is already hosting the plugin**:

```sh
dsh plugin --profile <current-profile> add dsh-vision-router@<latest>
```

The registry-confirmed target version is installed explicitly rather than through a bare `update`. This matters because pnpm 11 applies `minimumReleaseAge` (default 1440 minutes): a plain `pnpm update` silently keeps the current version while every candidate release is younger than 24h and still exits 0 ("Already up to date") — a false-success update that leaves the old version running after restart. `add <name>@<version>` installs the confirmed release (pnpm auto-exempts the requested version from the policy when needed). For non-registry installs (git/file/link/workspace specs) the updater keeps `update` semantics and only verifies the result.

The subprocess uses `execFile` with `shell: false`; no shell command is constructed from browser input. The update endpoint also requires a process-local token returned by the same-origin update-check endpoint. After the updater exits, the plugin reads the `dsh-vision-router` manifest under the profile's `node_modules` and verifies that the installed version actually reached the target — **a zero exit code alone is never reported as success**. Only a verified update asks the user to restart DSH so the new plugin bundle is loaded.

If the CLI cannot be verified — for example a raw TypeScript source entry that needs a workspace-specific loader — the one-click button is not offered. This commonly applies to a DSH source checkout launched with `pnpm dsh`: version checking still works, but updating remains under the source workspace's own pnpm workflow. The card keeps the version information and release-notes link and tells the user to update through their original DSH installation path instead.

## Manual recovery

If automatic update is unavailable, the version check fails, or a one-click update fails, the settings card still shows direct Project/Releases links and a manual command. When a newer version is known, the shown commands install that version explicitly, which bypasses the release-age withholding described above. For a DeepSeek Harness source checkout run:

```sh
pnpm dsh plugin --profile web add dsh-vision-router@<latest>
```

For normal npm/npx DSH usage run:

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router@<latest>
```

The settings card substitutes the active profile when it can determine one. If the version still does not change after an update command, check the profile's `pnpm-workspace.yaml` for a version-pinned `minimumReleaseAgeExclude` entry — `npx dsh-vision-router repair` rewrites stale pins to bare names so future releases resolve again (see `docs/doctor.md`).

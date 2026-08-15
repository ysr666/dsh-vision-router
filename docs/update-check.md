# Update checks

Vision Router checks for newer published package versions without changing the installation.

- A non-blocking check starts once when the plugin starts with DSH.
- Opening the settings card reuses the process-local result; if no check has completed yet, it joins/starts one.
- **Check for updates** forces a fresh check after the current request finishes.
- The checker uses the npm registry inherited by the DSH process (`npm_config_registry` / `NPM_CONFIG_REGISTRY`) when present, otherwise `https://registry.npmjs.org`.
- Network/registry failures never block plugin startup or vision features.
- Version comparison follows SemVer, including prerelease versions. A source/prerelease build newer than the registry is never told to downgrade.

## Installation methods

The checker intentionally does **not** run an update command. DSH and the plugin may have been installed through different paths, including:

- `npx @deepseek-ai/dsh ...`
- a globally installed `dsh` CLI
- a DeepSeek Harness source checkout using `pnpm dsh ...`
- another package-manager or wrapper setup

When a newer package exists, the settings card shows the current/latest versions and links to the release notes, then asks the user to update through the same DSH/plugin installation path they originally used. This avoids guessing the user's package manager, profile, checkout, or global/local layout.

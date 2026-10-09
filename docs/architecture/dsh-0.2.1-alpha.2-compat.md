# DSH 0.2.1-alpha.2 compatibility audit (2026-10-09)

## Identity and scope

- Upstream **tag**: `dsh-v0.2.1-alpha.2`.
- Annotated tag object: `6851e496285b2c9670066fdd142e7e46da586649`; peeled **commit**: `d743267388641bc76f17c45ce8b4c231aed1d32c`.
- Previous reviewed alpha: `dsh-v0.2.1-alpha.1@5badb15009ae1756c3afe0ae0cef1faafc290ccc` (PR #645).
- The upstream tag exists, but its GitHub Release and npm alpha dist-tag were **not confirmed published** when this work began. Treat exact source as the test target, not floating npm resolution.
- Keep DVR's existing 0.1.x minimum, current 0.2.0-rc.2 support evidence, 0.2.x peer bounds, and package version unchanged.

## Changes requiring a real Host gate

1. **Build tooling**: DSH root `packageManager` changed from `pnpm@11.7.0` to `pnpm@11.28.5`. DVR remains pinned to its own package manager. Explicitly validate the upstream manifest and execute Host builds with the new manager; do not rewrite DVR's published package requirements.
2. **Settings/client**: the Host reorganized plugin settings and its experimental catalog. Verify plugin settings mount, save, refresh, and readback in a real Chromium browser; do not infer support from source-level slot presence.
3. **Web transport**: WebServer gained native TLS and concrete bind-address handling; Desktop Host now constructs URLs using `webServer.protocol` and may request OS-assigned ports. Verify authenticated Host/plugin routes, proxy authority, and injected Desktop client. Existing plaintext smoke does not establish support for every custom TLS topology.
4. **LLM/model routing**: Host `prepareCall` supports a third `configure` callback and revised call-control binding; model visibility is also changing. Verify the registered adapter, image input and fallback paths. Existing DVR use of `prepareCall(config, signal)` remains positional compatibility pending executable checks.
5. **Session/attachments**: Session schema/version compatibility and plugin record behavior changed. Keep source admission, durable image ownership, cold-restart, and mixed-attachment tests.
6. **Bundle lifecycle**: Host package and dependency mappings continue changing. Verify cold startup, browser injection, multi-plugin ordering, and recompose through real DSH rather than mocks.

## Acceptance gate

The existing `.github/workflows/dsh-alpha-settings-host-gate.yml` performs:
- immutable alpha source contract and Host-owned Sharp on Linux/macOS/Windows;
- official Host peer admission and proxy egress;
- macOS Desktop renderer;
- Windows Desktop auth on Node 22 and Node 24, plus renderer/multi-plugin adversaries;
- real Web + Chromium cold Vision, Settings mount/save/reload/readback, mixed attachments, and bundle recomposition.

The pin is intentionally **not** a blanket support declaration: a PR with pending/failed gates does not authorize saying alpha.2 is validated. No release, tag, dependency bump, production workaround, or merge is part of this audit PR. Only add a runtime workaround after reproducing a genuine interface regression.

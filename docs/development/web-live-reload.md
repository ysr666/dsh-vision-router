# Web Client development: staged builds, Live Reload and native HMR

> **Status (2026-10-12):** The developer-only `pnpm dev:web` workflow,
> upstream native Web HMR and the fail-closed staged build publisher are
> merged in `main` (Issues/PRs #697–#700). The production `pnpm build`,
> released plugin behavior, Host authority and Desktop entry are unchanged.

`pnpm dev:web` is an **opt-in developer tool**. It watches the canonical
`src/` tree and relevant build scripts, checks the generated maintenance
Client code, builds the same 183 artifacts into an isolated temporary directory,
verifies the source-to-artifact map **before publication**, and atomically
publishes the entry files with `lib/client.js` **last**. Builds never overlap.
A compile/verification failure leaves every previously published artifact
untouched, preventing upstream DSH's independent Client-HMR stat watcher from
mistaking an incomplete build for a new revision. Watcher errors do not kill
future builds. The formal `pnpm build` / release packaging remains unchanged.

Start in build-only mode:

```sh
pnpm install --frozen-lockfile
pnpm dev:web
```

### Optional automatic full-page Web reload

Start a **throwaway DSH Web profile** using the plugin entry from the *same*
checkout (`entry.js` or the appropriate compiled package entry), not a stale
installed npm tarball. Then, in the checkout's developer terminal:

```sh
export DVR_DEV_WEB_URL='http://127.0.0.1:PORT/'
export DVR_DEV_CHROME='/absolute/path/to/Google Chrome'
pnpm dev:web
```

The script opens a private Chrome window after the first successful build and
performs a full-page reload after subsequent successful builds. Authenticate
in that window if DSH asks you to. An isolated DSH token URL can be supplied
via the environment variable, but **never paste it into a committed script or
logs**. The program does not print the URL. `DVR_DEV_HEADLESS=1` is available
for automated smoke tests. Only HTTP loopback addresses are allowed; remote
web pages, remote debugging ports, and external browser requests are blocked.
Chrome is controlled through its private CDP stdio pipe, not via a WebSocket
listener exposed to other users. Stop the watcher with Ctrl+C to close Chrome.

In the default **`page` mode** this is full-page Live Reload, not module-level
HMR: the page and React component state initialize from scratch. The opt-in
`native-hmr` mode described below instead uses DSH's own Client Modules
fiber replacement without page navigation; plugin-local React state can still
reset. Vision Router also has structured `webserver/index-inject` and
`tapIndex()` script carriers protected by a per-page one-shot registry.
Native HMR does **not** hot-replace those injected carrier scripts. Do not
manually re-inject them; restart the isolated Host/fresh page for those
changes. No production carrier registry, package export, or Host authority
changes are part of this feature.

If `src/lib/client-maintenance-actions.js` changes, the embedded generated
section in `src/lib/client.js` must be synchronized deliberately by running
`pnpm client:sync` before the watcher can pass the embedded-source check.
It is deliberately **not** rewritten by the watcher: an automated source
rewrite would conceal unreviewed Client changes.

**Scope:** Web-only development. Desktop's custom scheme is unverified and
must not be treated as HMR. Source changes that affect Host runtime services
or settings require an isolated Host restart; reloading Chrome alone does not
reload Host modules. Run established Settings and Issue #684 ON→OFF real-Host
regression gates separately before claiming all-round compatibility.

## Choose the development mode

| Mode | How to run | Behavior |
| --- | --- | --- |
| Build only | `pnpm dev:web` | Rebuild and verify artifacts without launching Chrome |
| Full-page Web reload | Set `DVR_DEV_WEB_URL` and `DVR_DEV_CHROME` | Refresh private Chrome after successful build (default `page` mode) |
| Native DSH Web HMR | Same settings plus `DVR_DEV_RELOAD_MODE=native-hmr` | DSH replaces the Client factory without navigating the page |

Native mode requires DSH's Web boot HMR plugin and the
`/plugins/events` SSE endpoint. If unavailable, use
`DVR_DEV_RELOAD_MODE=page`; the helper will not silently claim native HMR.
Only HTTP loopback URLs are permitted. Never commit token-bearing URLs.

## Upstream native Web HMR (opt-in)

DSH 0.2.0-rc.2 already provides its own Web plugin HMR transport:
`@deepseek-ai/dsh-client-hmr` stat-polls the canonical built `lib/client.js`
and publishes `rebuilt` events through `/plugins/events`. The browser Client
Modules controller invalidates and replaces the plugin fiber, with **no page
navigation**. It is not React Fast Refresh: local component state inside the
plugin resets, while unrelated Web page/session state survives. Electron's
Desktop scheme does **not** use this SSE transport.

With the isolated DSH Web Host pointing to this checkout's Client artifacts
and the usual `DVR_DEV_WEB_URL` / `DVR_DEV_CHROME` variables, use:

```sh
export DVR_DEV_RELOAD_MODE=native-hmr
pnpm dev:web
```

The dev controller probes the HMR row in DSH's boot manifest and an
HTTP 200 `text/event-stream` response from `/plugins/events`. If either is
unavailable, it closes private Chrome and reports an error rather than
pretending to hot-swap the UI. `DVR_DEV_RELOAD_MODE=page` (the default) keeps
the older full-page fallback.

**Important DVR boundary:** native HMR replaces the DSH `dsh.client` factory,
not the Host-injected `client-script-carrier` bootstrap JS/CSS or server-side
settings bridges. The latter retain their one-shot per-page fence and may
need a Host restart and a fresh page to update. Do not claim that changing
Host-side JS automatically updates those browser carriers. Do not interpret
HMR as fixing Issue #684's Host selection/recovery bug; that needs its own
real Desktop ON→OFF evidence.

### Why a staged developer build is necessary

The production artifact builder removes `lib/`, `entry.js`, and `index.js`
before compiling to their final paths. That is acceptable for CI/release
packaging, but **unsafe as a development HMR trigger**: a TypeScript compiler
failure can leave deleted `.js` outputs and still change the live `client.js`
file metadata while upstream DSH polls it. The developer watcher instead calls
`scripts/dev-staged-build.mjs` to compile into a temporary folder under the
checkout, validates the complete map using
`verify-source-artifact-map.mjs --artifact-root <stage>`, and publishes files
with atomic rename operations. The watched Client entry is written last.

The verified publication is not a full database transaction; a disk error
halfway through publishing siblings can still need a clean rebuild/restart.
No claim is made that Host runtime modules themselves are hot replaced.

A real DSH 0.2.0-rc.2/Chrome/Node24 acceptance test covered:
`src/lib/client.js` A→B through the dev watcher, invalid TypeScript compile
with old B artifact unchanged, then repair B→C, without any browser navigation
or unexpected JavaScript exceptions.


## Acceptance summary and deliberate non-goals

- Real isolated **DSH 0.2.0-rc.2 / macOS / Chrome / Node 24**: 30
  consecutive plugin Client swaps, one initial page navigation, no
  unexpected JavaScript exceptions during valid swaps, and no growing CSS
  style count in the observed run. A deliberately malformed bundle was
  rejected and later replaced by a working one.
- Full watcher-to-Host path: source A→B triggered native HMR in about 2.03s;
  a deliberate TypeScript compilation failure left the B artifact and live
  UI unchanged; restoring the source then built and hot-swapped C in about
  2.16s without page navigation.
- GitHub PR #700: all 16 compatibility/CI workflows passed, including
  Node 22/24 and real DSH Host matrices. These checks do not certify
  Desktop HMR, all future DSH releases, or long-running heap memory safety.
- **Issue #684 remains a separate runtime problem.** HMR does not
  fix or validate Desktop Vision ON→OFF recovery; its real-Host evidence
  and implementation remain independent. Host-injected scripts and Settings
  bridges are not Client-fiber hot-swapped.

No new HMR loader architecture or public plugin release is required for this
development workflow.

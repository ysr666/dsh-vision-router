# #806: modern-Host-only Connection overlay experiment

**Status: experimental; not mergeable into DVR main or publishable as the default bundle patch.**

The normal DVR 3.1.x bundle patches the DSH `connection` row to inject `webStartup`, `webServer`, and the private `visionRouterWebConnectionReady` service. On unmodified DSH 0.2.2-rc.1, disabling the entire DVR bundle removes that private provider while app-boot HMR keeps an old Connection Fiber with the prior dependency list. The Host's authentication and API routes become 404. The upstream lifecycle fix is tracked in [DSH Discussion #12555](https://github.com/deepseek-ai/deepseek-harness/discussions/12555) and DVR [#806](https://github.com/ysr666/dsh-vision-router/issues/806).

## Candidate, restricted to modern Web Startup Hosts

This experimental branch changes only the core Connection overlay:

```yaml
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [webStartup, webServer]
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts
```

It preserves the existing `webServer` ordering requirement and uses DSH's own `trustedHosts`; it neither adds authorities nor bypasses the Host's authentication fence. Removing a DVR bundle no longer removes any of the Connection Fiber's required services. The separately inserted DVR ready-bridge row remains in this experiment for minimal source-diff fidelity, but is no longer consumed by Connection and would need its own retirement review before production.

## Evidence obtained on Windows

All tests used temporary Desktop Profiles and a locally built DSH 0.2.2-rc.1 tree, with its **app-boot / HMR source and bundle restored to unmodified official commit `66491b05` during each test**. The DVR source was built from the published v3.1.3 package; a full built-artifact copy was necessary in the separate Git worktree. Original source/built app-boot artifacts were restored afterward.

- **Negative control, published v3.1.3:** Desktop cold boot works; disabling entire bundle changes token authentication `303→404`, anonymous `/`, `/connect`, `/api` to `404`; independent Host probe remains `200`.
- **Candidate, published v3.1.3 + only the above overlay change:** Desktop cold boot works. After disabling bundle, token authentication returns `303`, anonymous index/connect/API subpath return `401`, Host probe `200`. A transient `/api` request timeout resolves to `401` on bounded retry.
- **Disable → re-enable in same Electron session:** the same six Host routes pass their expected `303/401/200` checks after bounded retries, and the bundle is again present in the active profile. An extra assertion looking for the Vision toggle in the *plugin details page* timed out; do **not** count that as verified client re-mount.
- **Complete functional Vision E2E in a separate fresh profile:** actual image reaches the vision adapter, an Agent tool call completes, and Desktop renders `DESKTOP_VISION_E2E_OK`; exit `0`, result `ok:true`.

These are observations on the **v3.1.3 candidate**; this branch is rebased on DVR main v3.1.4 purely to preserve an inspectable patch and **has not yet passed the same Electron matrix on v3.1.4**. This experimental branch does **not** demonstrate Mac/Linux/Node 22 support or persistent reconnection across multiple cycles.

## Why this cannot replace the default patch

Verified official DSH release sources:

| DSH Host | Native Connection injection | Host-owned trust expression |
|---|---|---|
| `dsh-v0.1.7-rc.2` | `[webRuntime]` | `ctx.webRuntime.trustedHosts` |
| `dsh-v0.2.0-rc.2` | `[webRuntime]` | `ctx.webRuntime.trustedHosts` |
| `dsh-v0.2.2-rc.1` | `[webStartup]` | `ctx.webStartup.trustedHosts` |

The legacy Web Runtime may add bind-derived LAN authorities absent in the newer startup list. DVR currently supports *both* generations with a private ready bridge. Its `dsh.bundle.patch` is a **static file** shared across supported hosts. Substituting the modern-only `webStartup` expression globally would regress older supported deployments, even though it fixes the modern Host's HMR disable case.

**Release gate:** preserve the existing default DVR compatibility overlay until either (a) DSH upstream HMR correctly rebuilds the changed Fiber and has been qualified across supported Host versions; or (b) a separate, rigorously tested Host-capability-specific patch selection mechanism exists. Do not lower trusted-host checks, silently drop old Host support, or merge this experiment by default.

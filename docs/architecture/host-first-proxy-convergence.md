# Host-first Proxy Convergence

Status: **H0 + H1 implemented without raising the DSH support floor**

H1 baseline: `main@9fb7f1736813f1f5c63c1f0e8214eb12a779f24e`

## Decision

Network egress is a Host concern, not a vision-routing concern. Vision Router therefore treats DSH/Host as the default network authority and keeps its own proxy only as an explicit, vision-only compatibility/advanced override.

`proxy: ''` means **do not override transport**. Router-owned HTTP calls pass no private dispatcher; Host-owned visual providers bypass the legacy global-fetch proxy seam. Whatever path DSH/Host currently owns — direct, environment proxy, or a lower-level TUN — remains authoritative.

An explicit non-empty `proxy` keeps the existing Vision Router behavior for users who need a different route for selected `proxyHosts`, including legacy SOCKS5 configurations. Persisted settings are not migrated or rewritten.

## Why this direction

DSH's 0.1.5 line introduced a process-wide outbound proxy subsystem (`@deepseek-ai/dsh-http-proxy`) with one Host policy and a public `proxyRouteFor()` transport seam. Keeping a second generic proxy authority inside Vision Router would duplicate routing, redirect, dispatcher-lifecycle, and ownership policy.

The production plugin does not import or require that Host package. The current public support window still includes older DSH releases, and the upstream package contract explicitly says ordinary `fetch()` callers should do nothing: the Host global dispatcher already owns routing. Calling `proxyRouteFor()` is reserved for consumers that must branch on proxy state or own a transport that cannot use normal fetch. H1 therefore adopts the Host capability by preserving plain fetch and proving the behavior against exact Host source, rather than adding a second route decision.

## Compatibility matrix

| Host / user state | Authority after H0 | Vision Router behavior |
|---|---|---|
| Any supported Host, `proxy=''` | DSH/Host | inject no dispatcher; legacy global seam bypassed |
| Older Host, explicit `proxy` | Vision Router for matching vision hosts | preserve current ProxyAgent compatibility path |
| DSH 0.1.5-line Host, explicit `proxy` | Vision Router override for matching vision hosts | explicit dispatcher wins for that request |
| SOCKS5 / legacy `socks5h` override | Vision Router | preserved; `socks5h` is projected at the Undici boundary |
| Non-matching `proxyHosts` | DSH/Host | no plugin dispatcher and no Undici import |

## H0 invariants

1. Blank/whitespace `proxy` never enables the legacy global proxy seam.
2. Blank `proxy` never imports Vision Router's userland Undici ProxyAgent.
3. Router-owned HTTP with blank `proxy` calls the captured Host fetch without an explicit dispatcher, so ambient Host dispatcher changes remain visible at request time.
4. Explicit `proxy` remains live-editable and preserves `proxyHosts` narrowing.
5. No schema migration, no setting rewrite, no DSH peer-range increase, and no new dependency on `@deepseek-ai/dsh-http-proxy`.
6. The legacy seam remains available only for the intersection: explicit plugin proxy **and** Host-owned/raw-fetch visual provider.

## H1 — Host capability adoption

H1 is complete as an egress contract, not as a new production dependency. Exact DSH source gates now run a local fake proxy through the Host's real `installProxyFromEnvironment()` implementation and drive Vision Router's shipping provider transport with `proxy: ''`. The contract proves all of the following:

1. Host proxy policy receives Vision Router egress while Vision Router reports no private override and never imports its ProxyAgent.
2. Host `NO_PROXY` remains authoritative for a bypassed target.
3. A redirect from a proxied origin to a `NO_PROXY` origin is re-evaluated by the Host dispatcher per hop; the first-hop proxy decision is not pinned across the redirect.
4. The same contract runs against the exact current stable Host and exact preview evidence on Linux, macOS, and Windows through the existing source-contract matrix.
5. Production code contains no `@deepseek-ai/dsh-http-proxy` dependency or import. `proxyRouteFor()` is used only by the exact-source test as an oracle for the Host decision.

The current stable evidence advances to DSH `0.1.5-rc.2`; `0.1.5-rc.1` remains explicitly peer-admitted, and the public minimum remains `0.1.0-rc.8`.

## Next phases

### H2 — Retire the process-global compatibility patch

Delete the legacy `globalThis.fetch` proxy patch only after every supported Host-owned visual provider has a scoped/shared Host transport path. The deletion test must prove the old closure cannot rescue production traffic.

### H3 — Re-evaluate the plugin override

Once the support floor and Host capabilities cover normal proxy needs, decide whether `proxy` / `proxyHosts` remain as an advanced SOCKS/selective override, move behind an explicit legacy toggle, or are deprecated in a major release. Do not remove them in a patch/minor release while supported users still depend on them.

## System proxy terminology

Vision Router must not implement OS-specific proxy discovery. DSH's 0.1.5 network guide distinguishes OS “system proxy” settings, standard proxy environment variables, and TUN mode; DSH itself follows the environment policy and does not automatically read macOS/Windows system-proxy switches. Host-first therefore means “follow DSH/Host”, not “reimplement operating-system proxy detection in this plugin”.

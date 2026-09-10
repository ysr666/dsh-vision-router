# Host-first Proxy Convergence

Status: **approved migration direction; Phase H0 implemented without raising the DSH support floor**

Baseline: `main@e39eaa72c7c1ee56d3f5d0043781e56f357c68a3`

## Decision

Network egress is a Host concern, not a vision-routing concern. Vision Router therefore treats DSH/Host as the default network authority and keeps its own proxy only as an explicit, vision-only compatibility/advanced override.

`proxy: ''` means **do not override transport**. Router-owned HTTP calls pass no private dispatcher; Host-owned visual providers bypass the legacy global-fetch proxy seam. Whatever path DSH/Host currently owns — direct, environment proxy, or a lower-level TUN — remains authoritative.

An explicit non-empty `proxy` keeps the existing Vision Router behavior for users who need a different route for selected `proxyHosts`, including legacy SOCKS5 configurations. Persisted settings are not migrated or rewritten.

## Why this direction

DSH's 0.1.5 line introduced a process-wide outbound proxy subsystem (`@deepseek-ai/dsh-http-proxy`) with one Host policy and a public `proxyRouteFor()` transport seam. Keeping a second generic proxy authority inside Vision Router would duplicate routing, redirect, dispatcher-lifecycle, and ownership policy.

The plugin must not import or require that Host package yet: the current public support window still includes older DSH releases. H0 changes semantics only where behavior was already effectively a no-op and adds tests proving Host inheritance.

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

## Next phases

### H1 — Host capability adoption

When the minimum supported DSH window can safely expose the Host proxy seam, detect/use the Host-owned route directly rather than inferring network behavior. Characterize parity against real DSH egress tests first. Do not silently change SOCKS or selective-domain behavior.

### H2 — Retire the process-global compatibility patch

Delete the legacy `globalThis.fetch` proxy patch only after every supported Host-owned visual provider has a scoped/shared Host transport path. The deletion test must prove the old closure cannot rescue production traffic.

### H3 — Re-evaluate the plugin override

Once the support floor and Host capabilities cover normal proxy needs, decide whether `proxy` / `proxyHosts` remain as an advanced SOCKS/selective override, move behind an explicit legacy toggle, or are deprecated in a major release. Do not remove them in a patch/minor release while supported users still depend on them.

## System proxy terminology

Vision Router must not implement OS-specific proxy discovery. DSH's 0.1.5 network guide distinguishes OS “system proxy” settings, standard proxy environment variables, and TUN mode; DSH itself follows the environment policy and does not automatically read macOS/Windows system-proxy switches. Host-first therefore means “follow DSH/Host”, not “reimplement operating-system proxy detection in this plugin”.

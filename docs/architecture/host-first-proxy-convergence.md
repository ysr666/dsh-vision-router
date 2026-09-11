# Host-first Proxy Convergence

Status: **H0 + H1 + H2 + H3 complete without raising the DSH support floor**

H1 baseline: `main@9fb7f1736813f1f5c63c1f0e8214eb12a779f24e`

H2 merged: `main@40b43d78b7c105c19188059172c2883eea9e681c`

## Decision

Network egress is a Host concern, not a vision-routing concern. Vision Router therefore treats DSH/Host as the default network authority and keeps its own proxy only as an explicit, vision-only compatibility/advanced override.

`proxy: ''` means **do not override transport**. Router-owned HTTP calls pass no private dispatcher, and the Host-owned compatibility wrapper stays transparent. Whatever path DSH/Host currently owns — direct, environment proxy, or a lower-level TUN — remains authoritative.

An explicit non-empty `proxy` keeps the existing Vision Router behavior for users who need a different route for selected `proxyHosts`, including legacy SOCKS5 configurations. Persisted settings are not migrated or rewritten.

## Why this direction

DSH's 0.1.5 line introduced a process-wide outbound proxy subsystem (`@deepseek-ai/dsh-http-proxy`) with one Host policy and a public `proxyRouteFor()` transport seam. Keeping a second generic proxy authority inside Vision Router would duplicate routing, redirect, dispatcher-lifecycle, and ownership policy.

The production plugin does not import or require that Host package. The current public support window still includes older DSH releases, and the upstream package contract explicitly says ordinary `fetch()` callers should do nothing: the Host global dispatcher already owns routing. Calling `proxyRouteFor()` is reserved for consumers that must branch on proxy state or own a transport that cannot use normal fetch. H1 therefore adopts the Host capability by preserving plain fetch and proving the behavior against exact Host source, rather than adding a second route decision.

## Compatibility matrix

| Host / user state | Authority after H0 | Vision Router behavior |
|---|---|---|
| Any supported Host, `proxy=''` | DSH/Host | inject no dispatcher; compatibility wrapper is transparent |
| Explicit `proxy` + Router-owned HTTP | Vision Router for matching vision hosts | provider-scoped dispatcher; no global interception |
| Explicit `proxy` + Host-owned visual adapter | Vision Router only inside that visual adapter call | AsyncLocalStorage-scoped dispatcher interception |
| `routing=true` + explicit blank `chainRoute` + Host-owned provider | Vision Router legacy compatibility | narrow unscoped direct whole-turn fallback retained until H3 |
| SOCKS5 / legacy `socks5h` override | Vision Router | preserved; `socks5h` is projected at the Undici boundary |
| Non-matching `proxyHosts` | DSH/Host | no plugin dispatcher and no Undici import |

## H0 invariants

1. Blank/whitespace `proxy` never authorizes the legacy proxy compatibility wrapper.
2. Blank `proxy` never imports Vision Router's userland Undici ProxyAgent.
3. Router-owned HTTP with blank `proxy` calls the captured Host fetch without an explicit dispatcher, so ambient Host dispatcher changes remain visible at request time.
4. Explicit `proxy` remains live-editable and preserves `proxyHosts` narrowing.
5. No schema migration, no setting rewrite, no DSH peer-range increase, and no new dependency on `@deepseek-ai/dsh-http-proxy`.
6. The legacy compatibility seam is relevant only for the intersection: explicit plugin proxy **and** Host-owned/raw-fetch visual provider.

## H1 — Host capability adoption

H1 is complete as an egress contract, not as a new production dependency. Exact DSH source gates now run a local fake proxy through the Host's real `installProxyFromEnvironment()` implementation and drive Vision Router's shipping provider transport with `proxy: ''`. The contract proves all of the following:

1. Host proxy policy receives Vision Router egress while Vision Router reports no private override and never imports its ProxyAgent.
2. Host `NO_PROXY` remains authoritative for a bypassed target.
3. A redirect from a proxied origin to a `NO_PROXY` origin is re-evaluated by the Host dispatcher per hop; the first-hop proxy decision is not pinned across the redirect.
4. The same contract runs against the exact current stable Host and exact preview evidence on Linux, macOS, and Windows through the existing source-contract matrix.
5. Production code contains no `@deepseek-ai/dsh-http-proxy` dependency or import. `proxyRouteFor()` is used only by the exact-source test as an oracle for the Host decision.

The current stable evidence advances to DSH `0.1.5-rc.2`; `0.1.5-rc.1` remains explicitly peer-admitted, and the public minimum remains `0.1.0-rc.8`.

## H2 — Scope Host-owned override authority

H2 retires the **configuration-wide proxy authority** without removing the compatibility feature. Core no longer constructs ProxyAgent instances or installs its own process proxy patch. One compatibility wrapper remains outside runtime composition, but its default behavior is an exact pass-through to the DSH/Host fetch chain that existed when it was installed.

For DVR-owned calls into a Host adapter, `streamWithLegacyGlobalProxyScope(provider, model, ...)` keeps an AsyncLocalStorage authorization alive across lazy AsyncIterable creation and every `next()` / `return()` / `throw()` operation. The wrapper injects a private dispatcher only when the live settings still contain an explicit proxy and the active scope exactly matches a configured Host-owned vision pair. Vision-chain adapter calls, `vision_describe`, capability Benchmark and Exact Check use this same boundary. Router-owned direct HTTP continues through `VisionProviderTransport` instead.

H2 regression proof includes a deliberately blocked Host-owned visual stream plus a concurrent same-origin ordinary Host fetch. The ordinary request receives no DVR dispatcher; only the visual request receives the marked ProxyAgent dispatcher after its stream resumes. Clearing the proxy while the visual stream is active immediately returns later requests to Host authority.

One unscoped compatibility case remains intentionally: `routing=true` with an explicitly blank `chainRoute` routes the whole image turn directly to the first Host provider after the DVR routing hook returns, so there is no DVR-owned adapter-iteration boundary to scope. H2 preserves that old configuration narrowly rather than silently breaking it in a patch release.

## H3 — Product contract for the override and last wrapper

H3 decides to **keep `proxy` / `proxyHosts` supported and non-deprecated** as a local-only Advanced override. No extra “legacy proxy” toggle is added: blank `proxy` is already the opt-out/default, the controls are already behind Advanced and local-only, and another authority bit would make the settings contract harder to reason about without removing the compatibility boundary.

This is a current capability decision, not inertia. The H3 audit on 2026-09-11 checked DSH `0.1.5-rc.2` plus upstream `master@c291e7961a515f6d7af9304e7fd1d257929aef26`: `@deepseek-ai/dsh-http-proxy` still accepts only `http:` / `https:` and explicitly diagnoses SOCKS-family URLs as unsupported. The Host LLM adapter surface at that revision also still has no generic per-call dispatcher/transport input that a plugin can pass through `ctx.llm.stream()`. DVR issue #455 provides current Windows + DSH 0.1.5-rc.1 user evidence that `socks5://` plus selective `proxyHosts` is a real supported deployment shape. Removing the override now would therefore remove capability, not merely delete compatibility code.

The remaining unscoped `routing=true` + explicit `chainRoute=''` behavior is classified as **legacy persisted/manual-config compatibility only**. Current Settings does not create that state: leaving `chainRoute` blank clears the user-layer override, so the schema default `vision-chain` becomes effective again. Existing persisted/manual explicit-empty values continue to work in this support window; H3 neither migrates nor rewrites them. Public documentation must not teach “leave `chainRoute` blank to disable” as a current Settings workflow.

The final Host-owned compatibility wrapper remains justified until both conditions are satisfied: (1) Host-owned adapter calls can receive the DVR-specific override through a scoped Host transport/dispatcher seam, or the DVR override is intentionally removed under a future announced product policy; and (2) the legacy direct whole-turn explicit-empty `chainRoute` state has been migrated or retired under the applicable support-window policy. A Host release that merely has a global HTTP(S) proxy does not satisfy those conditions.

## System proxy terminology

Vision Router must not implement OS-specific proxy discovery. DSH's 0.1.5 network guide distinguishes OS “system proxy” settings, standard proxy environment variables, and TUN mode; DSH itself follows the environment policy and does not automatically read macOS/Windows system-proxy switches. Host-first therefore means “follow DSH/Host”, not “reimplement operating-system proxy detection in this plugin”.

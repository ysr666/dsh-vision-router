# P3-D Host-native seam migration evaluation

Decision date: 2026-08-28

Support window: DVR `2.0.x` / minimum DSH `0.1.0-rc.6` / previous `0.1.0-rc.8` / current `0.1.1-rc.2`.

P3-D permits a migration only when all four conditions are true:

```text
official API stable
+ minimum Host supports it
+ parity proved
+ replacement is simpler
```

Current result: **NO NEW HOST-NATIVE MIGRATION IS AUTHORIZED IN DVR 2.0.x.**

| Candidate | Current evidence | Decision |
|---|---|---|
| settings exposure | Newer Hosts expose stronger live settings seams, but rc.6 remains the minimum and existing compatibility is still required for the supported window | NO-GO in 2.0.x |
| provider transport / proxy | P2-D moved Router-owned HTTP to `VisionProviderTransport`; P2-E reduced the global patch to Host-owned/raw-fetch compatibility. The minimum Host still has no proven provider-scoped/shared proxy seam | KEEP P2 boundary; no native migration |
| `ctx.jobs` | P2-F's ten-point spike found that Jobs does not replace DVR's priority, authority-revoke, topology-abort and evidence-publication fencing without retaining the custom scheduler | NO-GO; retain current scheduler |
| adapter registration replacement | Current Host generations expose better replacement behavior, but a read-only capability probe cannot prove a stable returned handle across the full minimum/previous/current window | NO-GO until minimum Host contract and parity tests prove one handle contract |
| scoped tool execution hooks | Current DSH has richer tool pipeline seams, but the rc.6 support floor and existing mature wrapper behavior mean a migration would be a split-path compatibility rewrite rather than simplification | NO-GO in 2.0.x |

## Important distinction

P3-D is not a requirement to consume every API present on upstream `main`. A seam visible only on a development/canary Host does not satisfy the support-window rule.

Likewise, a native seam that still requires DVR to keep the old implementation for the minimum Host fails the "replacement is simpler" criterion unless the split itself has a concrete product or reliability benefit.

## Revisit trigger

Re-run this matrix when one of these occurs:

1. DVR 2.1.0 actually raises the minimum Host to rc.8;
2. a released DSH train exposes a provider-scoped/shared proxy contract;
3. adapter replacement or tool-execution hooks become stable on the declared minimum Host;
4. upstream Jobs semantics materially change enough to satisfy the P2-F go criteria.

## P3-D verdict

`PASS — evaluated; no migration currently meets the plan's four mandatory conditions.`

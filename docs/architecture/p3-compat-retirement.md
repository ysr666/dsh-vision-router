# P3-B compatibility retirement audit

Decision date: 2026-08-28

Status: historical P3-B audit snapshot. It records the 2.0.x support policy in force at the decision date; it is **not** the current Host support policy. See [`dsh-support-window.md`](dsh-support-window.md) for the normative current policy and verification evidence.

DVR train at decision time: `2.0.x`

Minimum supported Host at decision time: DSH `0.1.0-rc.6`

## Result

**NO COMPAT DELETION IS CURRENTLY AUTHORIZED.**

P3-B is intentionally a retirement audit, not a quota to delete files. Under the 2.0.x support window in force at the decision date, every Host-generation compatibility seam that materially exists for rc.6/rc.8 users still has a reachable support case.

## Seam review

| Seam | Why it still exists in 2.0.x | Earliest retirement trigger |
|---|---|---|
| attachment contract / Android attachment fallback | rc.6 remains the minimum and does not provide the later batch-attachment contract used by the modern path | after the released minimum Host no longer needs the single-attachment/permission fallback and the replacement is proven on the new minimum |
| Host settings compatibility | rc.6 remains supported; live settings/client behavior differs across the support window | after the new minimum exposes the stable settings seam used by DVR without compatibility wrapping |
| rc.8 browser/client lifecycle compatibility | rc.8 is still inside the declared support window and was the Previous Supported Train at the decision date | only after rc.8 itself leaves the support window or the same path becomes unreachable by capability proof |
| replay envelope v2 compatibility | old durable histories remain valid inputs even when the live Host is newer | only when the supported history/runtime window no longer needs producer rebinding or Host provides an equivalent native replay identity seam |
| adapter prepareCall/coalescing compatibility | the support matrix still spans Host generations with different adapter-registration/update behavior | only when the minimum Host and every DVR-owned adapter satisfy one stable registration/update contract |
| pi-ai bridge wire compatibility | legacy direct-bridge traffic remains a supported route shape | only after the direct bridge is retired or all supported Hosts execute that path through an equivalent native wire seam |
| process-global proxy compatibility | Host-first H0/H1 makes DSH/Host authoritative whenever plugin `proxy` is blank; the seam remains only for an explicit Vision Router proxy override + Host-owned/raw-fetch visual provider | when that explicit override no longer needs process-global mutation for supported Host-owned providers, or the override is retired/re-scoped by product policy |

## First planned deletion window

The announced DVR 2.1.0 floor is DSH `0.1.0-rc.8`. That boundary makes **rc.6-only** compatibility candidates eligible for a fresh deletion audit, but it does not automatically delete them.

Each deletion still requires proof on:

- minimum Host;
- current Host;
- process restart / cold resume;
- settings read/write behavior;
- native multimodal coexistence;
- tool registration and execution;
- Node 22 and Node 24;
- Ubuntu, macOS and Windows where the seam affects runtime/platform behavior.

## P3-B verdict

`PASS — no expired seam under the 2.0.x support window in force at the decision date.`

Deleting a still-supported rc.6 seam merely to make the compatibility inventory smaller would violate the P3 plan and the published 2.0.x compatibility contract.

# P3-E native request recovery vs Vision Chain

Decision date: 2026-08-28

Upstream evidence baseline: DeepSeek Harness `main@cd5ef8148158c3a752a658978873241fdf8e2bbc` (`dsh@0.1.2-alpha.1` release merge) plus the released support window used by DVR 2.0.x.

## Question

Can DSH-native `agent/request`, `agent/request-error`, `llm/stream` and Host retry semantics replace DVR's mature synthetic `vision-chain` without losing behavior?

## Result

**KEEP `vision-chain`.**

The upstream retry executor is intentionally an agent-loop request-recovery mechanism. It handles a failed model request at the open-step `agent/request-error` boundary and re-runs that step under the selected provider's retry policy. Its own package contract states that it does **not** wrap the streaming call itself and that direct `ctx.llm.stream()` consumers remain single-attempt.

That is useful Host behavior, but it is not the same execution problem as DVR's visual backend chain.

## Required semantic comparison

| Required DVR behavior | Native recovery fit | Finding |
|---|---|---|
| cross-provider fallback | insufficient | Host retry is provider-policy request recovery; DVR must deliberately move across visual backends/providers |
| shared total deadline | insufficient as replacement | DVR owns one visual-task deadline across multiple backend attempts; independent Host retries can add latency/budget unless separately fenced |
| fair per-backend budget | insufficient | DVR reserves bounded attempt budgets so one backend cannot consume the whole visual task |
| circuit breaker | not replacement-equivalent | DVR breaker is backend/deployment-aware and integrated with fallback selection |
| exact route identity | partial | Host retry preserves/reconstructs a request identity, but DVR also needs exact candidate/deployment identity while changing backends |
| no retry amplification | risk | stacking provider retry with DVR fallback can multiply attempts unless one layer is explicitly disabled/fenced |
| cancellation | supported by Host retry, already supported by DVR | not a simplification by itself |
| v1/legacy Host | insufficient | DVR 2.0.x still supports rc.6; current upstream recovery semantics cannot become the sole path |

## Why a split modern path is not adopted

A modern-Host-only native recovery branch would still need DVR's own:

- cross-provider candidate loop;
- shared total deadline;
- per-attempt budget;
- breaker/failure classification;
- exact deployment identity;
- cancellation fencing;
- legacy/minimum-Host path.

That creates two recovery authorities without deleting the hard part of the current executor. It therefore fails the P3 migration rule that a Host-native replacement must be semantically equivalent **and simpler**.

## Interaction with Host retry

DVR should continue to treat Host retry as an outer/adjacent Host concern and keep its own visual chain from accidentally amplifying retries. Future work may consume a more explicit Host recovery decision seam if DSH exposes one that can coordinate provider changes and total budgets, but this evaluation does not authorize such a rewrite.

## Revisit trigger

Re-run the spike only if released DSH adds a recovery contract that can explicitly express or delegate:

- provider replacement;
- one shared request-family deadline;
- bounded attempt accounting;
- cancellation/disposal quiescence;
- durable identity across changed providers;
- retry/fallback composition without amplification;

and that contract exists on the declared minimum supported Host.

## P3-E verdict

`PASS — KEEP vision-chain; native request recovery is not a simpler semantic replacement.`

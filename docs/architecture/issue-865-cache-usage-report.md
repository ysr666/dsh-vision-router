# #865 — collect real cache counts from an affected conversation

The draft registers a manual `/vision-cache` command with the Host Commands
service, when available. Run it in the affected Session after a response.
No API key, extra LLM request, settings change, hidden polling, or upload
is required. The official command plane records ordinary command/run and
command/done events.

It reports up to 20 committed, non-interrupted assistant responses from
the latest 10,000 events using persisted Host TokenUsage. R1/R2 are report-local
anonymous recorded provider/model pairs. No messages, route IDs, account
names, request IDs, attachment metadata or raw errors appear in the result.
A route label is not proof of the actual upstream provider.

Pinned DSH 0.2.2-rc.5 documents disjoint input/cache-read/cache-write counts.
A hit ratio requires explicit read and reconcilable total, output and input
counters. Absent write must be consistent with zero; malformed write is
rejected. Missing or inconsistent fields are unknown, not automatic misses.
Background vision calls, failed/uncommitted retries and interrupted responses
are not represented. This is not a complete billing statement.

Collect reports in the same long conversation with Vision continuously OFF,
then ON, then OFF again, including ordinary continuation turns per state.
Record transition positions separately. Do not clear cache, delete history,
or infer actual monetary savings from aggregate input volume. Live controlled
comparisons require authorized usage/billing evidence.

## Offline full-call inventory comparison (Draft #885)

The local-only `scripts/issue-865-cache-ab-report.mjs` accepts each provider
response in one of four classes: `main`, `vision`, `title`, or `retry`.
This includes title/retry costs in the submitted A/B totals rather than
silently reporting only main Session responses.

To check whether a dataset omits extra calls, optionally provide a strictly
redacted gateway-derived count summary alongside the observations:

```json
{
  "schema": "dvr-cache-ab-v1",
  "observations": [
    {"case":"example","trial":1,"variant":"before","call":"main",
     "routeTag":"opaqueRoute","modelTag":"opaqueModel",
     "usageSource":"provider-response",
     "inputTokens":10,"cacheReadTokens":90,"outputTokens":7,"totalTokens":107},
    {"case":"example","trial":1,"variant":"after","call":"main",
     "routeTag":"opaqueRoute","modelTag":"opaqueModel",
     "usageSource":"provider-response",
     "inputTokens":10,"cacheReadTokens":90,"outputTokens":7,"totalTokens":107}
  ],
  "callInventory": [
    {"case":"example","trial":1,"variant":"before",
     "main":1,"vision":0,"title":0,"retry":0},
    {"case":"example","trial":1,"variant":"after",
     "main":1,"vision":0,"title":0,"retry":0}
  ]
}
```

A missing title/retry/vision row causes
`callCoverage.allSubmittedCallsReconciled=false` and
`evidenceLevel.fullSessionBilledCostReconciled=false`. Each row needs its
own actual billed-CNY export to support a full-billing conclusion.
Route/model mismatch or incomplete paired trials also prevent a comparable
full-session billed-cost claim.

**Privacy and provenance:** this is user-supplied count reconciliation, not
an independently authenticated gateway export. If a call is absent from both
the observations and claimed inventory, the tool cannot detect it.
The analyzer refuses secret fields/request IDs and makes no provider calls.

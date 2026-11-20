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

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


## Controlled live cache A/B comparison (offline tool)

The optional scripts/issue-865-cache-ab-report.mjs compares REDACTED,
request-level provider Usage and optionally itemized billed cost. It does not
send requests, read credentials, touch conversation history, or upload files.
It is an analysis aid, NOT evidence that a live test was executed.

Use two local, isolated DSH environments pinned to the same Host version,
account, actual upstream model, reasoning effort, prompts, history and images:
a known baseline and the integration-only #873 test candidate. Do not merge
or release #873. Warm up consistently, then capture at least three paired
continuations per scenario: pure text, Vision ON without an image, image and
follow-up, and a resumed long history. Include ALL primary and delegated
vision calls, retries and charged attempts. Prefer actual request-level
provider Usage and itemized provider-billing exports; a model alias, aggregate
dashboard totals, or the manual /vision-cache report do not capture these
extra calls or prove the real network origin. Never put keys, prompts, images,
full account names, request IDs or raw Session events into input files or CI.

The JSON shape is:
  { "schema":"dvr-cache-ab-v1", "observations":[ ... ] }
Each observation is one request and includes short pseudonymous case,
positive integer trial, variant before/after, call main/vision, opaque routeTag
and modelTag for the ACTUAL upstream route, usageSource provider-response or
provider-dashboard, inputTokens, outputTokens, totalTokens, and optionally
cacheReadTokens, cacheWriteTokens, wirePrefixSha256. To report billed money,
each call needs billedCny as a decimal STRING plus
billingSource="provider-billing-export". A separate vision model may carry a
different route/model tag; all its additional calls still count. The schema
rejects unexpected fields to reduce accidental disclosure.

Local invocation:
  node scripts/issue-865-cache-ab-report.mjs --input /private/path/redacted-provider-requests.json
  node --test tests/issue-865-cache-ab-report.test.js

The analyzer excludes unpaired trials and mismatched MAIN model identities.
It flags changed/unknown wire-prefix hashes and does not claim causal effects
merely from token counts. Explicit noncached-input, output and any present cache-read/write counters
must not exceed the provider-reported total; impossible records are rejected
before even a billed-cost comparison. Missing counters that still admit a
consistent total remain UNKNOWN, not zero.

Cache-hit percentages require reconciled disjoint
counts; missing read counts are UNKNOWN, not zero. Monetary differences are
UNKNOWN unless every included call has billed evidence. Even a valid A/B is
not proof of generalizable savings: provider caching is best effort, and
provenance labels are supplied by the operator, not authenticated by the
script.

No paid DeepSeek canary was executed by this change. The missing evidence
remains a connected, authorized environment and genuine provider usage and
billing receipts.


### DeepSeek native final-usage input

Provider Usage naming varies by API. This offline tool also accepts an
observation with usageSource="deepseek-messages-final" and a sanitized
usage object containing ONLY these four fields from the completed Messages
response: input_tokens (cache MISS), cache_read_input_tokens (cache HIT),
cache_creation_input_tokens (currently 0), output_tokens. It computes the
disjoint total without adding the provisional message_start count. For
streamed Messages, use the final message_delta usage after a completed
message_stop, not message_start or a partial stream.

For Chat Completions use usageSource="deepseek-chat-final" with a
sanitized usage object containing ONLY prompt_tokens,
prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens and
total_tokens. Those fields must reconcile (prompt = hit + miss and total =
prompt + completion). Do not mix native fields with DSH-normalized fields
in the same row; the parser rejects that ambiguity. Do not copy full API
responses (messages, identifiers, output, service-tier metadata) into the
file. The operator must extract only the listed non-sensitive count fields.

Official field contracts:
- https://api-docs.deepseek.com/api/create-message/
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/guides/anthropic_api/

All usageSource labels are an operator assertion rather than verified
network provenance. Actual per-request billing is still required to
establish money savings, and missing calls cannot be inferred away.

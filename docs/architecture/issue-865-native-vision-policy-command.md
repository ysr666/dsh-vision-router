# Issue #865 — native multimodal Vision policy command (Phase B1)

This increment creates an **official Host-authorized command** and does **not**
change the composer UI or replace legacy text-only image-admission routes.

The existing composer 👁 control currently calls
`ModelDirectory.select(provider-vision)`, coupling DVR tool privileges to a
change of the selected LLM adapter. This unnecessarily changes the provider
identity for models already able to consume raw image blocks.

Official DSH provides a separate `ctx.commands.register()` registry. Its
`ctx.remote.commands.execute(sessionId, '/vision-router on', [])` invocation
is bound to the authorized Session Agent, logged as command activity, and does
not submit a new model-facing prompt. DVR registers `/vision-router on|off|status`
only when the Host mounts `commands`.

For a native-image-capable model:

- `on` verifies the current **exact** provider/model through
  `ctx.llm.resolveModelInfo()`, checks actual `inputModalities`, and writes
  an explicit `userSessionVisionPolicy(true)` for the selected Agent's own
  Session. It never changes `Agent.model`, registers a twin or grants tools
  to another Session.
- `off` changes that DVR tool and prompt authorization only.
  **The native model still accepts raw images** even with DVR precision tools
  disabled. This is not a global "blind the native model" policy.
- Unavailable source model metadata, disabled DVR tools, rejected storage,
  stale selection during asynchronous capability lookup and cross-Session
  identity mismatches fail closed. Text-only models retain the old
  `*-vision` admission route; this command is not an image input workaround.

The existing `SessionVisionModeBoundary` already prefers explicit
`SessionVisionPolicyStore` over route-derived fallback when projecting
DVR-owned tools. Other plugins' tools are not affected. Existing model picker
events may update the policy, preserving the user's explicit choice.

## Blocking Phase B2 (composer UI)
The current DSH `ModelCatalogModel` Browser contract includes
`id/name/description/reasoning/badge`, **not `inputModalities`**, so the
client cannot reliably decide which selected models are native multimodal by
guessing route suffixes or model names. The durable policy currently lives in a
Host-side per-Session sidecar without a browser-observable projection. Before
using the command in the composer, provide **an authoritative live Session
state view** of native-image ability and explicit VisionPolicy, and handle
cold resume, concurrent commands, another-tab updates and model-picker changes.
Only then can the UI replace route switching on native models; keep the
existing pair selection for text-only models.

**Do not poll `/vision-router status` from the browser.** DSH Commands is a
mutation/interaction protocol: even a read-only command execution produces
`command/run` and `command/done` Session events. Repeating it on renders,
focus changes, or timers would inflate durable Session logs, interfere with
source-prefix accounting and introduce needless concurrency. Phase B2 needs
an authenticated **read-only state projection with change notifications**
(and a separately authorized mutation entry), not a slash-command-as-polling
shortcut. This is why the browser button is deliberately unchanged in B1.

This Stage B1 command does not yet guarantee zero extra provider cache misses:
Vision OFF/ON still changes the DVR-owned model-facing tools and may force a
new tool history baseline on models that support addition-only but not removal.

Do not merge, tag, publish, change formal version or release without separate
user authorization.

### B2 internal read contract (not a browser transport)

`readNativeVisionControlState` accepts a Host-authorized Agent, hydrates
the existing Session policy store when necessary, and returns a narrow,
discriminated `native | legacy | unavailable` view. It does not run a
command, append a log event, select a model, expose the internal adapter,
or write durable policy. It separates effective tool availability from
the saved user preference. Native capability must be checked against the
**same actual registered adapter object** before/after asynchronous
metadata reads; a replacement under the same provider/model must
invalidate both state reads and mutation authorization.

The actual authenticated read/subscription carrier and composer binding
remain separate work. The internal view is not a second state authority,
an exposed Remote endpoint, or proof of browser authorization.

### B2 policy invalidation feed

The existing Session sidecar now exposes an internal per-Session invalidation
subscription. It observes hot-authority writes, hydration, eviction, deletion,
and degradation to volatile mode; it does not copy policy to another store or
append a Session event. Observers cannot interrupt permission mutations;
durable queue admission precedes notifications even for reentrant listeners.
Dispose subscriptions on Session/connection retirement. Adapter/model/settings
changes and authenticated browser transport still have to be wired and tested;
this feed alone is not a browser endpoint or an authorization mechanism.

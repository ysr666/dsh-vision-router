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

### B2 Host-side live read stream (carrier still pending)

The exact Host projection seam folds committed events synchronously; it
cannot faithfully mirror an async, sidecar-owned permission or model
capability lookup. Do not synthesize Session events or consult mutable
external state from a pure projection fold. The official typed Remote
stream is a transport candidate, subject to Loader artifact generation,
Gateway Session lookup/peer authorization, and a real Browser test.

`observeNativeVisionControlState()` is the internal read-only stream for an
already-authorized live Agent. It uses the existing policy invalidation feed
and the exact Host model selection, adapter topology and DVR settings events.
It coalesces invalidations, drops stale asynchronous reads, suppresses
identical views and releases observers on iterator return, carrier abort,
Agent disposal or owning fiber retirement. It never writes a policy, runs
a status command, accepts a client-supplied Session ID or selects a model.
The exact Host Commands fixture also consumes this stream with the actual
DVR policy store in volatile mode and checks OFF→ON→OFF without extra Session
events. This is not yet a Remote registration, a Client contribution, or an
authorization/packaging acceptance test.

References (pinned DSH 0.2.2-rc.5):
- [Projection definition and snapshot rules](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/docs/subsystems/session-projection.md)
- [Remote method and gateway contract](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/docs/api-gateway.md)
- [Exact Agent model-selection fold](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/core/agent/src/model-selection.ts)

### B2.2 exact Gateway contract (test-only contribution)

The pinned Host's official API requires an Agent lookup (agentId, not an
arbitrary Session object) and matching strict Typert descriptors. Gateway
checks peer access before resolving that lookup. The command fixture now
registers a test-only read stream through the real Registry and Gateway,
checks owner OFF/ON/OFF, rejects a non-owner without a grant, rejects a grant
for another Session, rejects extra request fields, and cancels an idle stream.
The shared wire schema rejects additional response fields and never transmits
raw store rows or adapters. This is a real in-process Gateway contract, not a
WebSocket/browser test. The explicit fixture descriptor is intentionally NOT
an npm production endpoint or a generated Loader artifact. Production package
and browser contributions remain pending; no unverified custom HTTP route.

### B2.2 production Host registration

DSH's pinned typert-loader source explicitly supports manual registry
contributions for hand-written wire schemas. DVR uses that documented option
instead of adding a dependency on the Host's workspace-only generator or
publishing an untyped HTTP route. A plain Cordis service exposes the public
Typert binding; strict descriptors name the exact Session-scoped Agent lookup.
Registration is conditional on the live lookup's resource, wire field and type
symbol, and is retired with its owning fiber. Existing Commands and legacy UI
remain available on older Hosts. The same production registration replaces the
probe-only Service in the permission contract test; the public-apply fixture
also asserts OFF/ON/OFF over the real Gateway. Browser contribution mounting,
peer reconnect, and UI control are still separate acceptance gates.

### B2.2 shared mutation authority

The strict Session-scoped dvrNativeVision/set Remote takes an explicit boolean
and the provider/model identity last observed by the Client. It delegates to
the same mutator instance as /vision-router on|off (one intent fence and one
serialized mutation tail per live Agent). An obsolete Client route fails
before capability resolution or state mutation. Remote writes create no
command history; the subscription remains the source of UI truth. The
production Gateway tests exercise a Remote ON followed by a command OFF,
non-owner denial and stale selection rejection. No client UI is enabled yet.

### B2.4 Composer binding

The existing composer chip mounts the same strict descriptor over the official
client Remote assembly once per plugin fiber. Each active Session owns its own
stream; a connection reset or Session change retires the old observer. Native
route identity must match the ModelDirectory before any native action is
enabled; click sends set with the latest observed identity and never changes
the picker. Native ON/OFF is rendered only from observed Host state, not the
mutation receipt. Verified legacy routes continue using directory.select,
preserving reasoning effort. A client without the mounting API retains the
legacy path; an explicitly absent endpoint before the first frame permits
older-Host compatibility, but access denial, malformed data, disconnect or
withdrawal cannot silently become a legacy ON/OFF action. Browser codecs and
Host Zod codecs are checked against the same representative cases. Real browser
and Host integration gates remain mandatory before merge.

### B2.4 correction after real Host CI

The earlier production-read build returned unavailable on the exact current
Host while the root-scoped probe had passed. The nested Remote registration
now explicitly declares llm, rather than relying on inherited Cordis access.
The subsequent browser-helper extraction accidentally removed the local
SESSION_TYPE constant; the registration now derives the identity from the
actual shared strict descriptor. A focused production-registration test uses
a traced caller and checks lookup withdrawal cancels an active stream. The
exact Host assertions include the unavailable reason if discovery fails again.

### B lifecycle route fence and reasoning-effort control

The lifecycle boundary seeds its last provider/model from live Agent creation
and HMR reconciliation. A same-route committed effort-only event preserves a
user-owned Session permission; a genuine route change keeps legacy route
authority and supersedes delegation snapshots. The shared mutator fences its
pending work by the Session's route generation in addition to the final
registered adapter identity, rejects A-B-A during discovery, and rejects retired
Agents. Exact public-plugin test changes only effort while enhancement is ON
before testing the real agent request. The one deliberate picker event is
counted separately from the Remote/command calls.

### Minimum Host regression / effort fixture

The 0.2.1-rc.5 source uses ApiSessionAgentController.selectionFor(agent)
instead of the current Agent.model.current() API. Exact minimum Chromium and
Windows Desktop failed with the new chip's generic unavailable state. The
server now explicitly reports host-control-unsupported when the Agent shape
lacks the new accessor, and only that positive capability signal permits
the original model-picker route on an otherwise mounted Remote. Missing
selection on a supported Host, denied access and other metadata failures
remain fail-closed. The chip exposes a bounded, non-sensitive diagnostic
state attribute and separates native-state errors from absent twins. The
synthetic reasoning-effort fixture now declares the actual supported efforts.

# DSH 0.2.2-rc.1 exact-source adaptation review

Status: **DRAFT / NOT YET VERIFIED**. Do not claim DVR supports RC1 until all real Host checks, including dynamic image routing, pass.

## Provenance and source delta

- Release tag: dsh-v0.2.2-rc.1; published 2026-11-04T13:07:14Z.
- Immutable RC1 commit: 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db.
- Prior Alpha.3 exact source: 05b1cae8db6e674c5685101494d4eec24652424a.
- Git diff from Alpha.3 to RC1 changes 387 package.json versions only; no ordinary source file changed. This is a source-content comparison, not a passing runtime test.
- Cordis Core 4.1.0, Loader 1.1.0, Include 1.1.0 and Node >=24.9 are declared on RC1. Older DVR Node22 host support is preserved.

## Validation plan

The fixed RC1 gate validates exact checkout SHA and package identity, cross-platform source/Sharp and peer/security contracts, real Host with Chromium Settings save/reload/readback, cold Vision toggle, mixed attachment and bundle recompose, macOS Desktop renderer, Windows Node24.9/24.21 Desktop, and multi-plugin ordering. Alpha surveillance and earlier Host/Node22 lanes stay separate.

## P1 candidate: dynamic image routing

The RC1 Agent Loop reads the selected model *before* prompt/tool assembly and pre-step. At request preparation, RC1 packages/core/agent-loop/src/agent.ts rejects provider/model/effort modifications returned by agent/request (lines 630-639). DVR src/index.js still changes provider/model from agent/request when optional dynamic routing is enabled. The same upstream source existed at Alpha.3, meaning the earlier browser gate did not prove this active routing flow. A real Host regression must demonstrate a routed image turn, a following text-only turn, actual selected adapter, and no model-selection or permission drift. The documented modern mechanism, agent.model.select(), must be invoked before step preparation, not merely during agent/pre-step after selection was fixed.

Additional runtime scrutiny covers tools.resolve/executable, session-projection async registration, settings persistence, plugin disposal, source authentication and model/attachment decisions. A green generic Settings smoke alone does not close these risks.

## Fix under verification (not yet merged)

DVR now uses post-append, pre-preStep Agent inbox notifications and
running/turn-stopping boundaries to call the official Agent.model.select()
synchronously before tools.resolve fixes the step model and permissions.
It reads the true Session inbox projection rather than guessing from the
newest message. Modern agent/request handlers never mutate provider/model.
Legacy Hosts without Agent.model.select keep the previous routing path.

A text followup restores the user-selected base model only if the current
selection still matches DVR-owned image routing. Explicit manual changes
take priority. Absent projection and adapters fail closed. Tool-only mode
mounts progressive image tools before the tool-admission snapshot.
Session event is intentionally NOT used for selecting a model: Session.append
prohibits synchronous reentrant model/selection appends.

CI now verifies pinned source event ordering and runs real Desktop requests:
image to vision-chain, text followup to original provider, visible answers,
actual network requests and durable model-selection projection. Synthetic
adversarial tests cover queue, steer, offload, disable, missing adapter,
unload, and legacy nonintervention.

Still a candidate. Real Host CI and adversarial review must pass before a
public compatibility claim or release.

## Real RC1 Desktop evidence from first audit run

On Windows Node24.21 with RC1 exact Host, the real Desktop completed the
image turn with its visible answer (DESKTOP_DYNAMIC_IMAGE_E2E_OK) and the
model picker showed vision-http/desktop-e2e/desktop-vision. The initial
Playwright selector then failed because the same answer occurred in three
places (session title, breadcrumb, assistant paragraph), NOT because the
runtime request failed. E2E now selects the assistant paragraph and accepts
either verified chain or direct vision-http source route, and continues to
require a text followup and accepted model-selection projection evidence.
A completed end-to-end pass is still pending and mandatory.

## RC1 model-switch compaction: actual failure and scoped workaround

A real RC1 Windows Desktop image request passed, but its next text request
failed with MODEL_SWITCH_COMPACTION_FAILED: the synthetic adapter declared
contextWindow=32768 and maxTokens=2048, while upstream compaction-basic
defaults to headroomTokens=65536. The destination lacks a valid budget
even for a tiny history. This is an upstream documented restriction.

For the normal return-to-text E2E use a synthetic adapter whose capacity
is 131072. This changes no actual user models. Real small-window models
must configure DSH compaction-basic.modelPolicies, e.g. headroomTokens=4096
and maxTokens=4096 for a 32768 window, or retain DVR's default tool-only
routing. Never silently inflate actual model metadata, mutate global Host
compaction settings or swallow a Host model-switch error.

// #865: Session image format request-admission authority, extracted from
// index.js to keep the product runtime beneath the source size review gate.
// No model dispatch or synthetic compatibility; this is the existing Host
// pre-step safety fence plus the explicit v2 no-identity guard.
import { hasUnstableStableV2ImageIdentity } from './core-primitives.js'
import {
  requiresVerifiedImageProjection,
  preserveClaimedMessagesOnBlockedStep,
} from './session-image-projection-mode.js'

export async function verifyImageProjectionAdmission({
  session, payload, decision, modeStore, settings, hasRetainedImage,
}) {
    // Block unflushed migration witnesses; return claimed inbox messages
    // until explicit idle maintenance re-confirms Session durability.
    if (modeStore?.isDurabilityUnverified?.(session.id)) {
      if (!payload.signal?.aborted) {
        preserveClaimedMessagesOnBlockedStep(payload.agent, payload.messages ?? [])
      }
      throw new Error(
        'Vision Router migration witness has not been durably flushed. ' +
        'Repair Session storage and retry /vision-history-stabilize CONFIRM; ' +
        'original pending input was preserved.',
      )
    }
    // Do not admit a request when this Session's existing image projection
    // cannot be verified. In DSH the pre-step waterfall runs BEFORE the first
    // request/header commit, so this is the last safe format selection gate.
    // Returning { kind: 'reject' } would discard claimed inbox messages;
    // rejecting with an error instead avoids silently continuing with a
    // different format and surfaces the storage repair requirement.
    // Keep explicitly opted-in historical v1 Sessions byte-identical.
    // New-Session opt-in chooses canonical v2; a persisted v1/v2 witness
    // always overrides later Settings changes and fork configuration.
    const newStableRequested = settings.stableImageHistoryNewSessions === true
      ? 'stable-v2' : settings.stableImageHistory === true
    // Do not commit a v2 witness on a genuinely new Session whose image lacks
    // BOTH a durable attachment ID and its source message ID. For an existing
    // witnessed v2 Session, resolution still pins v2 and the guard below
    // refuses the unsafe request rather than rewriting an old cache prefix.
    const unstableV2Identity =
      hasUnstableStableV2ImageIdentity(decision?.messages ?? payload.messages ?? [])
    const requestedProjection = newStableRequested === 'stable-v2' && unstableV2Identity
      ? false : newStableRequested
    const modeStoreNeeded = modeStore?.resolve &&
      (newStableRequested ||
        modeStore.hasStorageFacility?.() === true ||
        modeStore.get?.(session.id) !== undefined ||
        modeStore.hasCommittedWitness?.(session) === true)
    if (modeStoreNeeded) {
      const projection = await modeStore.resolve(
        session, requestedProjection,
      )
      if (projection === 'stable-v2' && unstableV2Identity) {
        if (!payload.signal?.aborted) {
          preserveClaimedMessagesOnBlockedStep(payload.agent, payload.messages ?? [])
        }
        throw new Error(
          'Vision Router stable-v2 cannot prove an image identity. ' +
          'Original pending input was requeued; obtain a durable attachment or ' +
          'message ID instead of changing the committed image-history prefix.',
        )
      }
      if (projection === 'unknown') {
        // A missing optional sidecar cannot justify rewriting *any* image
        // from a previous stable Session. Pure text turns, however, share
        // identical projection bytes in both formats and may continue safely.
        // Inspect committed raw events as well as the claimed pre-step batch;
        // a current-step-only check would miss a historical image.
        const unverifiedImageHistory = requiresVerifiedImageProjection(
          session, decision?.messages ?? payload.messages ?? [],
          (content) => hasRetainedImage(content),
        )
        if (unverifiedImageHistory) {
          // DSH AgentLoop already claimed the inbox BEFORE this waterfall.
          // Requeue the exact original messages using its public durable Inbox
          // seam before throwing. A bare throw or {kind:'reject'} would consume
          // the human input permanently while stopping the unsafe request.
          // Skip requeue if this turn was explicitly cancelled.
          if (!payload.signal?.aborted) {
            preserveClaimedMessagesOnBlockedStep(payload.agent, payload.messages ?? [])
          }
          throw new Error(
            'Vision Router cannot verify this Session image-history format; ' +
            'restore its DSH storageDomain before continuing an image-bearing request. ' +
            'Original pending input has been retained for retry after recovery.',
          )
        }
        // Do not cache a guessed legacy mode. If storage later recovers, the
        // persisted format still determines how any future image is projected.
      }
    }
}

// #865: explicit legacy -> stable-v2 transition. This is NOT silent migration.
// A running Agent must never have its historical projector changed mid-request.
// Host Agent.runMaintenance owns the genuine idle phase; Session.append uses
// official user/message surface semantics and Sessions.flush proves durability.
import {
  inspectCommittedProjectionWitnesses,
  createStableProjectionWitness,
  hasPriorModelHistory,
} from './session-image-projection-mode.js'
import { visionRouterMessageSource } from './session-message-source-compat.js'

const CONFIRM = 'CONFIRM'
const COMMAND = 'vision-history-stabilize'
const WARNING = [
  'This explicitly changes the projection of OLD image history to stable-v2.',
  'Your first subsequent model request may rebuild a large provider cache baseline.',
  'Original Session messages and image attachments are NOT deleted.',
  'Do NOT downgrade to a pre-v2 DVR binary afterward: it cannot understand the new witness.',
  'Back up your Session separately before proceeding.',
  'To approve, use /vision-history-stabilize CONFIRM when the Agent is idle.',
].join('\n')

/** Read-only; do not expose message text, attachment names, raw errors or IDs. */
export function inspectHistoricalProjectionEvents(events) {
  if (!Array.isArray(events)) return { status: 'unknown' }
  const mode = inspectCommittedProjectionWitnesses(events)
  return mode === 'stable-v2' ? { status: 'stable-v2' }
    : mode === 'stable' ? { status: 'stable-v1' }
      : { status: 'unwitnessed' }
}

/**
 * A pre-v2 binary cannot be forced by newer code to respect stable-v2.
 * This read-only decision is intended for compatible updaters/preflight UIs;
 * it must NOT be misrepresented as protection against manual overwrites.
 */
export function assessProjectionDowngrade(events, target) {
  // Capabilities, not release numbers: an older binary may predate v1 as
  // well as v2. Never call an unspecified 'old version' compatible.
  if (!['legacy-only', 'stable-v1', 'stable-v2'].includes(target)) {
    throw new TypeError('unknown target capability')
  }
  const current = inspectHistoricalProjectionEvents(events).status
  if (current === 'unknown') return { decision: 'block', reason: 'unverified-session-format' }
  if (current === 'unwitnessed') {
    // No witness does NOT prove the old projection was v1, legacy or entirely
    // image-free. A blind downgrade would promise historical wire continuity
    // that cannot be derived from the Session itself.
    return { decision: 'unknown', reason: 'no-committed-format-proof' }
  }
  if (current === 'stable-v2' && target !== 'stable-v2') {
    return { decision: 'block', reason: 'target-cannot-read-v2' }
  }
  if (current === 'stable-v1' && target === 'legacy-only') {
    return { decision: 'block', reason: 'target-cannot-read-v1' }
  }
  return { decision: 'allow', reason: 'format-recognized' }
}

export function installSessionImageStabilizeCommand(ctx, modeStore) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['commands', 'sessions'], scope => {
    if (typeof scope?.commands?.register !== 'function' ||
        typeof scope?.sessions?.flush !== 'function') return
    scope.commands.register({
      name: COMMAND,
      description: 'Explicitly stabilize an old image Session with a one-time cache reset (opt-in only)',
      input: { hint: 'CONFIRM' },
      handler: async ({ agent, rawInput, attachments, signal }) => {
        if (signal?.aborted) return { kind: 'error', text: 'Cancelled before changing the Session.' }
        if (rawInput?.trim() !== CONFIRM || (attachments?.length ?? 0) !== 0) {
          return { kind: 'error', text: WARNING }
        }
        const session = agent?.session
        if (typeof session?.id !== 'string' || !session.id ||
            session.id !== agent?.id || typeof session?.append !== 'function' ||
            typeof session?.snapshotEvents !== 'function' ||
            typeof agent?.runMaintenance !== 'function') {
          return { kind: 'error', text: 'A live Session and Host idle-maintenance capability are required.' }
        }
        try {
          return await agent.runMaintenance(async (taskSignal) => {
            if (signal.aborted || taskSignal.aborted) {
              return { kind: 'error', text: 'Cancelled before changing the Session.' }
            }
            // Never change a Session while the Host has not established a
            // previous model request; new Sessions use the separate opt-in.
            if (!hasPriorModelHistory(session)) {
              return { kind: 'error', text: 'This is a new Session; use the new-Session v2 opt-in instead.' }
            }
            const events = session.snapshotEvents()
            const status = inspectHistoricalProjectionEvents(events).status
            if (status === 'unknown') {
              return { kind: 'error', text: 'An unrecognized/conflicting format witness blocks migration.' }
            }
            if (status === 'stable-v1') {
              return { kind: 'error', text: 'This Session is pinned to stable-v1; it will not be silently converted.' }
            }
            if (status === 'unwitnessed') {
              // Do NOT trust the in-memory cache alone: after cold restart an
              // established v1 Session may have a durable v1 sidecar but no
              // explicit witness yet. Resolve the authoritative storage row
              // before admitting any format-changing migration.
              const persistedMode = await modeStore?.resolve?.(session, false)
              if (persistedMode !== 'legacy') {
                return { kind: 'error', text: 'Cannot establish a durable legacy format. Restore Session projection storage; v1/unknown history cannot be migrated.' }
              }
            }
            // The Host's authoritative checkpoint requires at least one
            // participating persistence listener. No offline/test-only fake
            // success when there is no durable backing Session store.
            if (!(await scope.sessions.flush(session))) {
              return { kind: 'error', text: 'Cannot verify durable Session storage; no migration performed.' }
            }
            if (signal.aborted || taskSignal.aborted) {
              return { kind: 'error', text: 'Cancelled before changing the Session.' }
            }
            if (status !== 'stable-v2') {
              // Single append-only, producer-attributed, model-visible witness.
              // Existing messages, attachment bytes and IDs are never changed.
              const witness = createStableProjectionWitness(
                session.id, visionRouterMessageSource(session), 'stable-v2',
              )
              session.append('user/message', witness, { surfaceOp: 'append' })
            }
            // A post-append checkpoint can fail AFTER Session.append has
            // changed the in-memory surface. Fence all later model requests
            // until an explicit retry confirms disk persistence. Never claim
            // success or silently drop this append-only witness.
            let persisted = false
            try { persisted = (await scope.sessions.flush(session)) === true } catch {}
            if (!persisted) {
              modeStore?.markUnverifiedDurability?.(session.id)
              return { kind: 'error', text: 'The witness was appended but its durability is unverified. Model requests are blocked until this command is retried after storage recovery.' }
            }
            modeStore?.markVerifiedDurability?.(session.id)
            return { kind: 'success', text: status === 'stable-v2'
              ? 'Session already uses stable-v2. Durability rechecked; no duplicate witness.'
              : 'Session now uses stable-v2. Old content was kept. Next model request may rebuild its cache; do not downgrade to a pre-v2 plugin.' }
          })
        } catch {
          // The Host may reject maintenance when a model turn owns the Agent.
          // Do not attempt a parallel, out-of-band Session mutation.
          return { kind: 'error', text: 'Stabilization unavailable or not durably confirmed. Use an idle Agent and check Session storage.' }
        }
      },
    })
  })
}

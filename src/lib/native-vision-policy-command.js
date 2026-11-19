import { userSessionVisionPolicy } from './session-vision-policy.js'
import { resolveNativeControlTarget, nativeControlTargetCurrent } from './native-vision-control-state.js'

const NAME = 'vision-router'

function modelSelection(agent) {
  try {
    return agent?.model?.current?.()
  } catch {
    return undefined
  }
}

function isSameSelection(a, b) {
  return !!a && !!b && a.provider === b.provider && a.model === b.model
}

function result(kind, text) {
  return { kind, text }
}


/** One mutation owner shared by slash commands and the Composer Remote.
 * An expected route from the observed UI is checked before recording intent,
 * so an obsolete click cannot change a newly selected model's policy.
 */
export function createNativeVisionPolicyMutator(ctx, store, { toolEnabled = () => true } = {}) {
  // A slow provider capability lookup from a previous command must not
  // override a later ON/OFF intent on the same live Agent. Weak identity
  // avoids per-Session memory growth and does not cross Session lifetimes.
  const latestIntent = new WeakMap()
  // Serializes only writes for the same live Agent; different Sessions may
  // change modes concurrently. A weak key prevents retired Agent retention.
  const mutationTails = new WeakMap()
  const routeGenerations = new WeakMap()
  const retiredAgents = new WeakSet()
  const mutate = async function mutate(agent, { enabled, selection: expected }, signal) {
    if (signal?.aborted) return result('error', 'Vision-mode command was cancelled.')
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !sessionId || agent?.id !== sessionId || typeof enabled !== 'boolean') {
      return result('error', 'Vision mode requires an authorized, active Session Agent.')
    }
    if (retiredAgents.has(agent)) return result('error', 'Vision-mode Agent is no longer active.')
    const session = agent.session
    const generation = routeGenerations.get(session)
    const routeStillCurrent = () => !retiredAgents.has(agent) && agent.session === session &&
      routeGenerations.get(session) === generation
    const selection = modelSelection(agent)
    if (!isSameSelection(selection, expected)) {
      return result('error', 'Model changed before Vision-mode validation; refresh the control.')
    }
    if (enabled && !toolEnabled()) {
      return result('error', 'DVR tools are disabled in plugin settings.')
    }
    // Record the user's ordering *before* the first asynchronous model
    // capability lookup. A late earlier lookup cannot overwrite a newer
    // successful command, even if the provider ignores AbortSignal.
    const intent = {}
    latestIntent.set(agent, intent)
    const resolved = await resolveNativeControlTarget(ctx, agent, signal)
    if (resolved.kind !== 'native') {
      return result('error', resolved.kind === 'legacy'
        ? 'The selected route is not a verified native image-capable source adapter. Keep the existing DVR vision wrapper for this provider.'
        : 'Cannot validate the current native model for this Vision-mode command.')
    }
    const { target } = resolved
    if (!routeStillCurrent() || !isSameSelection(selection, target.selection)) {
      return result('error', 'Model changed during Vision-mode validation; retry the command.')
    }
    if (signal?.aborted) return result('error', 'Vision-mode command was cancelled.')
    if (latestIntent.get(agent) !== intent) {
      return result('error', 'A newer Vision-mode command superseded this request.')
    }
    const previous = mutationTails.get(agent) ?? Promise.resolve()
    const committed = previous.catch(() => {}).then(async () => {
      // One previous write may still be awaiting durable storage. Verify
      // the actual current intent/model/registration when this command
      // finally takes the mutation slot, not merely on query completion.
      if (signal?.aborted) return false
      if (latestIntent.get(agent) !== intent) return false
      if (!routeStillCurrent() || !nativeControlTargetCurrent(ctx, agent, target)) return false
      if (enabled && !toolEnabled()) return false
      await store.set(sessionId, userSessionVisionPolicy(enabled))
      return true
    })
    mutationTails.set(agent, committed)
    let applied
    try {
      applied = await committed
    } catch {
      return result('error', 'Vision-mode policy could not be stored for this Session.')
    }
    if (!applied) {
      return result('error', 'Vision-mode command cancelled, superseded or model registration changed.')
    }
    const durabilityNote = store.durable === false
      ? ' This Host has no durable policy store; the setting may reset after restart.'
      : ''
    return result('success',
      (enabled
        ? 'DVR precision tools enabled for this Session. The selected model is unchanged.'
        : 'DVR precision tools disabled for this Session. Native image input remains available; the selected model is unchanged.') + durabilityNote)
  }
  // Only the owning Session lifecycle boundary may advance the route fence.
  // A->B->A is not the original intent even if the final route strings match.
  mutate.invalidateSession = session => {
    if (session && typeof session === 'object') routeGenerations.set(session, {})
  }
  mutate.retireAgent = agent => {
    if (agent && typeof agent === 'object') {
      retiredAgents.add(agent)
      mutate.invalidateSession(agent.session)
    }
  }
  return mutate
}

/**
 * The official DSH command plane is Session-authorized by the Host, unlike a
 * private unauthenticated HTTP endpoint. This is the Host half of a future
 * composer control that can toggle native-multimodal visual *enhancement*
 * without selecting a different model. It deliberately does NOT replace the
 * legacy text-model image-admission wrapper.
 *
 * Native pixels remain available to the native model when enhancement is OFF.
 * Only DVR-owned precision tools and instructions follow this policy.
 */
export function installNativeVisionPolicyCommand(ctx, store, options = {}) {
  if (typeof ctx?.inject !== 'function' || typeof store?.get !== 'function' ||
      typeof store?.set !== 'function') return
  const mutate = options.mutate ?? createNativeVisionPolicyMutator(ctx, store, options)
  ctx.inject(['commands'], scope => {
    scope.commands.register({
      name: NAME,
      description: 'Control DVR precision vision tools on an image-capable model without changing the selected model',
      input: { hint: 'on|off|status' },
      handler: async ({ agent, rawInput, attachments, signal }) => {
        if (signal?.aborted) return result('error', 'Vision-mode command was cancelled.')
        const action = typeof rawInput === 'string' ? rawInput.trim() : ''
        if (!['on', 'off', 'status'].includes(action)) {
          return result('error', 'Use /vision-router on, /vision-router off, or /vision-router status.')
        }
        if (Array.isArray(attachments) && attachments.length > 0) {
          return result('error', 'Vision mode commands cannot carry attachments.')
        }
        const sessionId = agent?.session?.id
        if (typeof sessionId !== 'string' || sessionId === '' || agent?.id !== sessionId) {
          return result('error', 'Vision mode requires an authorized, active Session Agent.')
        }
        const selection = modelSelection(agent)
        if (typeof selection?.provider !== 'string' || !selection.provider ||
            typeof selection?.model !== 'string' || !selection.model) {
          return result('error', 'Select a model before changing Vision mode.')
        }
        if (action === 'status') {
          if (store.get(sessionId) === undefined && typeof store.hydrate === 'function') {
            try {
              await store.hydrate(sessionId)
            } catch {
              return result('error', 'Cannot read the persisted Vision policy for this Session.')
            }
            if (signal?.aborted) return result('error', 'Vision-mode command was cancelled.')
          }
          const explicit = store.get(sessionId)
          const description = explicit?.source === 'user'
            ? (explicit.enabled ? 'on' : 'off')
            : 'not explicitly selected (legacy route policy)'
          return result('success', 'DVR precision tools: ' + description +
            '. Native model: ' + selection.provider + '/' + selection.model + '.')
        }
        return mutate(agent, { enabled: action === 'on', selection }, signal)
      },
    })
  })
}

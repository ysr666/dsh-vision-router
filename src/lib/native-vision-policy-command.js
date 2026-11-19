import { userSessionVisionPolicy } from './session-vision-policy.js'
import { isVisionRouterOwnedAdapter } from './adapter-ownership.js'

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

function sourceModelIsNative(ctx, provider) {
  // A DVR twin advertises inputModalities:['text','image'] for *Host image
  // admission*, even when its underlying source model is text-only. Metadata
  // alone is therefore insufficient to authorize the model-preserving native
  // command. Inspect the exact registered adapter, not the route name.
  try {
    const llm = ctx?.llm
    if (typeof llm?.registration !== 'function') return false
    const adapter = llm.registration(provider)?.adapter
    return adapter && !isVisionRouterOwnedAdapter(adapter)
  } catch {
    return false
  }
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
export function installNativeVisionPolicyCommand(ctx, store, { toolEnabled = () => true } = {}) {
  if (typeof ctx?.inject !== 'function' || typeof store?.get !== 'function' ||
      typeof store?.set !== 'function') return
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
          const explicit = store.get(sessionId)
          const description = explicit?.source === 'user'
            ? (explicit.enabled ? 'on' : 'off')
            : 'not explicitly selected (legacy route policy)'
          return result('success', 'DVR precision tools: ' + description +
            '. Native model: ' + selection.provider + '/' + selection.model + '.')
        }
        if (action === 'on' && !toolEnabled()) {
          return result('error', 'DVR tools are disabled in plugin settings.')
        }
        // Do not infer native modality from the provider or a route suffix.
        // Real Host model catalogs do not expose inputModalities to the UI.
        let info
        try {
          info = await ctx.llm?.resolveModelInfo?.(selection.provider, selection.model, signal)
        } catch {
          return result('error', 'Cannot validate native image capability for the selected model.')
        }
        // The official command registry may stop awaiting the handler on
        // cancellation; never let a late capability response apply stale
        // user permission after the cancel signal has fired.
        if (signal?.aborted) return result('error', 'Vision-mode command was cancelled.')
        if (!Array.isArray(info?.inputModalities) ||
            !info.inputModalities.includes('image') ||
            !sourceModelIsNative(ctx, selection.provider)) {
          return result('error',
            'The selected route is not a verified native image-capable source adapter. Keep the existing DVR vision wrapper for this provider.')
        }
        // Model selection can change while an async provider metadata lookup
        // is pending. Never commit a decision authorized for a stale route.
        if (!isSameSelection(selection, modelSelection(agent))) {
          return result('error', 'Model changed during Vision-mode validation; retry the command.')
        }
        const enabled = action === 'on'
        if (signal?.aborted) return result('error', 'Vision-mode command was cancelled.')
        try {
          await store.set(sessionId, userSessionVisionPolicy(enabled))
        } catch {
          return result('error', 'Vision-mode policy could not be stored for this Session.')
        }
        const durabilityNote = store.durable === false
          ? ' This Host has no durable policy store; the setting may reset after restart.'
          : ''
        return result('success',
          (enabled
            ? 'DVR precision tools enabled for this Session. The selected model is unchanged.'
            : 'DVR precision tools disabled for this Session. Native image input remains available; the selected model is unchanged.') + durabilityNote)
      },
    })
  })
}

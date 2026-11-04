import { reverseRouteTarget } from './core-primitives.js'

function routeOf(value) {
  if (!value || typeof value !== 'object') return undefined
  if (typeof value.provider !== 'string' || !value.provider || typeof value.model !== 'string' || !value.model) return undefined
  return { provider: value.provider, model: value.model }
}

function sameRoute(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model
}

function validMessages(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && item.role === 'user') : []
}

/**
 * Modern DSH freezes the model BEFORE agent/pre-step, while the old
 * agent/request model switch is now forbidden. The Agent's own inbox is the
 * last durable, synchronously observable input before that freeze.
 *
 * Never select during session/event: Session.append forbids reentrant appends,
 * and agent.model.select appends a model/selection event. Inbox notifications
 * and status events fire only AFTER the triggering append has returned.
 */
export function installPreStepModelRouting(ctx, options) {
  const owned = new WeakMap()
  const warning = new WeakSet()

  const warnOnce = (agent, message) => {
    if (warning.has(agent)) return
    warning.add(agent)
    ctx.logger?.warn?.('vision-router: modern pre-step routing unavailable: %s', message)
  }
  const nativeModel = (agent) => {
    const model = agent?.model
    return model && typeof model.select === 'function' && typeof model.current === 'function'
      ? model : undefined
  }
  const readInbox = (agent) => {
    if (!agent?.session || typeof ctx.get !== 'function') return undefined
    try {
      const registry = ctx.get('sessionProjections')
      if (typeof registry?.stateOf !== 'function') return undefined
      const state = registry.stateOf(agent.session, 'inbox')
      if (!state || typeof state !== 'object') return undefined
      return {
        nextTurn: validMessages(state['next-turn']),
        nextStep: validMessages(state['next-step']),
      }
    } catch {
      return undefined
    }
  }
  const available = (provider) => {
    try { return options.hasAdapter(provider) === true } catch { return false }
  }
  const select = (agent, target, previous, reason) => {
    if (!target || !available(target.provider) || sameRoute(target, previous)) return false
    // Keep an explicit same-route effort selection; drop provider-specific effort
    // only on a cross-route transition.
    try {
      agent.model.select(target)
      ctx.logger?.debug?.('vision-router: pre-step model selected for %s', reason)
      return true
    } catch (error) {
      warnOnce(agent, String(error?.message ?? error).slice(0, 180))
      return false
    }
  }
  const hasImage = (messages) => messages.some((message) => {
    try { return options.hasImage(message.content) === true } catch { return false }
  })
  const startDeepTools = () => {
    if (options.toolEnabled() && (options.autoActivateOnImageEnabled() || options.structuredBootstrapEnabled())) {
      options.activateDeepTools()
    }
  }
  const imageTurn = (agent, messages) => {
    const model = nativeModel(agent)
    if (!model || !hasImage(messages)) return
    // RC1 resolves step tools before agent/pre-step. Mount progressive deep
    // tools even when whole-turn routing is OFF (the default).
    startDeepTools()
    if (!options.routingEnabled()) return
    const source = routeOf(model.current())
    if (!source) return
    const first = options.routingPairs()[0]
    if (!first) return
    const chain = options.chainRoute()
    const target = chain && available(chain)
      ? { provider: chain, model: first.provider + '/' + first.model }
      : { provider: first.provider, model: first.model }
    // Historical behavior preserves the user's model within the same
    // provider when chain routing is not enabled.
    if (source.provider === target.provider) return
    const record = owned.get(agent)
    if (record && !sameRoute(source, record.target)) owned.delete(agent)
    const returnTo = owned.get(agent)?.origin ?? { ...model.current() }
    if (select(agent, target, source, 'image turn')) {
      owned.set(agent, { origin: returnTo, target })
    }
  }
  const textTurn = (agent) => {
    const model = nativeModel(agent)
    if (!model) return
    const current = routeOf(model.current())
    if (!current) return
    const record = owned.get(agent)
    if (record) {
      owned.delete(agent)
      if (sameRoute(current, record.target)) {
        // Restore the actual Session model chosen before DVR routed its image.
        // Never overwrite a different model explicitly selected by the user.
        const origin = routeOf(record.origin)
        const candidate = options.routingEnabled() && options.reverseRoutingEnabled()
          ? reverseRouteTarget(origin, {
              pairs: options.routingPairs(),
              wrapperRoute: options.wrapperRoute(),
              wrapperRegistered: options.wrapperRegistered(),
              textProvider: options.textProvider(),
              hasAdapter: available,
            })
          : undefined
        if (!select(agent, candidate ?? record.origin, current, 'text restore') && !available((candidate ?? record.origin)?.provider)) {
          warnOnce(agent, 'original text model is no longer registered')
        }
        return
      }
    }
    if (!options.routingEnabled() || !options.reverseRoutingEnabled()) return
    const target = reverseRouteTarget(current, {
      pairs: options.routingPairs(),
      wrapperRoute: options.wrapperRoute(),
      wrapperRegistered: options.wrapperRegistered(),
      textProvider: options.textProvider(),
      hasAdapter: available,
    })
    select(agent, target, current, 'reverse text routing')
  }
  const nextTurn = (agent, inbox) => {
    if (!nativeModel(agent)) return
    if (!inbox) { warnOnce(agent, 'Session inbox projection unavailable'); return }
    if (!inbox.nextTurn.length) return
    if (hasImage(inbox.nextTurn)) imageTurn(agent, inbox.nextTurn)
    else textTurn(agent)
  }
  const nextStep = (agent, inbox) => {
    if (!nativeModel(agent) || !inbox?.nextStep.length) return
    // Tool-produced context is not a new user text turn. In particular, it
    // must NOT undo an image selection from an ongoing multi-step tool run.
    if (hasImage(inbox.nextStep)) imageTurn(agent, inbox.nextStep)
  }

  ctx.on('agent/inbox/inserted', ({ agent, message } = {}) => {
    if (!nativeModel(agent)) return
    const inbox = readInbox(agent)
    if (!inbox) { warnOnce(agent, 'Session inbox projection unavailable'); return }
    // An inserted next-turn message may be waiting behind an active step.
    // Prefer the pending next-step image; the turn-stopping and running
    // boundaries re-evaluate next-turn once the active turn finishes.
    if (message?.id && inbox.nextStep.some((item) => item.id === message.id)) {
      nextStep(agent, inbox)
    } else if (message?.id && inbox.nextTurn.some((item) => item.id === message.id) && agent.status === 'idle') {
      nextTurn(agent, inbox)
    }
  })
  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (status === 'running') nextTurn(agent, readInbox(agent))
  })
  ctx.on('agent/turn-stopping', ({ agent } = {}) => {
    const inbox = readInbox(agent)
    if (inbox?.nextStep.length) nextStep(agent, inbox)
    else nextTurn(agent, inbox)
  })
  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent && typeof agent === 'object') {
      owned.delete(agent)
      warning.delete(agent)
    }
  })

  return { nativeModel }
}

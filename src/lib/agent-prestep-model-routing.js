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
  const agentsBySession = new WeakMap()
  const selecting = new WeakSet()
  const manualOverride = new WeakSet()
  const stopping = new WeakMap()

  const warnOnce = (agent, message) => {
    if (warning.has(agent)) return
    warning.add(agent)
    ctx.logger?.warn?.('vision-router: modern pre-step routing unavailable: %s', message)
  }
  const nativeModel = (agent) => {
    try {
      const model = agent?.model
      return model && typeof model.select === 'function' && typeof model.current === 'function'
        ? model : undefined
    } catch {
      return undefined
    }
  }
  const currentOf = (agent) => {
    try { return nativeModel(agent)?.current() }
    catch (error) {
      warnOnce(agent, String(error?.message ?? error).slice(0, 180))
      return undefined
    }
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
      selecting.add(agent.session)
      agent.model.select(target)
      ctx.logger?.debug?.('vision-router: pre-step model selected for %s', reason)
      return true
    } catch (error) {
      warnOnce(agent, String(error?.message ?? error).slice(0, 180))
      return false
    } finally {
      selecting.delete(agent.session)
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
    const selection = currentOf(agent)
    const source = routeOf(selection)
    if (!source) return
    const first = options.routingPairs()[0]
    if (typeof first?.provider !== 'string' || !first.provider
        || typeof first.model !== 'string' || !first.model) return
    const chain = options.chainRoute()
    const target = chain && available(chain)
      ? { provider: chain, model: first.provider + '/' + first.model }
      : { provider: first.provider, model: first.model }
    // Historical behavior preserves the user's model within the same
    // provider when chain routing is not enabled.
    if (source.provider === target.provider) return
    const record = owned.get(agent)
    if (record && !sameRoute(source, record.target)) owned.delete(agent)
    const returnTo = owned.get(agent)?.origin ?? { ...selection }
    if (select(agent, target, source, 'image turn')) {
      manualOverride.delete(agent)
      owned.set(agent, { origin: returnTo, target })
    }
  }
  const textTurn = (agent) => {
    const model = nativeModel(agent)
    if (!model) return
    const current = routeOf(currentOf(agent))
    if (!current || manualOverride.has(agent)) return
    const record = owned.get(agent)
    if (record) {
      owned.delete(agent)
      // A user can manually select another vision model while an image turn
      // is running. That explicit choice must not be reinterpreted as a
      // request for automatic reverse routing on the next text input.
      if (!sameRoute(current, record.target)) return
      // reverseRouting=false explicitly keeps the visual route for later text
      // turns. Only a disabled whole-turn routing switch must restore DVR's
      // temporary image selection to the user's original model.
      if (options.routingEnabled() && !options.reverseRoutingEnabled()) return
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

  const rememberAgent = (agent) => {
    if (nativeModel(agent) && agent?.session) agentsBySession.set(agent.session, agent)
  }
  // Observing external model/selection commits is read-only: selecting inside
  // session/event would reenter Session.append and crash. Invalidate only our
  // auto-restore ownership when a user/Host selects a model outside DVR.
  // Only accepted Host selection events carry authority; identical-route
  // no-op selections produce no event and therefore no new intent signal.
  ctx.on('session/event', (session, event) => {
    const agent = agentsBySession.get(session)
    if (event?.type === 'turn/start') {
      // Clear the previous turn's closing-window marker without appending a
      // Session event from inside the non-reentrant Session publication.
      if (agent) stopping.delete(agent)
      return
    }
    if (event?.type !== 'model/selection' || selecting.has(session)) return
    if (agent && owned.has(agent)) {
      owned.delete(agent)
      manualOverride.add(agent)
    }
  })
  const containEarlyHook = (agent, action) => {
    try { action() }
    catch (error) {
      // agent.send() calls inbox listeners synchronously BEFORE wakeDriver().
      // A plugin failure here must not strand a durably queued user message.
      if (agent && typeof agent === 'object') warnOnce(agent, String(error?.message ?? error).slice(0, 180))
    }
  }
  ctx.on('agent/inbox/inserted', ({ agent, message } = {}) => containEarlyHook(agent, () => {
    if (!nativeModel(agent)) return
    rememberAgent(agent)
    const inbox = readInbox(agent)
    if (!inbox) { warnOnce(agent, 'Session inbox projection unavailable'); return }
    // An inserted next-turn message may be waiting behind an active step.
    // Prefer the pending next-step image; the turn-stopping and running
    // boundaries re-evaluate next-turn once the active turn finishes.
    if (message?.id && inbox.nextStep.some((item) => item.id === message.id)) {
      const previous = stopping.get(agent)
      if (previous && !manualOverride.has(agent)) {
        // A next-step steering message may arrive while turn-stopping awaits
        // other hooks, after DVR temporarily selected a queued next-turn route.
        // Reassert this turn's actual route, never the later queued turn's route.
        const current = routeOf(currentOf(agent))
        if (current && previous.route && !sameRoute(current, previous.route)) {
          if (select(agent, previous.route, current, 'closing step continuation')) {
            if (previous.owned) owned.set(agent, previous.owned)
            else owned.delete(agent)
          }
        }
      }
      nextStep(agent, inbox)
    } else if (message?.id && inbox.nextTurn.some((item) => item.id === message.id)
        && (agent.status === 'idle' || stopping.has(agent))) {
      // Once turn-stopping starts there can be a tiny gap before the next
      // turn/start where status is still running. New queued turns must not
      // miss the pre-step model selection in that window.
      nextTurn(agent, inbox)
    }
  }))
  ctx.on('agent/status', ({ agent, status } = {}) => containEarlyHook(agent, () => {
    rememberAgent(agent)
    if (status === 'running') nextTurn(agent, readInbox(agent))
  }))
  ctx.on('agent/turn-stopping', ({ agent } = {}) => {
    try {
      rememberAgent(agent)
      const selection = currentOf(agent)
      const current = routeOf(selection)
      if (current) stopping.set(agent, {route: {...selection}, owned: owned.get(agent)})
      const inbox = readInbox(agent)
      if (inbox?.nextStep.length) nextStep(agent, inbox)
      else nextTurn(agent, inbox)
    } catch (error) {
      // A routing plugin must never veto the Host's turn completion.
      if (agent && typeof agent === 'object') warnOnce(agent, String(error?.message ?? error).slice(0, 180))
    }
  })
  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent && typeof agent === 'object') {
      owned.delete(agent)
      warning.delete(agent)
      manualOverride.delete(agent)
      stopping.delete(agent)
      if (agent.session) agentsBySession.delete(agent.session)
    }
  })

  return { nativeModel }
}

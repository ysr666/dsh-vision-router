// Production Session-scoped Remote registration. DSH's Typert Loader explicitly
// supports manual registry contributions for hand-written wire schemas.
// No eager import of a Host package, private HTTP route, or SRC fallback.
import { observeNativeVisionControlState } from './native-vision-control-state.js'
import { nativeVisionControlSessionIdSchema, nativeVisionControlViewSchema, nativeVisionMutationRequestSchema, nativeVisionMutationReceiptSchema } from './native-vision-control-wire.js'
import { NATIVE_VISION_REMOTE, createNativeVisionControlContribution } from './native-vision-control-client.js'
export { NATIVE_VISION_REMOTE } from './native-vision-control-client.js'

/**
 * Strict descriptors are owned by the Typert/plugin generation, NOT by the
 * transient Agents/LLM injection or by the current 'agent' lookup.
 *
 * DSH Gateway remembers strict endpoints; temporarily withdrawing a
 * definition while its client stays mounted yields
 * gateway/definition-unavailable (no SRC fallback is permitted). On an Agent
 * lookup outage we instead abort current streams and unprovide the receiver.
 * Gateway continues to enforce live lookup, binding and principal validation;
 * no stale Agent can be invoked. The descriptor is withdrawn only when this
 * actual Typert/plugin owner retires.
 */
export function installNativeVisionControlRemote(ctx, store, options = {}) {
  if (typeof ctx?.inject !== 'function' || typeof store?.subscribe !== 'function' ||
      typeof options.mutate !== 'function') return
  return ctx.inject(['typert'], owner => {
    const registry = owner.typert
    if (typeof registry?.register !== 'function' ||
        typeof registry?.lookups?.get !== 'function' ||
        typeof owner.inject !== 'function' ||
        typeof owner.effect !== 'function') return
    const contribution = createNativeVisionControlContribution({
      id: nativeVisionControlSessionIdSchema, view: nativeVisionControlViewSchema,
      request: nativeVisionMutationRequestSchema, receipt: nativeVisionMutationReceiptSchema,
    })
    const agentParameter = contribution.descriptors[0].parameters[0]
    let withdrawDefinition
    let releaseActiveReceiver = () => {}
    let retired = false

    // Parent-scope registration outlives any number of child Agents/LLM
    // rebinding cycles. Both strict methods remain available in the public
    // Typert registry, but neither can run without a valid live receiver and
    // matching Host Agent lookup.
    owner.effect(() => () => {
      retired = true
      releaseActiveReceiver()
      const withdraw = withdrawDefinition
      withdrawDefinition = undefined
      try { void Promise.resolve(withdraw?.()).catch(() => {}) } catch {}
    }, 'vision-router: native strict Remote definition lifetime')

    // Cordis inject() returns a Fiber, not an effect disposer. Do NOT return
    // that Fiber from the outer injection callback (Invalid effect on Host).
    owner.inject(['typert', 'agents', 'llm'], scope => {
      if (typeof scope.provide !== 'function' ||
          typeof scope.effect !== 'function' ||
          typeof scope.typert?.lookups?.subscribe !== 'function') return
      // A new Agents/LLM binding wins over any still-disposing previous one.
      // The old receiver is synchronously removed before a new one exists.
      releaseActiveReceiver()
      let held
      let active = true
      const releaseReceiver = () => {
        const generation = held
        held = undefined
        if (!generation) return
        generation.lifetime.abort()
        try { void Promise.resolve(generation.unprovide()).catch(() => {}) } catch {}
      }
      const retireReceiver = () => {
        active = false
        releaseReceiver()
      }
      releaseActiveReceiver = retireReceiver

      const reconcile = () => {
        if (retired || !active) return
        // The official AgentRegistry itself may install its lookup AFTER the
        // Agents service has been constructed. Wait for that positive match.
        const lookup = scope.typert.lookups.get(agentParameter.lookup)
        if (lookup?.resource !== 'session' || lookup.wire !== agentParameter.wire ||
            lookup.wireTypeSymbol !== agentParameter.codec.typeSymbol ||
            typeof lookup.resolve !== 'function') {
          releaseReceiver()
          return
        }
        if (held) return
        const lifetime = new AbortController()
        // Gateway, not client-provided input, resolves Agent and principal.
        const receiver = {
          async set(agent, request, signal) {
            const liveSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
            liveSignal.throwIfAborted()
            const input = nativeVisionMutationRequestSchema.parse(request)
            const receipt = await options.mutate(agent, input, liveSignal)
            return nativeVisionMutationReceiptSchema.parse(receipt)
          },
          observe(agent, signal) {
            const liveSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
            if (liveSignal.aborted) return (async function* () {})()
            return observeNativeVisionControlState(scope, store, agent, {
              ...options, signal: liveSignal,
            })
          },
        }
        Object.defineProperty(receiver, 'typertRemote', {
          value: Object.freeze({ service: receiver, serviceKey: NATIVE_VISION_REMOTE,
            namespace: NATIVE_VISION_REMOTE }),
          enumerable: true,
        })
        let unprovide
        try {
          unprovide = scope.provide(NATIVE_VISION_REMOTE, receiver)
          if (!withdrawDefinition) {
            // Crucially obtain the register() view from OWNER (Typert only),
            // not SCOPE (Agents/LLM), or Cordis will withdraw the strict
            // definition whenever Agents/LLM restarts.
            withdrawDefinition = registry.register({
              package: contribution.package, face: 'host', schemas: [],
              model: { services: [], events: [], objects: [] },
              invocations: contribution.descriptors,
            })
          }
          held = { lifetime, unprovide }
        } catch (error) {
          lifetime.abort()
          try { void Promise.resolve(unprovide?.()).catch(() => {}) } catch {}
          scope.logger?.warn?.('vision-router: native control Remote unavailable: %s', String(error))
        }
      }
      scope.effect(() => () => {
        retireReceiver()
        if (releaseActiveReceiver === retireReceiver) releaseActiveReceiver = () => {}
      }, 'vision-router: native Remote receiver lifetime')
      scope.typert.lookups.subscribe(change => {
        if (change?.key === 'agent') reconcile()
      })
      reconcile()
    })
  })
}

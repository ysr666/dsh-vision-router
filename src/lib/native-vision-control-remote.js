// Production Session-scoped Remote registration. DSH's Typert Loader explicitly
// supports manual registry contributions for hand-written wire schemas.
// No eager import of a Host package, private HTTP route, or SRC fallback.
import { observeNativeVisionControlState } from './native-vision-control-state.js'
import { nativeVisionControlSessionIdSchema, nativeVisionControlViewSchema, nativeVisionMutationRequestSchema, nativeVisionMutationReceiptSchema } from './native-vision-control-wire.js'

import { NATIVE_VISION_REMOTE, createNativeVisionControlContribution } from './native-vision-control-client.js'
export { NATIVE_VISION_REMOTE } from './native-vision-control-client.js'


/**
 * Register only on Hosts with the current strict Typert registry and the
 * Session-scoped Agent lookup. Missing features leave existing commands
 * and legacy picker unchanged. No fallback to an unauthenticated carrier.
 */
export function installNativeVisionControlRemote(ctx, store, options = {}) {
  if (typeof ctx?.inject !== 'function' || typeof store?.subscribe !== 'function' ||
      typeof options.mutate !== 'function') return
  return ctx.inject(['typert', 'agents', 'llm'], scope => {
    const registry = scope.typert
    if (typeof registry?.register !== 'function' ||
        typeof registry?.lookups?.get !== 'function' ||
        typeof registry?.lookups?.subscribe !== 'function' ||
        typeof scope.provide !== 'function' || typeof scope.effect !== 'function') return
    const contribution = createNativeVisionControlContribution({
      id: nativeVisionControlSessionIdSchema, view: nativeVisionControlViewSchema,
      request: nativeVisionMutationRequestSchema, receipt: nativeVisionMutationReceiptSchema,
    })
    const agentParameter = contribution.descriptors[0].parameters[0]
    // Avoid the order race where the Host Agent Registry's own Typert
    // injection runs after our plugin. A checked lookup, not a version guess.
    let held
    let retired = false
    const release = () => {
      const generation = held
      held = undefined
      if (!generation) return
      generation.lifetime.abort()
      // Disposers are fiber-owned and may also be invoked during unload.
      try { void Promise.resolve(generation.withdraw()).catch(() => {}) } catch {}
      try { void Promise.resolve(generation.unprovide()).catch(() => {}) } catch {}
    }
    const reconcile = () => {
      if (retired) return
      const lookup = registry.lookups.get(agentParameter.lookup)
      if (lookup?.resource !== 'session' || lookup.wire !== agentParameter.wire ||
          lookup.wireTypeSymbol !== agentParameter.codec.typeSymbol || typeof lookup.resolve !== 'function') {
        release()
        return
      }
      if (held) return
      const lifetime = new AbortController()
      // This plain Cordis service uses the public TypertGatewayBinding shape.
      // Its methods close over the owning scope instead of relying on an
      // invocation-context receiver; the Gateway still validates the exact
      // binding, wire arguments, principal and lookup before invoking them.
      const receiver = {
        async set(agent, request, signal) {
          const liveSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
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
        const withdraw = registry.register({
          package: contribution.package, face: 'host', schemas: [],
          model: { services: [], events: [], objects: [] },
          invocations: contribution.descriptors,
        })
        held = { lifetime, withdraw, unprovide }
      } catch (error) {
        lifetime.abort()
        try { void Promise.resolve(unprovide?.()).catch(() => {}) } catch {}
        // Never replace a conflicting service or descriptor.
        scope.logger?.warn?.('vision-router: native control Remote unavailable: %s', String(error))
      }
    }
    scope.effect(() => () => { retired = true; release() }, 'vision-router: native Remote lifetime')
    registry.lookups.subscribe(change => {
      if (change?.key === 'agent') reconcile()
    })
    reconcile()
  })
}

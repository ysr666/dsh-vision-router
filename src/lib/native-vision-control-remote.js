// Production Session-scoped Remote registration. DSH's Typert Loader explicitly
// supports manual registry contributions for hand-written wire schemas.
// No eager import of a Host package, private HTTP route, or SRC fallback.
import { observeNativeVisionControlState } from './native-vision-control-state.js'
import { nativeVisionControlSessionIdSchema, nativeVisionControlViewSchema, nativeVisionMutationRequestSchema, nativeVisionMutationReceiptSchema } from './native-vision-control-wire.js'

export const NATIVE_VISION_REMOTE = 'dvrNativeVision'
const PACKAGE = 'dsh-vision-router-native-control'
const SESSION_TYPE = '@deepseek-ai/dsh-session/types#SessionId'

export function createNativeVisionControlContribution() {
  const codec = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, create: () => schema })
  return {
    package: PACKAGE,
    descriptors: [{
      id: PACKAGE + '#' + NATIVE_VISION_REMOTE + '/observe',
      service: NATIVE_VISION_REMOTE,
      namespace: NATIVE_VISION_REMOTE,
      method: 'observe',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
        codec: codec(SESSION_TYPE, nativeVisionControlSessionIdSchema) }],
      cancellation: { parameter: 'signal' },
      result: codec(PACKAGE + '#NativeVisionControlView', nativeVisionControlViewSchema),
    }, {
      id: PACKAGE + '#' + NATIVE_VISION_REMOTE + '/set',
      service: NATIVE_VISION_REMOTE,
      namespace: NATIVE_VISION_REMOTE,
      method: 'set',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
          codec: codec(SESSION_TYPE, nativeVisionControlSessionIdSchema) },
        { name: 'request', wire: 'request', source: 'json',
          codec: codec(PACKAGE + '#NativeVisionMutationRequest', nativeVisionMutationRequestSchema) },
      ],
      cancellation: { parameter: 'signal' },
      result: codec(PACKAGE + '#NativeVisionMutationReceipt', nativeVisionMutationReceiptSchema),
    }],
  }
}

/**
 * Register only on Hosts with the current strict Typert registry and the
 * Session-scoped Agent lookup. Missing features leave existing commands
 * and legacy picker unchanged. No fallback to an unauthenticated carrier.
 */
export function installNativeVisionControlRemote(ctx, store, options = {}) {
  if (typeof ctx?.inject !== 'function' || typeof store?.subscribe !== 'function' ||
      typeof options.mutate !== 'function') return
  return ctx.inject(['typert', 'agents'], scope => {
    const registry = scope.typert
    if (typeof registry?.register !== 'function' ||
        typeof registry?.lookups?.get !== 'function' ||
        typeof registry?.lookups?.subscribe !== 'function' ||
        typeof scope.provide !== 'function' || typeof scope.effect !== 'function') return
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
      const lookup = registry.lookups.get('agent')
      if (lookup?.resource !== 'session' || lookup.wire !== 'agentId' ||
          lookup.wireTypeSymbol !== SESSION_TYPE || typeof lookup.resolve !== 'function') {
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
        const contribution = createNativeVisionControlContribution()
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

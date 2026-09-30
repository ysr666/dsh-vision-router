import { projectDelegatedCallConfig } from './delegated-call-config.js'
import { contextWithTwinImageCapabilityFallback } from './twin-image-capability-fallback.js'

const routeAuthorityOptionsByContext = new WeakMap()

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function routeOf(value) {
  if (!isObject(value)) return undefined
  const provider = typeof value.provider === 'string' && value.provider !== '' ? value.provider : undefined
  const model = typeof value.model === 'string' && value.model !== '' ? value.model : undefined
  return provider !== undefined && model !== undefined ? { provider, model } : undefined
}

/**
 * A completed `agent/request` route change is an authority handoff: generation
 * defaults from the source provider/model must not be mistaken for explicit
 * target-model config. Payload/lifecycle fields remain untouched.
 *
 * Fail closed on incomplete route evidence. If either side lacks an exact
 * provider+model tuple, preserve the handler result rather than guessing.
 */
export function projectAgentRequestRouteHandoff(sourceConfig, resultConfig) {
  const source = routeOf(sourceConfig)
  const target = routeOf(resultConfig)
  if (source === undefined || target === undefined) return resultConfig
  if (source.provider === target.provider && source.model === target.model) return resultConfig
  return projectDelegatedCallConfig(resultConfig)
}

/**
 * Runtime composition can publish route identities before Core.apply without
 * changing the mature `contextWithAgentRequestRouteAuthority(backendRuntimeCtx)`
 * boundary shape. The WeakMap keeps this per-context and garbage-collectable.
 */
export function configureAgentRequestRouteAuthority(ctx, options = {}) {
  if (!isObject(ctx)) return ctx
  routeAuthorityOptionsByContext.set(ctx, {
    wrapperRoute: options.wrapperRoute,
    chainRoute: options.chainRoute,
    logger: options.logger,
  })
  return ctx
}

/**
 * Private Core-facing context. It wraps only `agent/request` handlers and only
 * projects a result when that handler demonstrably changed provider/model.
 * Ordinary request handlers and direct LLM calls retain caller identity.
 *
 * This is also the final Core-facing adapter-registration boundary, so it owns
 * the generated-twin runtime capability correction: if a `<provider>-vision`
 * twin trusted image metadata but the live source explicitly rejects raw image
 * input before producing output, the twin is re-entered once through Core's
 * existing text bridge instead of leaking that 400 to the user. Keeping the
 * fallback here means the deeper prepareCall/ownership layers still observe the
 * final wrapped stream and retain their existing contracts.
 */
export function contextWithAgentRequestRouteAuthority(ctx, options) {
  if (!isObject(ctx)) return ctx
  const fallbackOptions = isObject(options)
    ? options
    : routeAuthorityOptionsByContext.get(ctx) ?? {}
  const routeAuthorityCtx = new Proxy(ctx, {
    get(target, property) {
      if (property !== 'on') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const on = Reflect.get(target, property, target)
      if (typeof on !== 'function') return on
      return (event, handler, ...rest) => {
        if (event !== 'agent/request' || typeof handler !== 'function') {
          return on.call(target, event, handler, ...rest)
        }
        return on.call(target, event, async function routeAuthorityAwareRequest(payload, next) {
          let sourceConfig
          const captureNext = typeof next === 'function'
            ? async (...args) => {
                const value = await next(...args)
                if (sourceConfig === undefined) sourceConfig = value
                return value
              }
            : next
          const result = await handler.call(this, payload, captureNext)
          return projectAgentRequestRouteHandoff(sourceConfig, result)
        }, ...rest)
      }
    },
  })
  return contextWithTwinImageCapabilityFallback(routeAuthorityCtx, fallbackOptions)
}

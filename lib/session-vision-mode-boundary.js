import { currentSessionVisionPolicy } from './native-image-coexistence.js'
import {
  resolveSessionVisionModeAuthority,
  runWithSessionVisionModeAuthority,
  visionModeEnabledForAgent,
} from './session-vision-mode-authority.js'

const RESERVED_PTC_TOOL = 'run_code'

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function liveConfig(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    // Composition config stays authoritative while Settings is unavailable.
  }
  return fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}
}

function visionModeDisabledError(name) {
  const error = new Error(
    `${name}: Vision mode is off for this Session; enable the composer Vision control before using Vision Router tools`,
  )
  error.code = 'VISION_MODE_DISABLED'
  return error
}

function globalNonVisionToolNames(ctx) {
  try {
    const schemas = ctx?.tools?.schemas?.()
    if (!Array.isArray(schemas)) return undefined
    return schemas
      .map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
      .filter((name) =>
        name !== '' &&
        name !== RESERVED_PTC_TOOL &&
        !name.startsWith('vision_'))
      .sort()
  } catch {
    return undefined
  }
}

function syncAgentToolRestriction(ctx, agent, enabled, restrictions) {
  if (!isObject(agent)) return
  const held = restrictions.get(agent)
  if (enabled) {
    if (held) {
      try { held.dispose?.() } catch {}
      restrictions.delete(agent)
    }
    return
  }

  const restrict = agent?.ctx?.tools?.restrict
  const allow = globalNonVisionToolNames(ctx)
  if (typeof restrict !== 'function' || allow === undefined) return
  const signature = allow.join('\u0000')
  if (held?.signature === signature) return
  if (held) {
    try { held.dispose?.() } catch {}
    restrictions.delete(agent)
  }

  try {
    // DSH's run_code transport is reserved and survives scoped restrictions by
    // design; naming it in allow/deny is rejected. Omit it from the snapshot so
    // PTC mode keeps its transport while every global vision_* capability is
    // still excluded from the OFF Session.
    const dispose = restrict.call(agent.ctx.tools, { allow })
    restrictions.set(agent, {
      signature,
      dispose: typeof dispose === 'function' ? dispose : undefined,
    })
  } catch {
    // Older/minimum Hosts without scoped restrictions still receive the
    // execution-time fail-closed guard below.
  }
}

function wrapTools(tools, ctx, config) {
  if (!isObject(tools)) return tools
  return new Proxy(tools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (definition, ...rest) => {
        if (
          !definition ||
          typeof definition !== 'object' ||
          typeof definition.name !== 'string' ||
          !definition.name.startsWith('vision_') ||
          typeof definition.execute !== 'function'
        ) {
          return register.call(target, definition, ...rest)
        }
        const execute = definition.execute
        return register.call(target, {
          ...definition,
          async execute(args, exec) {
            if (
              exec?.agent &&
              !visionModeEnabledForAgent(ctx, exec.agent, liveConfig(ctx, config))
            ) {
              throw visionModeDisabledError(definition.name)
            }
            return execute.call(definition, args, exec)
          },
        }, ...rest)
      }
    },
  })
}

/**
 * Explicit Session Vision-mode authority boundary.
 *
 * DSH's per-Session model selection is the product switch: an adapter route
 * owned by Vision Router means ON; an ordinary Host route means OFF. This
 * boundary snapshots that fact once for every Agent step, projects it into
 * Core's existing Session surface, and keeps global tool registration separate
 * from per-Agent visibility/execution authority.
 *
 * It deliberately lives outside the retired legacy-core policy bridge, whose
 * identity-only closure contract remains frozen.
 */
export function installSessionVisionModeBoundary(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const restrictions = new WeakMap()
  let toolsView

  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') {
        if (!toolsView) toolsView = wrapTools(Reflect.get(target, property, target), target, config)
        return toolsView
      }
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(target, event, async function sessionVisionModeAwarePreStep(payload, next) {
            const agent = payload?.agent
            const authority = resolveSessionVisionModeAuthority(
              target,
              agent,
              liveConfig(target, config),
              {
                turn: payload?.turn,
                visionPolicy: currentSessionVisionPolicy(),
              },
            )
            syncAgentToolRestriction(target, agent, authority.enabled === true, restrictions)
            return runWithSessionVisionModeAuthority(
              authority,
              agent,
              () => handler.call(this, payload, next),
            )
          }, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return { ctx: wrapped, config }
}

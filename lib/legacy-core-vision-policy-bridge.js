import { currentSessionVisionPolicy } from './native-image-coexistence.js'
import {
  resolveSessionVisionModeAuthority,
  runWithSessionVisionModeAuthority,
  visionModeEnabledForAgent,
} from './session-vision-mode-authority.js'

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
      .filter((name) => name !== '' && !name.startsWith('vision_'))
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
    const dispose = restrict.call(agent.ctx.tools, { allow })
    restrictions.set(agent, {
      signature,
      dispose: typeof dispose === 'function' ? dispose : undefined,
    })
  } catch {
    // Minimum/older Hosts without the scoped restriction seam still receive
    // the execution-time fail-closed guard below.
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
          execute(args, exec) {
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
 * Session Vision-mode authority boundary.
 *
 * This stable composition seam used to be an identity-only compatibility shell.
 * It now owns the missing authority link between DSH's per-Session model
 * selection and Vision Router's tool/orchestration surface:
 *
 * - one immutable mode snapshot is resolved before every model step from the
 *   Host modelSelection projection (pending selection before last request);
 * - the snapshot is ambient while Core assembles the step, so Core's existing
 *   surface policy can suppress bootstrap/auto-mount/instant work when OFF;
 * - DSH's native agent-scoped tool restriction hides global vision_* schemas
 *   from an OFF Session without unregistering them process-wide;
 * - every vision_* execute body is guarded again, so stale schemas, direct
 *   dispatch, or cross-Session registration races cannot read image data while
 *   the Session is OFF.
 *
 * Registration remains stable and global; authority is Session/step scoped.
 */
export function installLegacyCoreVisionPolicyBridge(ctx, config = {}) {
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

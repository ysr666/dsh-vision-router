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

function globalVisionToolNames(ctx) {
  try {
    const schemas = ctx?.tools?.schemas?.()
    if (!Array.isArray(schemas)) return undefined
    return schemas
      .map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
      .filter((name) => name.startsWith('vision_'))
      .sort()
  } catch {
    return undefined
  }
}

function releaseAgentToolRestriction(agent, restrictions) {
  if (!isObject(agent)) return
  const held = restrictions.get(agent)
  if (!held) return
  try { held.dispose?.() } catch {}
  restrictions.delete(agent)
}

function syncAgentToolRestriction(ctx, agent, enabled, restrictions) {
  if (!isObject(agent)) return
  if (enabled) {
    releaseAgentToolRestriction(agent, restrictions)
    return
  }

  const restrict = agent?.ctx?.tools?.restrict
  const deny = globalVisionToolNames(ctx)
  if (typeof restrict !== 'function' || deny === undefined) return
  if (deny.length === 0) {
    releaseAgentToolRestriction(agent, restrictions)
    return
  }

  const held = restrictions.get(agent)
  const signature = deny.join('\u0000')
  if (held?.signature === signature) return
  releaseAgentToolRestriction(agent, restrictions)

  try {
    // Deny only Router-owned end-capability tools. This leaves every Host tool
    // and the reserved PTC run_code presentation transport alone, and cannot
    // become stale when another plugin adds a new ordinary tool.
    const dispose = restrict.call(agent.ctx.tools, { deny })
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
 * DSH assembles the system prompt and tool catalog before `agent/pre-step`.
 * AgentLoop emits its synchronous `agent/status -> running` transition before
 * that assembly, so the per-Agent deny mask is synchronized there. Pre-step
 * repeats the synchronization for later step transitions, while execution is
 * independently fail-closed.
 *
 * It deliberately lives outside the retired legacy-core policy bridge, whose
 * identity-only closure contract remains frozen.
 */
export function installSessionVisionModeBoundary(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const restrictions = new WeakMap()
  let toolsView

  const syncForAgent = (agent) => {
    if (!isObject(agent)) return
    const authority = resolveSessionVisionModeAuthority(
      ctx,
      agent,
      liveConfig(ctx, config),
    )
    syncAgentToolRestriction(ctx, agent, authority.enabled === true, restrictions)
  }

  // A waking Agent enters `running` synchronously before its first prompt/tool
  // assembly. This is the earliest stable per-Agent edge exposed by DSH and is
  // therefore where OFF visibility must be installed.
  try {
    ctx.on?.('agent/status', ({ agent, status }) => {
      if (status === 'running') syncForAgent(agent)
    })
    ctx.on?.('agent/created', ({ agent }) => syncForAgent(agent))
    ctx.on?.('agent/disposed', ({ agent }) => releaseAgentToolRestriction(agent, restrictions))
  } catch {
    // Minimum Hosts may not expose every lifecycle event. Pre-step/execution
    // guards below preserve safety without making plugin apply fail.
  }

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

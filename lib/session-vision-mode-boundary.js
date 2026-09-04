import { currentSessionVisionPolicy } from './native-image-coexistence.js'
import {
  clearSessionVisionModeAuthorityForAgent,
  rememberSessionVisionModeAssemblyAuthorityForAgent,
  resolveSessionVisionModeAuthority,
  runWithSessionVisionModeAuthority,
  takeSessionVisionModeAssemblyAuthorityForAgent,
  visionModeEnabledForAgent,
} from './session-vision-mode-authority.js'

const MODE_SYNC_VARIABLE = 'vision_router_mode_sync'

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function assemblyAgent(context) {
  if (isObject(context?.agent) && isObject(context.agent.session)) return context.agent
  // DSH rc.7/rc.8 pass the Agent only through AssembleContext.scope. Newer
  // Hosts declaration-merge context.agent as well. Accept the legacy carrier
  // only when it is unmistakably an Agent so standing/scopeless assemblies do
  // not manufacture Session authority.
  if (isObject(context?.scope) && isObject(context.scope.session)) return context.scope
  return undefined
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

function ownedVisionToolNames(owned) {
  return [...owned].sort()
}

function releaseAgentToolRestriction(agent, restrictions) {
  if (!isObject(agent)) return
  const held = restrictions.get(agent)
  if (!held) return
  try { held.dispose?.() } catch {}
  restrictions.delete(agent)
}

function syncAgentToolRestriction(agent, enabled, restrictions, owned) {
  if (!isObject(agent)) return
  if (enabled) {
    releaseAgentToolRestriction(agent, restrictions)
    return
  }

  const restrict = agent?.ctx?.tools?.restrict
  const deny = ownedVisionToolNames(owned)
  if (typeof restrict !== 'function') return
  if (deny.length === 0) {
    releaseAgentToolRestriction(agent, restrictions)
    return
  }

  const held = restrictions.get(agent)
  const signature = deny.join('\u0000')
  if (held?.signature === signature) return
  releaseAgentToolRestriction(agent, restrictions)

  try {
    // Deny exactly the definitions registered through Vision Router's Core
    // context, not every global tool whose author happened to choose a
    // `vision_*` prefix. This keeps foreign plugin capabilities independent.
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

function wrapTools(tools, ctx, config, owned) {
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
        const registered = register.call(target, {
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
        owned.add(definition.name)
        if (typeof registered !== 'function') return registered
        let active = true
        return () => {
          if (!active) return
          active = false
          try {
            return registered()
          } finally {
            owned.delete(definition.name)
          }
        }
      }
    },
  })
}

/**
 * Explicit Session Vision-mode authority boundary.
 *
 * DSH's per-Session model selection is the product switch: an adapter route
 * owned by Vision Router means ON; an ordinary Host route means OFF. This
 * boundary snapshots that fact at the same prompt-assembly boundary where DSH
 * snapshots model selection, projects it into Core's Session surface, and
 * keeps global tool registration separate from per-Agent visibility/execution
 * authority.
 *
 * SystemPrompt resolves variables before it invokes tool providers and before
 * it renders the PTC SDK section. A private, unused variable therefore gives us
 * a side-effect-only pre-tool boundary without altering rendered prompt text or
 * durable request headers. It refreshes the Agent-scoped deny mask for every
 * step, including a picker change made while a previous step is running.
 *
 * It deliberately lives outside the retired legacy-core policy bridge, whose
 * identity-only closure contract remains frozen.
 */
export function installSessionVisionModeBoundary(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const restrictions = new WeakMap()
  const ownedVisionTools = new Set()
  let toolsView

  const resolveForAgent = (agent, options = {}) => resolveSessionVisionModeAuthority(
    ctx,
    agent,
    liveConfig(ctx, config),
    options,
  )

  const syncForAgent = (agent) => {
    if (!isObject(agent)) return
    const authority = resolveForAgent(agent)
    syncAgentToolRestriction(
      agent,
      authority.enabled === true,
      restrictions,
      ownedVisionTools,
    )
  }

  const captureForAssembly = (agent) => {
    if (!isObject(agent)) return undefined
    clearSessionVisionModeAuthorityForAgent(agent)
    const authority = resolveForAgent(agent)
    rememberSessionVisionModeAssemblyAuthorityForAgent(authority, agent)
    syncAgentToolRestriction(
      agent,
      authority.enabled === true,
      restrictions,
      ownedVisionTools,
    )
    return authority
  }

  // DSH evaluates prompt variables synchronously before tool providers. This
  // makes the restriction authoritative for both native function schemas and
  // PTC's generated tools:sdk section on every assembled step. Current Hosts
  // expose context.agent; rc.7/rc.8 expose the same Agent as context.scope.
  // The returned variable is intentionally unused and never reaches the model.
  try {
    const systemPrompt = ctx?.systemPrompt ?? ctx?.get?.('systemPrompt')
    if (typeof systemPrompt?.variable === 'function') {
      systemPrompt.variable(MODE_SYNC_VARIABLE, (context) => {
        captureForAssembly(assemblyAgent(context))
        return ''
      })
    }
  } catch {
    // Minimum Hosts without prompt variables retain the lifecycle/pre-step
    // fallbacks below and the execution-time fail-closed guard.
  }

  // A waking Agent enters `running` before its first prompt/tool assembly.
  // Refresh visibility there as an early fallback, but do not persist the step
  // snapshot until prompt assembly itself: a picker change between wakeup and
  // assembly must still win for that request.
  try {
    ctx.on?.('agent/status', ({ agent, status }) => {
      if (status === 'running') {
        clearSessionVisionModeAuthorityForAgent(agent)
        syncForAgent(agent)
      } else if (status === 'idle') {
        clearSessionVisionModeAuthorityForAgent(agent)
      }
    })
    ctx.on?.('agent/created', ({ agent }) => {
      clearSessionVisionModeAuthorityForAgent(agent)
      syncForAgent(agent)
    })
    ctx.on?.('agent/disposed', ({ agent }) => {
      clearSessionVisionModeAuthorityForAgent(agent)
      releaseAgentToolRestriction(agent, restrictions)
    })
  } catch {
    // Minimum Hosts may not expose every lifecycle event. Pre-step/execution
    // guards below preserve safety without making plugin apply fail.
  }

  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') {
        if (!toolsView) {
          toolsView = wrapTools(
            Reflect.get(target, property, target),
            target,
            config,
            ownedVisionTools,
          )
        }
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
            // Prompt assembly is the exact DSH selection-snapshot boundary. A
            // staged assembly snapshot belongs to this pre-step only and is
            // consumed here. Hosts/tests that invoke pre-step without assembly
            // resolve fresh authority instead of reusing a completed step.
            const authority = takeSessionVisionModeAssemblyAuthorityForAgent(agent)
              ?? resolveSessionVisionModeAuthority(
                target,
                agent,
                liveConfig(target, config),
                {
                  turn: payload?.turn,
                  visionPolicy: currentSessionVisionPolicy(),
                },
              )
            syncAgentToolRestriction(
              agent,
              authority.enabled === true,
              restrictions,
              ownedVisionTools,
            )
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

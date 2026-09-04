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
  // DSH rc.7/rc.8 pass the Agent through AssembleContext.scope. Newer Hosts
  // declaration-merge context.agent as well. Accept scope only when it is
  // unmistakably an Agent so standing/scopeless assemblies cannot manufacture
  // Session authority.
  if (isObject(context?.scope) && isObject(context.scope.session)) return context.scope
  return undefined
}

function isStepAssembly(context) {
  // The Agent loop supplies the turn's AbortSignal to SystemPrompt. Diagnostic,
  // presentation and standing assemblies may carry the same Agent/scope but no
  // request signal. Only a real loop assembly may stage next-step authority or
  // mutate that Agent's scoped tool mask.
  return isObject(context) && context.signal !== undefined
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

function visionToolSurfaceEnabled(ctx, config, authority) {
  return authority?.enabled === true && liveConfig(ctx, config).tool !== false
}

function visionModeDisabledError(name) {
  const error = new Error(
    `${name}: Vision mode is off for this Session; enable the composer Vision control before using Vision Router tools`,
  )
  error.code = 'VISION_MODE_DISABLED'
  return error
}

function ownedVisionToolNames(owned) {
  return [...owned.keys()].sort()
}

function rememberOwnedTool(owned, name) {
  owned.set(name, (owned.get(name) ?? 0) + 1)
}

function forgetOwnedTool(owned, name) {
  const count = owned.get(name) ?? 0
  if (count <= 1) owned.delete(name)
  else owned.set(name, count - 1)
}

function disposeHeldRestriction(held) {
  if (!held) return
  const disposers = Array.isArray(held.disposers)
    ? held.disposers
    : typeof held.dispose === 'function'
      ? [held.dispose]
      : []
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try { disposers[index]?.() } catch {}
  }
}

function releaseAgentToolRestriction(agent, restrictions) {
  if (!isObject(agent)) return
  const held = restrictions.get(agent)
  if (!held) return
  disposeHeldRestriction(held)
  restrictions.delete(agent)
}

function warnRestrictionFailure(agent, error, deny, failed = deny) {
  try {
    agent?.ctx?.logger?.warn?.(
      'vision-router: failed to restrict Session vision tools while Vision mode is off: %s (deny=%s failed=%s)',
      error?.message ?? String(error),
      deny.join(','),
      failed.join(','),
    )
  } catch {}
}

function syncAgentToolRestriction(agent, enabled, restrictions, owned) {
  if (!isObject(agent)) return
  if (enabled) {
    releaseAgentToolRestriction(agent, restrictions)
    return
  }

  const tools = agent?.ctx?.tools
  const restrict = tools?.restrict
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
    // Current DSH can mask all inherited plugin tools in one scoped operation.
    const dispose = restrict.call(tools, { deny })
    restrictions.set(agent, {
      signature,
      disposers: typeof dispose === 'function' ? [dispose] : [],
    })
    return
  } catch (combinedError) {
    // Some support-window Hosts validate a deny list all-or-nothing. One
    // temporarily non-restrictable registration must not keep every other
    // Vision Router capability visible, so retry each owned name separately.
    const disposers = []
    const failed = []
    for (const name of deny) {
      try {
        const dispose = restrict.call(tools, { deny: [name] })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch {
        failed.push(name)
      }
    }
    if (disposers.length > 0) restrictions.set(agent, { signature, disposers })
    if (failed.length > 0 || disposers.length === 0) {
      warnRestrictionFailure(agent, combinedError, deny, failed.length > 0 ? failed : deny)
    }
  }
}

function projectAssemblyTools(assembly, enabled, owned) {
  if (enabled || !isObject(assembly) || !Array.isArray(assembly.tools) || owned.size === 0) {
    return assembly
  }
  const tools = assembly.tools.filter((tool) => {
    const name = typeof tool?.name === 'string' ? tool.name : undefined
    return name === undefined || !owned.has(name)
  })
  if (tools.length === assembly.tools.length) return assembly
  return { ...assembly, tools }
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
        rememberOwnedTool(owned, definition.name)
        if (typeof registered !== 'function') return registered
        let active = true
        return () => {
          if (!active) return
          active = false
          try {
            return registered()
          } finally {
            forgetOwnedTool(owned, definition.name)
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
 * boundary snapshots that fact at prompt assembly, keeps registration global,
 * and projects visibility/execution authority per Agent. Global `tool=false`
 * remains a second independent gate: selecting a Router route never expands a
 * capability the user disabled in Settings.
 *
 * There are two model-facing gates on purpose. Current DSH exposes
 * agent-scoped tools.restrict(), and a private prompt variable applies that mask
 * before tool providers / Code Mode SDK rendering. The authoritative
 * system-prompt/assemble waterfall then removes any owned native schemas that a
 * support-window Host still contributed despite the mask. Execution is guarded
 * again at the tool body, so stale schemas/direct dispatch cannot read images.
 *
 * Assembly snapshots are keyed by the concrete AssembleContext, not by Agent.
 * An out-of-band diagnostic assembly can therefore render the next live
 * selection without clearing or overwriting the immutable authority already
 * active for a running step. Only a request assembly carrying DSH's turn signal
 * is promoted for the immediately following agent/pre-step.
 *
 * It deliberately lives outside the retired legacy-core policy bridge, whose
 * identity-only closure contract remains frozen.
 */
export function installSessionVisionModeBoundary(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const restrictions = new WeakMap()
  const assemblySnapshots = new WeakMap()
  const ownedVisionTools = new Map()
  let toolsView

  const resolveForAgent = (agent, options = {}) => resolveSessionVisionModeAuthority(
    ctx,
    agent,
    liveConfig(ctx, config),
    options,
  )

  const clearAgent = (agent) => {
    clearSessionVisionModeAuthorityForAgent(agent)
  }

  const syncForAgent = (agent) => {
    if (!isObject(agent)) return
    const authority = resolveForAgent(agent)
    syncAgentToolRestriction(
      agent,
      visionToolSurfaceEnabled(ctx, config, authority),
      restrictions,
      ownedVisionTools,
    )
  }

  const captureForAssembly = (context) => {
    if (!isObject(context)) return undefined
    const agent = assemblyAgent(context)
    if (!isObject(agent)) return undefined
    const authority = resolveForAgent(agent)
    assemblySnapshots.set(context, authority)
    if (isStepAssembly(context)) {
      // Stage the next step without touching agentAuthorities: a previous step
      // may still be executing tools under its already-promoted snapshot.
      rememberSessionVisionModeAssemblyAuthorityForAgent(authority, agent)
      syncAgentToolRestriction(
        agent,
        visionToolSurfaceEnabled(ctx, config, authority),
        restrictions,
        ownedVisionTools,
      )
    }
    return authority
  }

  // DSH evaluates prompt variables synchronously before tool providers. The
  // side effect therefore updates scoped visibility before native schemas and
  // Code Mode's tools:sdk are generated for real Agent-loop assemblies. The
  // returned variable is unused and never reaches the model.
  try {
    const systemPrompt = ctx?.systemPrompt ?? ctx?.get?.('systemPrompt')
    if (typeof systemPrompt?.variable === 'function') {
      systemPrompt.variable(MODE_SYNC_VARIABLE, (context) => {
        captureForAssembly(context)
        return ''
      })
    }
  } catch {
    // The final assembly projection and execution guard below remain available
    // on minimum/support-window Hosts without prompt variables.
  }

  // The returned assembly is the model-facing authority in DSH. Filter only
  // definitions that were registered through this plugin boundary; a foreign
  // plugin is free to own a vision_* name without being coupled to our switch.
  try {
    ctx.on?.('system-prompt/assemble', async (assembly, context, next) => {
      const agent = assemblyAgent(context)
      let authority = isObject(context) ? assemblySnapshots.get(context) : undefined
      if (!authority && isObject(context)) authority = captureForAssembly(context)
      if (!authority && isObject(agent)) authority = resolveForAgent(agent)
      const transformed = typeof next === 'function' ? await next() : assembly
      return projectAssemblyTools(
        transformed,
        visionToolSurfaceEnabled(ctx, config, authority),
        ownedVisionTools,
      )
    })
  } catch {
    // Pre-step/execution guards still fail closed on Hosts without this event.
  }

  // A waking Agent enters `running` before its first prompt/tool assembly.
  // Refresh visibility there as an early fallback, but do not persist the step
  // snapshot until prompt assembly itself: a picker change between wakeup and
  // assembly must still win for that request.
  try {
    ctx.on?.('agent/status', ({ agent, status }) => {
      if (status === 'running') {
        clearAgent(agent)
        syncForAgent(agent)
      } else if (status === 'idle') {
        clearAgent(agent)
      }
    })
    ctx.on?.('agent/created', ({ agent }) => {
      clearAgent(agent)
      syncForAgent(agent)
    })
    ctx.on?.('agent/disposed', ({ agent }) => {
      clearAgent(agent)
      releaseAgentToolRestriction(agent, restrictions)
    })
  } catch {
    // Minimum Hosts may not expose every lifecycle event. Prompt assembly and
    // execution guards preserve the safety boundary without making apply fail.
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
            // Prompt assembly is the DSH selection-snapshot boundary. Consume
            // exactly that staged snapshot here; direct/minimum Host pre-step
            // calls resolve fresh authority instead of reusing an old step.
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
              visionToolSurfaceEnabled(target, config, authority),
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

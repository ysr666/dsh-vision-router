import {
  explainVisionRoute,
  inferToolVisionIntent,
  suggestVisionOrder,
} from './vision-capability-router.js'
import { createCapabilityProfileStore } from './vision-capability-probe.js'
import { resolveVisionRoutingProduct } from './vision-routing-product.js'
import { resolveVisionRoutingAuthority } from './vision-routing-authority.js'
import { withVisionRuntimePerformanceScope } from './vision-runtime-performance.js'
import {
  candidateKeyForConfiguredPair,
  collectVisionRoutingEvidence,
  configuredVisionPairs,
} from './vision-routing-evidence.js'
import { executionOrderForSuggestedKeys } from './vision-execution-order-plan.js'
import { withVisionExecutionOrder } from './vision-execution-order.js'

const ROUTING_TOOLS = new Set([
  'vision_bootstrap',
  'vision_describe',
  'vision_ground',
  'vision_detect',
  'vision_ocr',
  'vision_long_screenshot_ocr',
])

function bounded(value, max = 2000) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

function bootstrapEvidence(value) {
  const parsed = parseJson(value)
  return parsed && parsed.ok === true && parsed.evidence && typeof parsed.evidence === 'object'
    ? parsed.evidence
    : undefined
}

// Foreground execution authority must come from the live Host-owned settings
// document. Composition defaults are never an execution grant.
function liveSettings(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return plainObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

function cloneConfig(value) {
  if (!plainObject(value)) return value
  try { return structuredClone(value) } catch { return { ...value } }
}

function configSnapshot(value) {
  if (!plainObject(value)) return undefined
  try { return JSON.stringify(value) } catch { return undefined }
}

export async function buildVisionRoutingPlan({
  ctx,
  config,
  core,
  store,
  runtimePerformanceStore,
  toolName,
  args,
  bootstrap,
  healthForCandidate,
  healthContext,
} = {}) {
  const routing = resolveVisionRoutingProduct(config)
  const { candidates, measured, health } = await collectVisionRoutingEvidence({
    ctx,
    config,
    core,
    store,
    runtimePerformanceStore,
    healthForCandidate,
    healthContext,
  })
  const intent = inferToolVisionIntent(toolName, args, { bootstrap })
  const suggestion = suggestVisionOrder({
    intent,
    strategy: routing.strategy,
    candidates,
    measured,
    health,
  })
  const ranked = suggestion.ranked
  const autoPreviewOrder = ranked.map((candidate) => candidate.key)
  return {
    intent,
    routingMode: routing.mode,
    routingPreference: routing.preference,
    strategy: routing.strategy,
    currentOrder: candidates.map((candidate) => candidate.key),
    autoPreviewOrder,
    suggestedOrder: autoPreviewOrder,
    decisions: suggestion.decisions,
    incomparableBackends: suggestion.incomparableBackends,
    explanation: explainVisionRoute(ranked),
    measuredBackends: candidates.filter((candidate) => candidate.measured).map((candidate) => candidate.key),
    unmeasuredBackends: candidates.filter((candidate) => !candidate.measured).map((candidate) => candidate.key),
    healthBackends: Object.keys(health),
    blockedBackends: suggestion.blockedBackends,
  }
}

function wrapTools(
  tools,
  ctx,
  core,
  store,
  runtimePerformanceStore,
  bootstrapBySession,
  logger,
  healthForCandidate,
) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  return new Proxy(tools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (def) => {
        if (!def || !ROUTING_TOOLS.has(def.name) || typeof def.execute !== 'function') {
          return register.call(target, def)
        }
        const wrapped = {
          ...def,
          async execute(args, exec) {
            return withVisionRuntimePerformanceScope(def.name, args, async () => {
              const liveAtPlan = liveSettings(ctx)
              const authorityAtPlan = resolveVisionRoutingAuthority(liveAtPlan ?? {})
              const session = exec?.agent?.session
              let plan
              let planSnapshot

              if (authorityAtPlan.autoSelectionAuthorized) {
                try {
                  const planningConfig = cloneConfig(liveAtPlan)
                  planSnapshot = configSnapshot(planningConfig)
                  plan = await buildVisionRoutingPlan({
                    ctx,
                    config: planningConfig,
                    core,
                    store,
                    runtimePerformanceStore,
                    toolName: def.name,
                    args,
                    bootstrap: session ? bootstrapBySession.get(session) : undefined,
                    healthForCandidate,
                    healthContext: { session, exec, toolName: def.name, args },
                  })
                } catch (error) {
                  // Planning/evidence failures are never execution failures.
                  // The original configured order remains authoritative.
                  logger?.warn?.(
                    'vision-router: auto planning failed: %s',
                    bounded(error?.message ?? error, 400),
                  )
                  plan = undefined
                }
              }

              const executeOriginal = () => def.execute(args, exec)
              let result
              if (plan && authorityAtPlan.autoSelectionAuthorized && planSnapshot !== undefined) {
                // Re-read authority and the complete settings document after
                // async evidence collection. A stale plan is never executed.
                const liveBeforeExecute = liveSettings(ctx)
                const authorityBeforeExecute = resolveVisionRoutingAuthority(liveBeforeExecute ?? {})
                const settingsUnchanged = configSnapshot(liveBeforeExecute) === planSnapshot
                if (authorityBeforeExecute.autoSelectionAuthorized && settingsUnchanged) {
                  const executionOrder = executionOrderForSuggestedKeys(
                    liveBeforeExecute,
                    plan.autoPreviewOrder,
                  )
                  if (executionOrder) {
                    const selectedOrder = executionOrder
                      .map(candidateKeyForConfiguredPair)
                      .filter(Boolean)
                    logger?.info?.(
                      'vision-router: v2 auto execute preference=%s intent=%s configured=[%s] selected=[%s]',
                      plan.routingPreference,
                      plan.intent,
                      bounded(
                        configuredVisionPairs(liveBeforeExecute)
                          .map(candidateKeyForConfiguredPair)
                          .filter(Boolean)
                          .join(' -> '),
                        1200,
                      ),
                      bounded(selectedOrder.join(' -> '), 1200),
                    )
                    result = await withVisionExecutionOrder(executionOrder, executeOriginal)
                  } else {
                    result = await executeOriginal()
                  }
                } else {
                  const reason = authorityBeforeExecute.autoSelectionAuthorized
                    ? 'settings-changed'
                    : 'authority-revoked'
                  logger?.info?.(
                    'vision-router: auto skipped before execution reason=%s',
                    reason,
                  )
                  result = await executeOriginal()
                }
              } else {
                result = await executeOriginal()
              }

              if (session && def.name === 'vision_bootstrap') {
                const evidence = bootstrapEvidence(result)
                if (evidence !== undefined) bootstrapBySession.set(session, evidence)
              }
              return result
            })
          },
        }
        return register.call(target, wrapped)
      }
    },
  })
}

/**
 * Foreground capability-aware routing boundary.
 *
 * Invariants:
 * - authority is read from live Host settings only;
 * - Evidence/Planner receive copied data and cannot mutate authority;
 * - settings are re-read after asynchronous planning;
 * - selected execution order contains only { provider, model } and lives only
 *   inside VisionExecutionOrderContext;
 * - no Settings/register/get/inject service is proxied or impersonated.
 */
export function installVisionRoutingRuntime(ctx, config, core, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const logger = options.logger ?? ctx.logger
  const store = options.store ?? createCapabilityProfileStore({ logger })
  const runtimePerformanceStore = options.runtimePerformanceStore
  const healthForCandidate = options.healthForCandidate
  const bootstrapBySession = new WeakMap()
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') {
        return wrapTools(
          target.tools,
          target,
          core,
          store,
          runtimePerformanceStore,
          bootstrapBySession,
          logger,
          healthForCandidate,
        )
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
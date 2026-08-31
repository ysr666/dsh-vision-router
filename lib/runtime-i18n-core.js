import { createRuntimeI18n } from './runtime-i18n.js'
import { installRuntimeI18nBoundary } from './runtime-i18n-boundary.js'

function localizeGuardStopPlan(plan, i18n) {
  if (i18n.language() !== 'en' || !plan?.data || !Array.isArray(plan.data.content)) return plan
  let changed = false
  const content = plan.data.content.map((block) => {
    if (!block || block.type !== 'text' || block.text !== '[vision-router: 系统提示已过期]') return block
    changed = true
    return { ...block, text: i18n.t('staleSystemPrompt') }
  })
  return changed ? { ...plan, data: { ...plan.data, content } } : plan
}

function projectLegacyCoreBootConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (value.autoActivateOnImage === false) return value
  return { ...value, autoActivateOnImage: false }
}

/**
 * Keep runtime i18n at the Core boundary instead of projecting locale through
 * the whole composition graph. Runtime composition, capability evidence,
 * settings compatibility and routing policy all keep their existing context;
 * only legacy Core emissions enter installRuntimeI18nBoundary().
 *
 * SessionVisionIndex calls planGuardStopShadows before Core.apply, so that one
 * helper is localized explicitly through the same live Host locale reader.
 */
export function createRuntimeI18nCoreFacade(core, hostCtx) {
  if (!core || typeof core !== 'object') return core
  const i18n = createRuntimeI18n(hostCtx)
  return new Proxy(core, {
    get(target, property, receiver) {
      if (property === 'apply') {
        return (runtimeCtx, runtimeConfig = {}, ...rest) => {
          // The boundary must see the real config so it can honor auto-mount
          // even before Settings is available. Only the legacy Core view is
          // projected false, making its prose-parsing auto-mount branch
          // unreachable during both boot fallback and live Settings reads.
          const localizedCtx = installRuntimeI18nBoundary(runtimeCtx, runtimeConfig)
          const legacyCoreConfig = projectLegacyCoreBootConfig(runtimeConfig)
          return target.apply(localizedCtx, legacyCoreConfig, ...rest)
        }
      }
      if (property === 'planGuardStopShadows' && typeof target.planGuardStopShadows === 'function') {
        return (...args) => {
          const plans = target.planGuardStopShadows(...args)
          return Array.isArray(plans) ? plans.map((plan) => localizeGuardStopPlan(plan, i18n)) : plans
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

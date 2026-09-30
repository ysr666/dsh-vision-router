import { createRuntimeI18n } from './runtime-i18n.js'

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

/**
 * Localize the one legacy-Core helper that SessionVisionIndex calls before
 * Core.apply. Final Core ownership stays direct in runtime-composition.js and
 * receives its runtime i18n view from createRuntimeI18nCoreScope instead of an
 * apply facade, preserving the frozen composition identity contract.
 */
export function createRuntimeI18nCoreFacade(core, hostCtx) {
  if (!core || typeof core !== 'object') return core
  const i18n = createRuntimeI18n(hostCtx)
  return new Proxy(core, {
    get(target, property, receiver) {
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

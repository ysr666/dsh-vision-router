const LEGACY_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'dsh-vision-router' })
const PRODUCER_SOURCE = Object.freeze({ kind: 'plugin:dsh-vision-router' })

function sourceKindForSession(session) {
  const version = Number(session?.header?.version)
  return Number.isInteger(version) && version >= 4 ? PRODUCER_SOURCE : LEGACY_SOURCE
}

function isVisionRouterSource(source) {
  return !!source && typeof source === 'object' && !Array.isArray(source) && (
    (source.kind === 'plugin' && source.plugin === 'dsh-vision-router') ||
    source.kind === 'plugin:dsh-vision-router'
  )
}

/** Return the canonical DVR message source for one live Session format. */
export function visionRouterMessageSource(session) {
  return { ...sourceKindForSession(session) }
}

/** Normalize one DVR-authored message without touching user/model/tool sources. */
export function normalizeVisionRouterMessageSource(message, session) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message
  if (!isVisionRouterSource(message.source)) return message
  const source = sourceKindForSession(session)
  if (message.source.kind === source.kind
      && (source.kind !== 'plugin' || message.source.plugin === source.plugin)
      && Object.keys(message.source).length === Object.keys(source).length) {
    return message
  }
  return { ...message, source: { ...source } }
}

function normalizeMessageList(list, session) {
  if (!Array.isArray(list)) return list
  let changed = false
  const next = list.map((message) => {
    const normalized = normalizeVisionRouterMessageSource(message, session)
    if (normalized !== message) changed = true
    return normalized
  })
  return changed ? next : list
}

function normalizePreStepResult(result, payload) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const messages = normalizeMessageList(result.messages, payload?.agent?.session)
  return messages === result.messages ? result : { ...result, messages }
}

function normalizePostExecuteResult(result, exec) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const additionalContexts = normalizeMessageList(result.additionalContexts, exec?.agent?.session)
  return additionalContexts === result.additionalContexts ? result : { ...result, additionalContexts }
}

function normalizeHookResult(event, args, result) {
  if (event === 'agent/pre-step') return normalizePreStepResult(result, args[0])
  if (event === 'tools/post-execute') return normalizePostExecuteResult(result, args[0])
  return result
}

/**
 * DSH Session V3 requires the historical {kind:'plugin', plugin:...} source,
 * while V4 rejects that wrapper in favor of producer-owned source kinds. Keep
 * every existing DVR message producer unchanged and normalize at the final
 * hook publication boundary using the Session's own durable header version.
 */
export function installVisionRouterMessageSourceBoundary(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx
  return new Proxy(ctx, {
    get(target, property) {
      if (property !== 'on') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const on = Reflect.get(target, property, target)
      if (typeof on !== 'function') return on
      return (event, handler, ...rest) => {
        if ((event !== 'agent/pre-step' && event !== 'tools/post-execute') || typeof handler !== 'function') {
          return on.call(target, event, handler, ...rest)
        }
        return on.call(target, event, function sourceCompatibleHook(...args) {
          const output = handler.apply(this, args)
          return output && typeof output.then === 'function'
            ? output.then((value) => normalizeHookResult(event, args, value))
            : normalizeHookResult(event, args, output)
        }, ...rest)
      }
    },
  })
}

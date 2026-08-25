const SETTINGS_NS = 'vision-router'
const TURN_BUDGET_CODE = 'VISION_TURN_BUDGET_EXCEEDED'
const GUARD_PREFIX = 'vision-router-structured-guard-stop-'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function parseResult(value) {
  if (isObject(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

function settingsService(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    return settings && typeof settings === 'object' ? settings : undefined
  } catch {
    return undefined
  }
}

function sourceFor(descriptor, key) {
  if (hasOwn(descriptor?.user, key)) return 'user'
  if (hasOwn(descriptor?.base, key)) return 'composition'
  return 'default'
}

export function resolveVisionLimitDiagnostics(ctx, fallbackConfig = {}) {
  const settings = settingsService(ctx)
  let value
  let descriptor
  try { value = settings?.get?.(SETTINGS_NS) } catch { value = undefined }
  try {
    const described = settings?.describe?.({ redactSecrets: true })
    descriptor = Array.isArray(described)
      ? described.find((entry) => entry?.ns === SETTINGS_NS)
      : undefined
  } catch {
    descriptor = undefined
  }
  const effective = isObject(value) ? value : isObject(descriptor?.value) ? descriptor.value : fallbackConfig
  const taskTimeoutMs = Number.isFinite(Number(effective?.visionTaskTimeoutMs))
    ? Number(effective.visionTaskTimeoutMs)
    : 120000
  const turnBudgetMs = Number.isFinite(Number(effective?.visionTurnBudgetMs))
    ? Number(effective.visionTurnBudgetMs)
    : 0
  return {
    taskTimeoutMs,
    turnBudgetMs,
    taskSource: descriptor ? sourceFor(descriptor, 'visionTaskTimeoutMs') : 'unknown',
    turnSource: descriptor ? sourceFor(descriptor, 'visionTurnBudgetMs') : 'unknown',
  }
}

export function formatVisionTurnGuard(turnBudgetMs) {
  const ms = Number(turnBudgetMs)
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : undefined
  const limit = seconds === undefined ? '' : `（${seconds} 秒）`
  return `Vision Router 本轮视觉时间上限${limit}已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。默认配置为“不限制”；长任务如需继续识图，请检查“设置 → Vision Router → 高级 → 首次识图后的整轮时间上限”。`
}

function replaceGuardText(decision, turnBudgetMs) {
  if (!isObject(decision) || !Array.isArray(decision.messages)) return decision
  let anyChanged = false
  const messages = decision.messages.map((message) => {
    if (!isObject(message) || typeof message.id !== 'string' || !message.id.startsWith(GUARD_PREFIX)) return message
    if (!Array.isArray(message.content)) return message
    let messageChanged = false
    const content = message.content.map((block) => {
      if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return block
      if (!block.text.includes('本轮视觉总时间预算已耗尽')) return block
      messageChanged = true
      anyChanged = true
      return { ...block, text: formatVisionTurnGuard(turnBudgetMs) }
    })
    return messageChanged ? { ...message, content } : message
  })
  return anyChanged ? { ...decision, messages } : decision
}

export function installVisionLimitDiagnostics(ctx, fallbackConfig = {}, logger) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const turnState = new WeakMap()
  let startupLogged = false

  const snapshot = () => resolveVisionLimitDiagnostics(ctx, fallbackConfig)
  const logStartup = () => {
    if (startupLogged) return
    const limits = snapshot()
    startupLogged = true
    logger?.info?.(
      'vision-router: effective vision limits taskTimeoutMs=%d taskSource=%s turnBudgetMs=%d turnSource=%s',
      limits.taskTimeoutMs,
      limits.taskSource,
      limits.turnBudgetMs,
      limits.turnSource,
    )
  }

  try {
    ctx.inject?.(['settings'], (settingsCtx) => {
      settingsCtx.effect?.(() => {
        queueMicrotask(logStartup)
        return () => {}
      }, 'vision-router: report effective vision limits')
    })
  } catch {
    // Diagnostics are best-effort and must never block plugin startup.
  }

  const stateForVisualCall = (session, turnHint) => {
    if (!session) return undefined
    let state = turnState.get(session)
    if (!state || (turnHint !== undefined && state.turn !== turnHint)) {
      state = { turn: turnHint, startedAt: undefined, exhaustionLogged: false }
      turnState.set(session, state)
    }
    if (state.startedAt === undefined) state.startedAt = Date.now()
    return state
  }

  const wrapTool = (def) => {
    if (!def || typeof def.execute !== 'function') return def
    if (def.name !== 'vision_bootstrap' && !String(def.name || '').startsWith('vision_')) return def
    return {
      ...def,
      async execute(args, exec) {
        const session = exec?.agent?.session
        const state = stateForVisualCall(session, exec?.agent?.turn ?? exec?.turn)
        const result = await def.execute(args, exec)
        const parsed = parseResult(result)
        if (parsed?.code !== TURN_BUDGET_CODE) return result
        if (state?.exhaustionLogged) return result
        if (state) state.exhaustionLogged = true
        const limits = snapshot()
        const elapsedMs = state?.startedAt === undefined
          ? undefined
          : Math.max(0, Date.now() - state.startedAt)
        logger?.warn?.(
          'vision-router: vision turn deadline exhausted turn=%s budgetMs=%d elapsedMs=%s',
          state?.turn === undefined ? 'unknown' : String(state.turn),
          limits.turnBudgetMs,
          elapsedMs === undefined ? 'unknown' : String(elapsedMs),
        )
        return result
      },
    }
  }

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') {
        const tools = target.tools
        if (!tools || typeof tools !== 'object') return tools
        return new Proxy(tools, {
          get(toolTarget, toolProperty) {
            if (toolProperty !== 'register') {
              const value = Reflect.get(toolTarget, toolProperty, toolTarget)
              return typeof value === 'function' ? value.bind(toolTarget) : value
            }
            const register = Reflect.get(toolTarget, toolProperty, toolTarget)
            return (def) => register.call(toolTarget, wrapTool(def))
          },
        })
      }
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(target, event, async function issue307GuardDiagnostics(payload, next) {
            const session = payload?.agent?.session
            if (session) {
              const current = turnState.get(session)
              if (!current || current.turn !== payload?.turn) {
                turnState.set(session, {
                  turn: payload?.turn,
                  startedAt: undefined,
                  exhaustionLogged: false,
                })
              }
            }
            const decision = await handler.call(this, payload, next)
            const limits = snapshot()
            return replaceGuardText(decision, limits.turnBudgetMs)
          }, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

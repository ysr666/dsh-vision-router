import {
  currentVisionTurnBudget,
  runWithVisionTurnBudget,
} from './turn-budget-context.js'
import { runWithDepthConfig } from './depth-guidance.js'

const STRUCTURED_EVIDENCE_TOOLS = new Set([
  'vision_describe',
  'vision_ground',
  'vision_detect',
  'vision_ocr',
  'vision_colors',
  'vision_pixel_diff',
  'vision_long_screenshot_ocr',
])

const DEFAULT_TURN_BUDGET_MS = 0
const MAX_TURN_BUDGET_MS = 600_000
const MAX_GUIDANCE_OVERRIDES = 14
const MAX_GUIDANCE_CHARS = 2_000
const BUDGETED_TIMEOUT_FIELDS = ['timeoutMs', 'visionTaskTimeoutMs', 'ocrTimeoutMs']
const GUIDANCE_KINDS = new Set([
  'code',
  'document',
  'ui',
  'chat',
  'person',
  'animal',
  'plant',
  'food',
  'vehicle',
  'machine',
  'architecture',
  'object',
  'scene',
  'meme',
])

const BUILTIN_MIXED_GUIDANCE = {
  document: '语义优先；只有逐字引用、合同/表单字段或表格数字确需保真时才使用 OCR。',
  ui: '优先用 vision_detect / vision_ground 验证元素、状态与位置。',
  code: '逐字核对代码；对可执行字符、缩进和符号做交叉验证。',
  chat: '按气泡顺序核对发言者、消息内容与时间/状态信息。',
  general: '聚焦尚未归类的另一部分可见内容，自行选择最能新增证据的视觉工具。',
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function parseJson(value) {
  if (isObject(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function resultCode(value) {
  const parsed = parseJson(value)
  return isObject(parsed) && typeof parsed.code === 'string' ? parsed.code : undefined
}

export function producedStructuredEvidence(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return false
    const parsed = parseJson(text)
    if (parsed === undefined) return true
    return producedStructuredEvidence(parsed)
  }
  if (Array.isArray(value)) return true
  if (!isObject(value)) return false
  if (value.ok === false) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  if (keys.length === 1 && keys[0] === 'ok' && value.ok !== true) return false
  return true
}

/**
 * The depth tier is guidance only. A hard call cap exists only when the user
 * explicitly configures a positive visionDepthMaxCalls value.
 */
export function structuredDepthLimit(_depth, maxCalls) {
  const value = Number(maxCalls)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.min(100, Math.max(1, Math.floor(value)))
}

export function normalizeGuidanceOverrides(value) {
  if (!Array.isArray(value)) return []
  const byKind = new Map()
  for (const entry of value) {
    if (!isObject(entry)) continue
    const kind = typeof entry.kind === 'string' ? entry.kind.trim() : ''
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!GUIDANCE_KINDS.has(kind) || text === '') continue
    // Last row wins. This makes duplicate imports deterministic and mirrors
    // what users expect after editing a later row in the settings UI.
    byKind.set(kind, text.slice(0, MAX_GUIDANCE_CHARS))
  }
  return [...byKind.entries()]
    .slice(-MAX_GUIDANCE_OVERRIDES)
    .map(([kind, text]) => ({ kind, text }))
}

function guidanceFor(kind, overrides) {
  for (let i = overrides.length - 1; i >= 0; i--) {
    const entry = overrides[i]
    if (entry.kind === kind) return entry.text
  }
  return BUILTIN_MIXED_GUIDANCE[kind] ?? '聚焦这个分支新增或验证可见证据。'
}

function turnBudgetMs(config) {
  const value = Number(config?.visionTurnBudgetMs)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TURN_BUDGET_MS
  return Math.min(Math.max(Math.round(value), 10_000), MAX_TURN_BUDGET_MS)
}

function depthOf(config) {
  return config?.visionDepth === 'fast' || config?.visionDepth === 'deep' || config?.visionDepth === 'custom'
    ? config.visionDepth
    : 'standard'
}

function hostLocalePreference(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    const locale = settings?.get?.('locale')
    const preference = locale && typeof locale === 'object' ? locale.preference : undefined
    return typeof preference === 'string' && preference.trim() !== '' ? preference.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Clamp the core's own timeout settings to the remaining optional structured-
 * turn deadline. When the whole-turn budget is disabled (the default), there
 * is no ambient deadline and the existing per-task/provider timeouts stay
 * authoritative.
 */
export function capConfigToVisionTurnBudget(value, now = Date.now) {
  if (!value || typeof value !== 'object') return value
  const budget = currentVisionTurnBudget()
  if (!budget || !Number.isFinite(Number(budget.deadlineAt))) return value
  const clock = typeof now === 'function' ? now : Date.now
  const remaining = Math.max(0, Number(budget.deadlineAt) - Number(clock()))
  const cap = Math.max(1, Math.floor(remaining))
  let next
  for (const field of BUDGETED_TIMEOUT_FIELDS) {
    const current = Number(value[field])
    if (!Number.isFinite(current) || current <= cap) continue
    if (next === undefined) next = { ...value }
    next[field] = cap
  }
  return next ?? value
}

function freshState(turn, _config) {
  return {
    turn,
    startedAt: undefined,
    deadlineAt: undefined,
    turnSignal: undefined,
    bootstrapDone: false,
    bootstrapResult: undefined,
    successfulEvidenceCalls: 0,
    mixedBranches: [],
    completedBranches: new Set(),
    budgetExhausted: false,
    depthExhausted: false,
    emittedGuardIds: new Set(),
  }
}

function activateBudget(state, config) {
  if (state.turnSignal !== undefined) return
  const budgetMs = turnBudgetMs(config)
  if (budgetMs <= 0) return
  const startedAt = Date.now()
  state.startedAt = startedAt
  state.deadlineAt = startedAt + budgetMs
  state.turnSignal = AbortSignal.timeout(budgetMs)
}

function ensureState(states, session, turn, config) {
  let state = states.get(session)
  if (!state || state.turn !== turn) {
    state = freshState(turn, config)
    states.set(session, state)
  }
  return state
}

function currentState(states, session, config) {
  let state = states.get(session)
  if (!state) {
    state = freshState(undefined, config)
    states.set(session, state)
  }
  return state
}

function budgetExceeded(state) {
  if (state.turnSignal === undefined || !Number.isFinite(Number(state.deadlineAt))) return false
  return state.turnSignal.aborted === true || Date.now() >= state.deadlineAt
}

function bootstrapEvidence(raw) {
  const parsed = parseJson(raw)
  if (!isObject(parsed) || parsed.ok !== true || !isObject(parsed.evidence)) return undefined
  return parsed.evidence
}

function normalizeMixedBranches(evidence, _depth) {
  if (!isObject(evidence) || evidence.visual_kind !== 'mixed' || !Array.isArray(evidence.mixed_of)) return []
  const allowed = ['ui', 'document', 'code', 'chat', 'general']
  const unique = []
  for (const kind of allowed) {
    if (evidence.mixed_of.includes(kind)) unique.push(kind)
  }
  return unique.slice(0, 2)
}

function inferBranchForTool(name, pending) {
  const prefer = (kinds) => kinds.find((kind) => pending.includes(kind))
  if (name === 'vision_detect' || name === 'vision_ground') return prefer(['ui', 'general'])
  if (name === 'vision_long_screenshot_ocr') return prefer(['document', 'chat', 'code', 'general'])
  if (name === 'vision_ocr') return prefer(['document', 'code', 'chat', 'general'])
  if (name === 'vision_colors' || name === 'vision_pixel_diff') return prefer(['general', 'ui'])
  return pending[0]
}

function recordEvidenceSuccess(state, name) {
  state.successfulEvidenceCalls += 1
  if (state.mixedBranches.length === 0) return
  const pending = state.mixedBranches.filter((kind) => !state.completedBranches.has(kind))
  const branch = inferBranchForTool(name, pending)
  if (branch) state.completedBranches.add(branch)
}

function missingEvidence(state) {
  if (state.mixedBranches.length > 0) {
    return state.mixedBranches.filter((kind) => !state.completedBranches.has(kind)).length
  }
  return state.successfulEvidenceCalls >= 1 ? 0 : 1
}

function hasCoreFollowup(messages) {
  return Array.isArray(messages) && messages.some(
    (message) => message && typeof message.id === 'string' && message.id.includes('vision-router-structured-followup-'),
  )
}

function withoutCoreFollowup(messages) {
  return (messages ?? []).filter(
    (message) => !(message && typeof message.id === 'string' && message.id.includes('vision-router-structured-followup-')),
  )
}

function hasMessageId(messages, id) {
  return Array.isArray(messages) && messages.some(
    (message) => message && typeof message.id === 'string' && message.id === id,
  )
}

function appendSyntheticGuardOnce(decision, baseMessages, state, message, stripCoreFollowup = false) {
  const messages = stripCoreFollowup ? withoutCoreFollowup(baseMessages) : baseMessages
  const id = message?.id
  if (typeof id === 'string' && (state.emittedGuardIds.has(id) || hasMessageId(messages, id))) {
    state.emittedGuardIds.add(id)
    return stripCoreFollowup ? { ...decision, messages } : decision
  }
  if (typeof id === 'string') state.emittedGuardIds.add(id)
  return {
    ...decision,
    messages: [...messages, message],
  }
}

function mixedReminder(state, config) {
  const overrides = normalizeGuidanceOverrides(config?.guidanceOverrides)
  const pending = state.mixedBranches.filter((kind) => !state.completedBranches.has(kind))
  const done = state.mixedBranches.filter((kind) => state.completedBranches.has(kind))
  const lines = pending.map((kind) => `- ${kind}：${guidanceFor(kind, overrides)}`)
  const doneText = done.length > 0 ? `已验证分支：${done.join(' + ')}。` : ''
  return `${doneText}混合图片仍有未验证分支：${pending.join(' + ')}。` +
    '每次视觉调用只聚焦一个尚未完成的分支；这些分支分别产生至少一次有效证据后再作答。\n' +
    lines.join('\n')
}

function appendGuardMessage(decision, payload, state, config) {
  if (!decision || typeof decision !== 'object') return decision
  const baseMessages = Array.isArray(decision.messages)
    ? decision.messages
    : Array.isArray(payload?.messages)
      ? payload.messages
      : []

  if (state.budgetExhausted || state.depthExhausted) {
    const message = {
      role: 'user',
      id: `vision-router-structured-guard-stop-${state.turn}`,
      content: [{
        type: 'text',
        text: state.budgetExhausted
          ? '本轮视觉总时间预算已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。'
          : '本轮识图深度配额已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。',
      }],
      source: { kind: 'plugin', plugin: 'dsh-vision-router' },
    }
    return appendSyntheticGuardOnce(decision, baseMessages, state, message, true)
  }

  if (!state.bootstrapDone || missingEvidence(state) === 0) return decision

  if (state.mixedBranches.length > 0) {
    const message = {
      role: 'user',
      id: `vision-router-structured-mixed-guard-${state.turn}-${state.successfulEvidenceCalls}`,
      content: [{ type: 'text', text: mixedReminder(state, config) }],
      source: { kind: 'plugin', plugin: 'dsh-vision-router' },
    }
    return appendSyntheticGuardOnce(decision, baseMessages, state, message, true)
  }

  if (hasCoreFollowup(baseMessages)) return decision
  const message = {
    role: 'user',
    id: `vision-router-structured-evidence-guard-${state.turn}`,
    content: [{
      type: 'text',
      text: '结构化预识别已经完成，但上一条后续工具没有产出可用证据。请再调用至少一个能新增或验证证据的视觉工具，成功后再作答。',
    }],
    source: { kind: 'plugin', plugin: 'dsh-vision-router' },
  }
  return appendSyntheticGuardOnce(decision, baseMessages, state, message)
}

function failure(code, reason) {
  return JSON.stringify({ ok: false, code, retryable: false, reason })
}

function turnBudgetAbortError() {
  const error = new Error('the structured-vision turn budget expired while the visual request was running')
  error.name = 'TimeoutError'
  error.code = 'VISION_TURN_BUDGET_EXCEEDED'
  return error
}

async function executeWithinTurnBudget(state, execute) {
  const signal = state.turnSignal
  const budget = { deadlineAt: state.deadlineAt, signal }
  return runWithVisionTurnBudget(budget, async () => {
    if (signal?.aborted) throw turnBudgetAbortError()
    let abortHandler
    const aborted = new Promise((_, reject) => {
      abortHandler = () => reject(turnBudgetAbortError())
      signal?.addEventListener('abort', abortHandler, { once: true })
    })
    try {
      // The race is a last-resort availability fence for a local helper that
      // ignores AbortSignal. Normal network/LLM/OCR work also sees the ambient
      // budget through capConfigToVisionTurnBudget and is cancelled at source.
      return await Promise.race([Promise.resolve().then(execute), aborted])
    } finally {
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
    }
  })
}

async function runBudgetedTool(state, execute, exhaustedReason, config) {
  activateBudget(state, config)
  if (budgetExceeded(state)) {
    state.budgetExhausted = true
    return failure('VISION_TURN_BUDGET_EXCEEDED', exhaustedReason)
  }
  try {
    const result = await executeWithinTurnBudget(state, execute)
    if (budgetExceeded(state)) {
      state.budgetExhausted = true
      return failure('VISION_TURN_BUDGET_EXCEEDED', exhaustedReason)
    }
    return result
  } catch (error) {
    if (error?.code === 'VISION_TURN_BUDGET_EXCEEDED' || budgetExceeded(state)) {
      state.budgetExhausted = true
      return failure('VISION_TURN_BUDGET_EXCEEDED', exhaustedReason)
    }
    throw error
  }
}

function wrapRegisteredTool(def, states, getConfig) {
  if (!def || typeof def.execute !== 'function') return def
  if (def.name !== 'vision_bootstrap' && !STRUCTURED_EVIDENCE_TOOLS.has(def.name)) return def

  return {
    ...def,
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (!session) return def.execute(args, exec)
      const currentConfig = getConfig()
      return runWithDepthConfig(currentConfig, async () => {
        const state = currentState(states, session, currentConfig)

        if (def.name === 'vision_bootstrap') {
          if (state.bootstrapDone) {
            return state.bootstrapResult ?? failure(
              'STRUCTURED_BOOTSTRAP_ALREADY_COMPLETED',
              'the structured bootstrap already completed for this turn; continue with evidence tools instead of repeating it',
            )
          }
          const result = await runBudgetedTool(
            state,
            () => def.execute(args, exec),
            'the structured-vision turn budget expired before the bootstrap could complete',
            currentConfig,
          )
          if (resultCode(result) === 'VISION_TURN_BUDGET_EXCEEDED') return result
          const evidence = bootstrapEvidence(result)
          if (evidence !== undefined) {
            state.bootstrapDone = true
            state.bootstrapResult = result
            state.mixedBranches = normalizeMixedBranches(evidence, depthOf(getConfig()))
            state.completedBranches.clear()
            state.successfulEvidenceCalls = 0
            state.budgetExhausted = false
            state.depthExhausted = false
          }
          return result
        }

        // Even an out-of-order evidence call must obey the turn wall clock. The
        // bootstrap-order guard is handled elsewhere; time accounting must not
        // disappear merely because the model chose the wrong tool first.
        if (!state.bootstrapDone) {
          return runBudgetedTool(
            state,
            () => def.execute(args, exec),
            'the structured-vision turn budget expired while the visual request was running',
            currentConfig,
          )
        }

        if (budgetExceeded(state)) {
          state.budgetExhausted = true
          return failure('VISION_TURN_BUDGET_EXCEEDED', 'the structured-vision turn budget is exhausted; answer from the evidence already collected')
        }

        const active = getConfig()
        const limit = structuredDepthLimit(depthOf(active), active?.visionDepthMaxCalls)
        if (limit !== undefined && state.successfulEvidenceCalls >= limit) {
          state.depthExhausted = true
          return failure('VISION_DEPTH_LIMIT', `the configured deep-dive call cap allows at most ${limit} successful evidence call(s) in this turn`)
        }

        const result = await runBudgetedTool(
          state,
          () => def.execute(args, exec),
          'the structured-vision turn budget is exhausted; answer from the evidence already collected',
          active,
        )
        const code = resultCode(result)
        if (code === 'VISION_DEPTH_LIMIT') state.depthExhausted = true
        if (code === 'VISION_TURN_BUDGET_EXCEEDED') state.budgetExhausted = true
        if (producedStructuredEvidence(result)) recordEvidenceSuccess(state, def.name)
        return result
      })
    },
  }
}

function wrapTools(tools, states, getConfig) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  return new Proxy(tools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      return (def) => register.call(target, wrapRegisteredTool(def, states, getConfig))
    },
  })
}

function wrapSettingsScope(scope) {
  if (!scope || typeof scope !== 'object') return scope
  return new Proxy(scope, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (...args) => capConfigToVisionTurnBudget(get.apply(target, args))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function wrapSettingsService(settings, setScope) {
  if (!settings || typeof settings !== 'object') return settings
  return new Proxy(settings, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (namespace, ...args) => {
        const scope = register.call(target, namespace, ...args)
        if (namespace !== 'vision-router') return scope
        // Keep the uncapped scope for guard policy (depth/guidance/budget at
        // turn start); only the core's reads during an executing tool receive
        // the remaining-time timeout clamp.
        setScope(scope)
        return wrapSettingsScope(scope)
      }
    },
  })
}

function wrapSettingsContext(childCtx, setScope) {
  if (!childCtx || typeof childCtx !== 'object' || !childCtx.settings) return childCtx
  const settings = wrapSettingsService(childCtx.settings, setScope)
  return new Proxy(childCtx, {
    get(target, property) {
      if (property === 'settings') return settings
      // Bind lifecycle methods to the exact injected child context. This keeps
      // Cordis ownership semantics intact even though Settings itself is viewed
      // through a narrow proxy.
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function installStructuredFlowHardening(ctx, config = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const states = new WeakMap()
  let settingsScope
  const setSettingsScope = (scope) => { settingsScope = scope }
  const activeConfig = () => {
    try {
      const value = settingsScope && typeof settingsScope.get === 'function' ? settingsScope.get() : config
      const base = value && typeof value === 'object' ? value : config
      const locale = hostLocalePreference(ctx)
      return locale === undefined ? base : { ...base, __visionRouterLocale: locale }
    } catch {
      return config
    }
  }

  let wrapped
  wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return wrapTools(target.tools, states, activeConfig)
      if (property === 'inject') {
        const inject = Reflect.get(target, property, target)
        if (typeof inject !== 'function') return inject
        return (dependencies, callback, ...rest) => {
          if (
            !Array.isArray(dependencies) ||
            !dependencies.includes('settings') ||
            typeof callback !== 'function'
          ) {
            return inject.call(target, dependencies, callback, ...rest)
          }
          return inject.call(
            target,
            dependencies,
            (childCtx) => callback(wrapSettingsContext(childCtx, setSettingsScope)),
            ...rest,
          )
        }
      }
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(target, event, async function guardedPreStep(payload, next) {
            const session = payload?.agent?.session
            const current = activeConfig()
            return runWithDepthConfig(current, async () => {
              const state = session ? ensureState(states, session, payload?.turn, current) : undefined
              const decision = await handler.call(this, payload, next)
              if (state && budgetExceeded(state)) state.budgetExhausted = true
              return state ? appendGuardMessage(decision, payload, state, activeConfig()) : decision
            })
          }, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return wrapped
}

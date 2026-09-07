import {
  currentVisionTurnBudget,
  runWithVisionTurnBudget,
} from './turn-budget-context.js'
import { runWithDepthConfig } from './depth-guidance.js'
import { runtimeLanguageFor } from './runtime-i18n.js'

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
const MAX_NON_PROGRESS_ATTEMPTS = 3
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

// Historical structural classifier retained for compatibility with callers
// that only need to distinguish a result envelope from an outright failure.
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

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function canonicalBox(value, width, height) {
  if (!isObject(value) || Array.isArray(value)) return false
  const { x1, y1, x2, y2 } = value
  if (![x1, y1, x2, y2].every(Number.isInteger)) return false
  if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1) return false
  if (positiveInteger(width) && x2 > width) return false
  if (positiveInteger(height) && y2 > height) return false
  return true
}

function structuredDescribeEvidence(value) {
  if (!isObject(value) || Array.isArray(value)) return false
  if (nonEmptyText(value.summary) || nonEmptyText(value.text)) return true
  if (Array.isArray(value.layout) && value.layout.some((row) => (
    isObject(row) && nonEmptyText(row.region) && nonEmptyText(row.content)
  ))) return true
  return Array.isArray(value.entities) && value.entities.some((entity) => (
    isObject(entity) && nonEmptyText(entity.type) && nonEmptyText(entity.label)
  ))
}

function groundEvidence(value) {
  if (!isObject(value) || Array.isArray(value)) return false
  const { width, height } = value
  return positiveInteger(width) && positiveInteger(height) && canonicalBox(value, width, height)
}

function detectEvidence(value) {
  if (!isObject(value) || Array.isArray(value)) return false
  const { width, height, elements } = value
  if (!positiveInteger(width) || !positiveInteger(height) || !Array.isArray(elements)) return false
  return elements.every((element, index) => (
    isObject(element) &&
    element.number === index + 1 &&
    nonEmptyText(element.label) &&
    canonicalBox(element.box, width, height)
  ))
}

function ocrEvidence(value) {
  if (!isObject(value) || Array.isArray(value)) return false
  if (value.engine !== 'tesseract' && value.engine !== 'vision') return false
  return typeof value.text === 'string'
}

function colorEvidence(value) {
  if (!Array.isArray(value)) return false
  return value.every((entry) => (
    isObject(entry) &&
    typeof entry.hex === 'string' && /^#[0-9a-f]{6}$/i.test(entry.hex) &&
    positiveInteger(entry.count) &&
    finiteNumber(entry.share) && entry.share > 0 && entry.share <= 1
  ))
}

function pixelDiffEvidence(value) {
  if (!isObject(value) || Array.isArray(value)) return false
  const { width, height, differingPixels, totalPixels, diffRatio, worstRegions } = value
  if (!positiveInteger(width) || !positiveInteger(height) || totalPixels !== width * height) return false
  if (!Number.isInteger(differingPixels) || differingPixels < 0 || differingPixels > totalPixels) return false
  if (!finiteNumber(diffRatio) || diffRatio < 0 || diffRatio > 1) return false
  if (Math.abs(diffRatio - differingPixels / totalPixels) > 0.000051) return false
  if (!Array.isArray(worstRegions)) return false
  return worstRegions.every((region) => (
    isObject(region) &&
    canonicalBox(region, width, height) &&
    Number.isInteger(region.differing) && region.differing > 0 &&
    positiveInteger(region.total) && region.differing <= region.total &&
    finiteNumber(region.ratio) && region.ratio > 0 && region.ratio <= 1
  ))
}

function longOcrEvidence(value) {
  if (!isObject(value) || Array.isArray(value)) return false
  if (typeof value.text !== 'string' || !positiveInteger(value.chunks)) return false
  if (!isObject(value.engines) || Array.isArray(value.engines)) return false
  if (![value.markdownPath, value.manifestPath, value.artifactsDir].every(nonEmptyText)) return false
  const engineCounts = Object.values(value.engines)
  if (engineCounts.length === 0 || !engineCounts.every((count) => Number.isInteger(count) && count >= 0)) return false
  if (engineCounts.reduce((sum, count) => sum + count, 0) !== value.chunks) return false
  if (nonEmptyText(value.text)) return true
  const completed = (value.engines.tesseract ?? 0) + (value.engines.vision ?? 0)
  return completed > 0
}

/**
 * Decide whether one registered evidence tool completed a real observation.
 *
 * This deliberately follows each tool's output contract instead of treating
 * arbitrary non-empty containers as evidence. Valid negative observations
 * (for example zero detections, empty OCR text, or a 0 pixel diff) still count;
 * transport failures, malformed envelopes, and describe's empty-content
 * sentinel do not.
 */
export function producedUsableToolEvidence(toolName, value, args = {}) {
  if (!STRUCTURED_EVIDENCE_TOOLS.has(toolName) || value === undefined || value === null) return false
  const parsed = parseJson(value)
  if (isObject(parsed) && !Array.isArray(parsed) && parsed.ok === false) return false

  switch (toolName) {
    case 'vision_describe': {
      if (typeof value !== 'string') return false
      const text = value.trim()
      if (text === '' || text === '(the vision model returned empty content)') return false
      if (args?.json === true) {
        if (text.startsWith('vision_describe: the model did not produce valid JSON.')) return false
        return structuredDescribeEvidence(parsed)
      }
      return true
    }
    case 'vision_ground':
      return groundEvidence(parsed)
    case 'vision_detect':
      return detectEvidence(parsed)
    case 'vision_ocr':
      return ocrEvidence(parsed)
    case 'vision_colors':
      return colorEvidence(parsed)
    case 'vision_pixel_diff':
      return pixelDiffEvidence(parsed)
    case 'vision_long_screenshot_ocr':
      return longOcrEvidence(parsed)
    default:
      return false
  }
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

function refreshDepthExhaustion(state, config) {
  const limit = structuredDepthLimit(depthOf(config), config?.visionDepthMaxCalls)
  state.depthExhausted = limit !== undefined && state.successfulEvidenceCalls >= limit
  return limit
}

function resetNonProgress(state) {
  state.consecutiveNonProgressAttempts = 0
  state.nonProgressExhausted = false
}

function recordNonProgress(state) {
  state.consecutiveNonProgressAttempts += 1
  state.nonProgressExhausted = state.consecutiveNonProgressAttempts >= MAX_NON_PROGRESS_ATTEMPTS
  return state.nonProgressExhausted
}

export function normalizeGuidanceOverrides(value) {
  if (!Array.isArray(value)) return []
  const byKind = new Map()
  for (const entry of value) {
    if (!isObject(entry)) continue
    const kind = typeof entry.kind === 'string' ? entry.kind.trim() : ''
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!GUIDANCE_KINDS.has(kind) || text === '') continue
    byKind.set(kind, text.slice(0, MAX_GUIDANCE_CHARS))
  }
  return [...byKind.entries()]
    .slice(-MAX_GUIDANCE_OVERRIDES)
    .map(([kind, text]) => ({ kind, text }))
}

function languageOf(config) {
  return runtimeLanguageFor(config?.__visionRouterLocale, 'zh')
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
    postBootstrapEvidenceCalls: 0,
    consecutiveNonProgressAttempts: 0,
    budgetExhausted: false,
    depthExhausted: false,
    nonProgressExhausted: false,
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

/**
 * Structured 1+x has exactly one hard completion condition after bootstrap:
 * at least one usable task-directed evidence observation. Mixed classifications
 * remain model-visible advisory evidence; they do not create branch quotas.
 */
function missingEvidence(state) {
  return state.postBootstrapEvidenceCalls >= 1 ? 0 : 1
}

function hasCoreFollowup(messages) {
  return Array.isArray(messages) && messages.some(
    (message) => message && typeof message.id === 'string' && message.id.includes('vision-router-structured-followup-'),
  )
}

function withoutEvidenceFollowups(messages) {
  return (messages ?? []).filter((message) => {
    const id = message && typeof message.id === 'string' ? message.id : ''
    return !(
      id.includes('vision-router-structured-followup-') ||
      // Strip historical Round-0 mixed hard guards if one is still present in
      // a persisted/compatibility message surface. Round 1 never emits them.
      id.includes('vision-router-structured-mixed-guard-') ||
      id.includes('vision-router-structured-evidence-guard-')
    )
  })
}

function hasMessageId(messages, id) {
  return Array.isArray(messages) && messages.some(
    (message) => message && typeof message.id === 'string' && message.id === id,
  )
}

function appendSyntheticGuardOnce(decision, baseMessages, state, message, stripEvidenceFollowups = false) {
  const messages = stripEvidenceFollowups ? withoutEvidenceFollowups(baseMessages) : baseMessages
  const id = message?.id
  if (typeof id === 'string' && (state.emittedGuardIds.has(id) || hasMessageId(messages, id))) {
    state.emittedGuardIds.add(id)
    return stripEvidenceFollowups ? { ...decision, messages } : decision
  }
  if (typeof id === 'string') state.emittedGuardIds.add(id)
  return {
    ...decision,
    messages: [...messages, message],
  }
}

function rearmEvidenceGuardAfterAttempt(state) {
  const evidenceId = `vision-router-structured-evidence-guard-${state.turn}`
  state.emittedGuardIds.delete(evidenceId)
}

function appendGuardMessage(decision, payload, state, config) {
  if (!decision || typeof decision !== 'object') return decision
  const baseMessages = Array.isArray(decision.messages)
    ? decision.messages
    : Array.isArray(payload?.messages)
      ? payload.messages
      : []
  const language = languageOf(config)

  if (state.budgetExhausted || state.depthExhausted || state.nonProgressExhausted) {
    const stopKind = state.budgetExhausted ? 'budget' : state.depthExhausted ? 'depth' : 'non-progress'
    const message = {
      role: 'user',
      id: `vision-router-structured-guard-stop-${state.turn}-${stopKind}`,
      content: [{
        type: 'text',
        text: language === 'en'
          ? state.budgetExhausted
            ? 'The visual turn time budget is exhausted. Do not call more vision tools; answer from the evidence already collected and state any remaining uncertainty.'
            : state.depthExhausted
              ? 'The configured deep-dive call cap has been reached. Do not call more vision tools; answer from the evidence already collected and state any remaining uncertainty.'
              : 'Repeated follow-up vision attempts did not produce usable evidence. Do not keep retrying vision tools; answer from the evidence already collected and state the remaining uncertainty.'
          : state.budgetExhausted
            ? '本轮视觉总时间预算已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。'
            : state.depthExhausted
              ? '已达到本轮设置的深挖次数上限。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。'
              : '连续多次后续视觉调用都没有产出可用证据。不要继续重复调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。',
      }],
      source: { kind: 'plugin', plugin: 'dsh-vision-router' },
    }
    return appendSyntheticGuardOnce(decision, baseMessages, state, message, true)
  }

  if (!state.bootstrapDone || missingEvidence(state) === 0) return decision

  // Core owns bootstrap ordering and its one-shot follow-up guidance. This
  // outer boundary owns the hard x>=1 completion rule. If Core's guidance is
  // already present, do not duplicate it; if Core's legacy presentation latch
  // stopped emitting it after an empty/failed attempt, re-assert the hard guard.
  if (hasCoreFollowup(baseMessages)) return decision
  const message = {
    role: 'user',
    id: `vision-router-structured-evidence-guard-${state.turn}`,
    content: [{
      type: 'text',
      text: language === 'en'
        ? 'The structured bootstrap is complete, but no usable task-directed visual evidence has been produced yet. Call at least one vision tool that can add or verify evidence, then answer after it succeeds.'
        : '结构化预识别已经完成，但目前还没有产出可用的任务定向视觉证据。请至少调用一个能新增或验证证据的视觉工具，成功后再作答。',
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
            // Structured 1+x is explicitly ordered: x starts only after the
            // bootstrap succeeds. Keep the all-turn successful-evidence count
            // intact for the user's explicit call cap; post-bootstrap progress
            // has its own counter so an early model call cannot satisfy x>=1.
            state.postBootstrapEvidenceCalls = 0
            resetNonProgress(state)
            state.budgetExhausted = false
            refreshDepthExhaustion(state, getConfig())
          }
          return result
        }

        if (budgetExceeded(state)) {
          state.budgetExhausted = true
          return failure('VISION_TURN_BUDGET_EXCEEDED', 'the structured-vision turn budget is exhausted; answer from the evidence already collected')
        }

        const active = getConfig()
        const limit = refreshDepthExhaustion(state, active)
        if (state.depthExhausted) {
          return failure('VISION_DEPTH_LIMIT', `the configured deep-dive call cap allows at most ${limit} successful evidence call(s) in this turn`)
        }
        if (state.bootstrapDone && missingEvidence(state) > 0 && state.nonProgressExhausted) {
          return failure(
            'VISION_NO_PROGRESS_LIMIT',
            `the structured follow-up stopped after ${MAX_NON_PROGRESS_ATTEMPTS} consecutive attempts without usable evidence`,
          )
        }

        const result = await runBudgetedTool(
          state,
          () => def.execute(args, exec),
          'the structured-vision turn budget is exhausted; answer from the evidence already collected',
          active,
        )
        const code = resultCode(result)
        if (code === 'VISION_TURN_BUDGET_EXCEEDED') state.budgetExhausted = true
        if (producedUsableToolEvidence(def.name, result, args)) {
          state.successfulEvidenceCalls += 1
          if (state.bootstrapDone) state.postBootstrapEvidenceCalls += 1
          refreshDepthExhaustion(state, active)
          resetNonProgress(state)
        } else if (code !== 'VISION_TURN_BUDGET_EXCEEDED' && state.bootstrapDone && missingEvidence(state) > 0) {
          recordNonProgress(state)
          if (!state.nonProgressExhausted) rearmEvidenceGuardAfterAttempt(state)
        }
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
              const latest = activeConfig()
              if (state) {
                if (budgetExceeded(state)) state.budgetExhausted = true
                refreshDepthExhaustion(state, latest)
              }
              return state ? appendGuardMessage(decision, payload, state, latest) : decision
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

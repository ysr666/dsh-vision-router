import { AsyncLocalStorage } from 'node:async_hooks'

function safeText(value, max = 240) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max)
    : undefined
}

function safeOrder(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeText(entry, 180)).filter(Boolean).slice(0, 64)
    : undefined
}

function safeDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const key of ['type', 'reason', 'before', 'promoted', 'intent', 'axis']) {
    const text = safeText(value[key], 180)
    if (text !== undefined) out[key] = text
  }
  for (const key of ['leftScore', 'rightScore', 'delta']) {
    const number = Number(value[key])
    if (Number.isFinite(number)) out[key] = number
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined
  const kind = safeText(event.kind, 80)
  if (!kind) return undefined
  const out = { kind }
  for (const key of [
    'intent',
    'axis',
    'routingMode',
    'routingPreference',
    'reason',
    'provider',
    'model',
    'backend',
    'transport',
    'source',
    'code',
    'bridge',
    'toolName',
    'outcome',
    'maxTokensField',
  ]) {
    const text = safeText(event[key], 240)
    if (text !== undefined) out[key] = text
  }
  for (const key of ['configuredOrder', 'plannedOrder', 'selectedOrder']) {
    const order = safeOrder(event[key])
    if (order !== undefined) out[key] = order
  }
  if (typeof event.changed === 'boolean') out.changed = event.changed
  const decision = safeDecision(event.decision)
  if (decision !== undefined) out.decision = decision
  return out
}

/**
 * Process-local, single-call evidence collector for the maintainer acceptance
 * service. It is inert outside an explicitly created capture and never changes
 * provider selection or transport policy. The optional pause occurs only at
 * the existing pre-execution live-authority recheck boundary.
 */
export function createV2ExecutionAcceptanceObserver() {
  const storage = new AsyncLocalStorage()

  const record = (event) => {
    const state = storage.getStore()
    if (!state) return
    const safe = sanitizeEvent(event)
    if (safe !== undefined && state.events.length < 256) state.events.push(safe)
  }

  return {
    createCapture({ pauseBeforeLiveCheck = false } = {}) {
      let enteredResolve
      let releaseResolve
      const entered = new Promise((resolve) => { enteredResolve = resolve })
      const released = new Promise((resolve) => { releaseResolve = resolve })
      const state = {
        events: [],
        pauseBeforeLiveCheck: pauseBeforeLiveCheck === true,
        enteredResolve,
        released,
      }
      return {
        run(execute) {
          return storage.run(state, execute)
        },
        entered,
        release() {
          releaseResolve?.()
          releaseResolve = undefined
        },
        events() {
          return structuredClone(state.events)
        },
      }
    },
    record,
    async beforeLiveCheck(event) {
      const state = storage.getStore()
      if (!state) return
      record(event)
      state.enteredResolve?.()
      state.enteredResolve = undefined
      if (state.pauseBeforeLiveCheck) await state.released
    },
  }
}

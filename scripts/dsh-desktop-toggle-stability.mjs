/**
 * Real Desktop E2E-only observer. This function is serialized by Playwright
 * into the renderer; keep it self-contained and free of production API calls.
 */
export function installDesktopVisionToggleAudit() {
  const selector = '[data-vision-router-mode-toggle="true"]'
  const history = []
  // Identifiers only; no provider error bodies or credentials in evidence.
  const domClicks = []
  const alertHistory = []
  let observedAlerts = new Map()
  let observedNode = document.querySelector(selector)
  let revision = 0
  let expectedState = null
  let continuousSince = null
  let seenRevision = 0

  const inspect = () => {
    const button = document.querySelector(selector)
    return {
      pressed: button?.getAttribute('aria-pressed') ?? null,
      busy: button?.getAttribute('aria-busy') ?? null,
      disabled: button?.disabled === true,
    }
  }
  const record = (phase) => {
    history.push({ phase, ms: Math.round(performance.now()), ...inspect() })
    if (history.length > 48) history.shift()
  }
  const alertEvent = (phase, errorCode) => {
    alertHistory.push({ phase, ms: Math.round(performance.now()), errorCode })
    if (alertHistory.length > 32) alertHistory.shift()
  }
  const captureAlerts = () => {
    if (typeof document.querySelectorAll !== 'function') return
    const next = new Map()
    for (const node of [...document.querySelectorAll('[role="alert"]')].slice(0, 32)) {
      const value = typeof node?.textContent === 'string' ? node.textContent : ''
      const errorCode = /\b([a-z][a-z0-9-]{0,47}\/[a-z][a-z0-9-]{0,47})\b/.exec(value)?.[1] ?? null
      next.set(node, errorCode)
      if (!observedAlerts.has(node) || observedAlerts.get(node) !== errorCode) {
        alertEvent('visible', errorCode)
      }
    }
    for (const [node, code] of observedAlerts) {
      if (!next.has(node)) alertEvent('removed', code)
    }
    observedAlerts = next
  }
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', (event) => {
      if (!event.target?.closest?.(selector)) return
      domClicks.push({ ms: Math.round(performance.now()), ...inspect() })
      if (domClicks.length > 8) domClicks.shift()
    }, true)
  }
  const containsToggle = (node) =>
    node === observedNode || node?.matches?.(selector) === true
      || node?.querySelector?.(selector) != null

  // Even if busy goes true then false between Playwright polls, attribute
  // mutation records restart the interval. Replacing the button also resets it.
  const observer = new MutationObserver((mutations) => {
    captureAlerts()
    const current = document.querySelector(selector)
    const changed = current !== observedNode || mutations.some((mutation) => {
      if (mutation.type === 'attributes') {
        return mutation.target === current || mutation.target === observedNode
      }
      if (mutation.type === 'childList') {
        return [...mutation.addedNodes, ...mutation.removedNodes].some(containsToggle)
      }
      return false
    })
    if (!changed) return
    observedNode = current
    revision++
    record('mutation')
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'aria-busy', 'disabled'],
  })

  window.__dvrDesktopToggleAudit = {
    history,
    domClicks,
    alertHistory,
    record,
    stableFor(expected, minimumMs) {
      const button = document.querySelector(selector)
      if (expectedState !== expected) {
        expectedState = expected
        continuousSince = null
        seenRevision = revision
      }
      if (button !== observedNode) {
        observedNode = button
        revision++
        record('replacement')
      }
      const actionable = button?.getAttribute('aria-pressed') === expected
        && button.getAttribute('aria-busy') !== 'true'
        && button.disabled === false
      if (!actionable) {
        continuousSince = null
        seenRevision = revision
        return false
      }
      if (seenRevision !== revision) {
        continuousSince = null
        seenRevision = revision
      }
      if (continuousSince === null) continuousSince = performance.now()
      return performance.now() - continuousSince >= minimumMs
    },
    stabilitySummary() {
      return {
        expected: expectedState,
        observedMutations: revision,
        continuousMs: continuousSince === null
          ? null : Math.round(performance.now() - continuousSince),
      }
    },
  }
  record('initial')
  captureAlerts()
}


/**
 * Browser E2E-only ModelDirectory state timeline for issue #684. Subscribe to
 * the same Host-owned store as the Vision button; never wrap selectModel or
 * issue an RPC. If private React fields change, report unavailable explicitly.
 * All recorded values are bounded identifiers/enums, never raw errors or data.
 */
export function installDesktopModelSelectionTrace() {
  const button = document.querySelector('[data-vision-router-mode-toggle="true"]')
  const unavailable = (reason) => {
    window.__dvrDesktopModelTrace = { available: false, reason, history: [] }
  }
  if (!button) return unavailable('toggle-missing')
  const key = Object.getOwnPropertyNames(button).find((name) => name.startsWith('__reactFiber$'))
  if (!key) return unavailable('react-fiber-unavailable')
  let fiber = button[key]
  let directory
  for (let depth = 0; fiber && depth < 64; depth++, fiber = fiber.return) {
    if (typeof fiber.memoizedProps?.directory?.store?.subscribe === 'function' &&
        typeof fiber.memoizedProps.directory.store.getSnapshot === 'function') {
      directory = fiber.memoizedProps.directory
      break
    }
  }
  if (!directory) return unavailable('directory-fiber-unavailable')

  const identifier = (value, max) =>
    typeof value === 'string' ? value.slice(0, max) : null
  const selection = (value) => !value || typeof value !== 'object' ? null : {
    provider: identifier(value.provider, 120),
    model: identifier(value.model, 120),
    reasoningEffort: identifier(value.reasoningEffort, 80),
  }
  const safeStatus = new Set(['idle', 'loading', 'ready', 'selecting', 'error'])
  const history = []
  const record = (phase) => {
    try {
      const current = directory.store.getSnapshot()
      const message = typeof current?.error === 'string' ? current.error : ''
      const errorCode = /^([a-z][a-z0-9-]{0,48}\/[a-z][a-z0-9-]{0,48}):/.exec(message)?.[1] ?? null
      history.push({
        phase,
        ms: Math.round(performance.now()),
        status: safeStatus.has(current?.status) ? current.status : 'unknown',
        current: selection(current?.current),
        pending: selection(current?.pending),
        hasError: message.length > 0,
        errorCode,
      })
      if (history.length > 64) history.shift()
    } catch (_) {
      history.push({ phase: 'snapshot-unavailable' })
      if (history.length > 64) history.shift()
    }
  }
  const unsubscribe = directory.store.subscribe(() => record('store-update'))
  window.__dvrDesktopModelTrace = {
    available: true,
    history,
    record,
    // Same identity check is read-only and detects a replaced directory.
    directoryChanged() {
      const node = document.querySelector('[data-vision-router-mode-toggle="true"]')
      const nextKey = node && Object.getOwnPropertyNames(node).find((name) => name.startsWith('__reactFiber$'))
      let next = nextKey && node[nextKey]
      for (let depth = 0; next && depth < 64; depth++, next = next.return) {
        if (next.memoizedProps?.directory === directory) return false
      }
      return true
    },
    unsubscribe,
  }
  record('initial')
}

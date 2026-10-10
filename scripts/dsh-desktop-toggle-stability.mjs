/**
 * Real Desktop E2E-only observer. This function is serialized by Playwright
 * into the renderer; keep it self-contained and free of production API calls.
 */
export function installDesktopVisionToggleAudit() {
  const selector = '[data-vision-router-mode-toggle="true"]'
  const history = []
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
  const containsToggle = (node) =>
    node === observedNode || node?.matches?.(selector) === true
      || node?.querySelector?.(selector) != null

  // Even if busy goes true then false between Playwright polls, attribute
  // mutation records restart the interval. Replacing the button also resets it.
  const observer = new MutationObserver((mutations) => {
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
}

function timeoutReason(root) {
  try {
    const DomException = root?.DOMException
    if (typeof DomException === 'function') {
      return new DomException('The operation was aborted due to timeout', 'TimeoutError')
    }
  } catch {
    // Fall through to an ordinary Error in runtimes without DOMException.
  }
  const error = new Error('The operation was aborted due to timeout')
  error.name = 'TimeoutError'
  return error
}

function defineStatic(target, name, value) {
  try {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      configurable: true,
    })
  } catch {
    try { target[name] = value } catch {}
  }
  return typeof target?.[name] === 'function'
}

function isAbortSignalLike(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function',
  )
}

/**
 * DSH normally runs on Node versions that already provide AbortSignal.any()
 * and AbortSignal.timeout(). A few supported host/browser bridges, however,
 * can surface an AbortSignal constructor without those static helpers. The
 * plugin has several cancellation boundaries that legitimately combine more
 * than one signal, so install small standards-shaped fallbacks once at the
 * public package boundary rather than sprinkling version checks everywhere.
 */
export function installAbortSignalCompat(root = globalThis) {
  const Signal = root?.AbortSignal
  const Controller = root?.AbortController
  const state = {
    any: typeof Signal?.any === 'function',
    timeout: typeof Signal?.timeout === 'function',
  }
  if (typeof Signal !== 'function' || typeof Controller !== 'function') return state

  if (!state.any) {
    const any = function any(signals) {
      const list = Array.from(signals ?? [])
      for (const signal of list) {
        if (!isAbortSignalLike(signal)) {
          throw new TypeError('AbortSignal.any: every input must be an AbortSignal')
        }
      }

      const controller = new Controller()
      for (const signal of list) {
        if (!signal.aborted) continue
        controller.abort(signal.reason)
        return controller.signal
      }

      const listeners = []
      const cleanup = () => {
        for (const [signal, listener] of listeners) {
          try { signal.removeEventListener?.('abort', listener) } catch {}
        }
        listeners.length = 0
      }

      for (const signal of list) {
        const listener = () => {
          cleanup()
          if (!controller.signal.aborted) controller.abort(signal.reason)
        }
        listeners.push([signal, listener])
        signal.addEventListener('abort', listener, { once: true })
      }
      return controller.signal
    }
    state.any = defineStatic(Signal, 'any', any)
  }

  if (!state.timeout) {
    const timeout = function timeout(delay) {
      const parsed = Number(delay)
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new RangeError('AbortSignal.timeout: delay must be a finite non-negative number')
      }
      const controller = new Controller()
      const schedule = typeof root?.setTimeout === 'function' ? root.setTimeout.bind(root) : setTimeout
      const timer = schedule(() => controller.abort(timeoutReason(root)), Math.floor(parsed))
      try { timer?.unref?.() } catch {}
      return controller.signal
    }
    state.timeout = defineStatic(Signal, 'timeout', timeout)
  }

  return state
}

export const abortSignalCompat = installAbortSignalCompat()

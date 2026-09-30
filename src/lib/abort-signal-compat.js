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

function signalList(signals) {
  if (signals === undefined || signals === null || typeof signals[Symbol.iterator] !== 'function') {
    throw new TypeError('AbortSignal.any: signals must be an iterable of AbortSignal values')
  }
  const list = Array.from(signals)
  for (const signal of list) {
    if (!isAbortSignalLike(signal)) {
      throw new TypeError('AbortSignal.any: every input must be an AbortSignal')
    }
  }
  return list
}

function timeoutDelay(delay) {
  if (typeof delay !== 'number') {
    throw new TypeError('AbortSignal.timeout: delay must be a number')
  }
  if (!Number.isInteger(delay) || delay < 0 || delay > 0xffff_ffff) {
    throw new RangeError('AbortSignal.timeout: delay must be an integer between 0 and 4294967295')
  }
  return delay
}

function removeAbortListeners(listeners) {
  for (const [signal, listener] of listeners) {
    try { signal.removeEventListener?.('abort', listener) } catch {}
  }
  listeners.length = 0
}

function strongAbortRelay(controller, source, cleanup) {
  return () => {
    cleanup()
    if (!controller.signal.aborted) controller.abort(source.reason)
  }
}

function weakAbortRelay(outputRef, controllerBySignal, source, cleanup, finalizer, token) {
  return () => {
    const output = outputRef.deref()
    cleanup()
    try { finalizer.unregister(token) } catch {}
    if (!output || output.aborted) return
    const controller = controllerBySignal.get(output)
    if (controller && !output.aborted) controller.abort(source.reason)
  }
}

function weakAnySupport(root) {
  const WeakRefCtor = root?.WeakRef
  const FinalizationRegistryCtor = root?.FinalizationRegistry
  const WeakMapCtor = root?.WeakMap
  if (
    typeof WeakRefCtor !== 'function' ||
    typeof FinalizationRegistryCtor !== 'function' ||
    typeof WeakMapCtor !== 'function'
  ) return undefined
  const controllerBySignal = new WeakMapCtor()
  const finalizer = new FinalizationRegistryCtor((cleanup) => {
    try { cleanup?.() } catch {}
  })
  return { WeakRefCtor, controllerBySignal, finalizer }
}

/**
 * DSH normally runs on Node versions that already provide AbortSignal.any()
 * and AbortSignal.timeout(). A few supported host/browser bridges, however,
 * can surface an AbortSignal constructor without those static helpers. The
 * plugin has several cancellation boundaries that legitimately combine more
 * than one signal, so install small standards-shaped fallbacks once at the
 * public package boundary rather than sprinkling version checks everywhere.
 *
 * This is intentionally a process-global, missing-only compatibility seam:
 * native functions are never replaced, and ESM module evaluation installs the
 * fallback once for all Vision Router contexts in the process. That avoids a
 * teardown race where unloading one profile could remove helpers still used by
 * another live profile. When WeakRef/FinalizationRegistry are available, the
 * `any()` fallback also removes source listeners after an unused composite is
 * collected instead of pinning long-lived Host lifecycle signals forever.
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
    const weakSupport = weakAnySupport(root)
    const any = function any(signals) {
      const list = signalList(signals)
      const controller = new Controller()
      const output = controller.signal
      for (const signal of list) {
        if (!signal.aborted) continue
        controller.abort(signal.reason)
        return output
      }

      const listeners = []
      const cleanup = () => removeAbortListeners(listeners)
      let outputRef
      let finalizerToken
      if (weakSupport) {
        weakSupport.controllerBySignal.set(output, controller)
        outputRef = new weakSupport.WeakRefCtor(output)
        finalizerToken = {}
      }

      try {
        for (const signal of list) {
          const listener = outputRef
            ? weakAbortRelay(
                outputRef,
                weakSupport.controllerBySignal,
                signal,
                cleanup,
                weakSupport.finalizer,
                finalizerToken,
              )
            : strongAbortRelay(controller, signal, cleanup)
          listeners.push([signal, listener])
          signal.addEventListener('abort', listener, { once: true })
        }
        if (outputRef) weakSupport.finalizer.register(output, cleanup, finalizerToken)
      } catch (error) {
        cleanup()
        if (finalizerToken) {
          try { weakSupport.finalizer.unregister(finalizerToken) } catch {}
        }
        throw error
      }
      return output
    }
    state.any = defineStatic(Signal, 'any', any)
  }

  if (!state.timeout) {
    const timeout = function timeout(delay) {
      const parsed = timeoutDelay(delay)
      const controller = new Controller()
      const schedule = typeof root?.setTimeout === 'function' ? root.setTimeout.bind(root) : setTimeout
      const timer = schedule(() => controller.abort(timeoutReason(root)), parsed)
      try { timer?.unref?.() } catch {}
      return controller.signal
    }
    state.timeout = defineStatic(Signal, 'timeout', timeout)
  }

  return state
}

export const abortSignalCompat = installAbortSignalCompat()

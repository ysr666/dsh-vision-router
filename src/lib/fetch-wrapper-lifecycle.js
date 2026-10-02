// Lifecycle metadata only: no native fetch snapshot, dispatcher, or egress
// policy is retained here. Weak keys let abandoned wrapper chains be collected.
const installations = new WeakMap()

function livePreviousDescriptor(descriptor) {
  let previous = descriptor
  while (previous && Object.hasOwn(previous, 'value')) {
    const installation = installations.get(previous.value)
    if (!installation?.disposed) break
    previous = installation.previous
  }
  return previous
}

/** Preserve a live accessor-owned pipeline, including middleware recomposition. */
export function captureFetchDelegate(target = globalThis) {
  const descriptor = Object.getOwnPropertyDescriptor(target, 'fetch')
  const current = target.fetch
  if (typeof current !== 'function' || typeof descriptor?.get !== 'function') return current
  return (input, init) => Reflect.apply(Reflect.apply(descriptor.get, target, []), target, [input, init])
}

/**
 * Publish an already constructed fetch wrapper without calling a foreign
 * accessor setter. Assignment is unsafe: a pipeline getter may return a
 * function whose setter adopts our wrapper as its own delegate (#519).
 *
 * The caller captures the CURRENT Host chain at installation, never at module
 * load, and disables its own behavior before restoring. Later Host replacements
 * remain authoritative. Restore the exact previous descriptor only while our
 * data property still owns the surface; never feed a wrapper back to a setter.
 * Non-configurable accessors cannot be composed this way and fail before any
 * mutation rather than silently bypassing a Host policy or explicit proxy.
 */
export function installFetchWrapper(wrapped, target = globalThis) {
  if (typeof wrapped !== 'function') throw new TypeError('fetch wrapper must be a function')
  const previous = Object.getOwnPropertyDescriptor(target, 'fetch')
  if (previous && Object.hasOwn(previous, 'value') && previous.value === wrapped) return () => {}
  const installed = previous && Object.hasOwn(previous, 'value')
    ? { ...previous, value: wrapped }
    : { configurable: true, enumerable: previous?.enumerable ?? true, writable: true, value: wrapped }
  Object.defineProperty(target, 'fetch', installed)
  const installation = { previous, disposed: false }
  installations.set(wrapped, installation)
  return () => {
    if (installation.disposed) return
    installation.disposed = true
    const current = Object.getOwnPropertyDescriptor(target, 'fetch')
    if (!current || !Object.hasOwn(current, 'value') || current.value !== wrapped ||
        current.configurable !== installed.configurable ||
        current.enumerable !== installed.enumerable || current.writable !== installed.writable) return
    const restore = livePreviousDescriptor(previous)
    if (restore) Object.defineProperty(target, 'fetch', restore)
    else delete target.fetch
  }
}

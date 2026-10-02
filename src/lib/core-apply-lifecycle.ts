export interface CoreApplyLifecycleHooks {
  onSuccess?: () => void
  onFailure?: (error: unknown) => void
}

/**
 * Preserve Core's synchronous apply contract while giving Promise-like Core
 * implementations one explicit settlement boundary for post-registration work.
 * This helper owns no runtime state; callers provide success/failure lifecycle
 * effects explicitly.
 */
export function runCoreApplyLifecycle<T>(
  invoke: () => PromiseLike<T>,
  hooks?: CoreApplyLifecycleHooks,
): Promise<T>
export function runCoreApplyLifecycle<T>(
  invoke: () => T,
  hooks?: CoreApplyLifecycleHooks,
): T
export function runCoreApplyLifecycle<T>(
  invoke: () => T | PromiseLike<T>,
  { onSuccess, onFailure }: CoreApplyLifecycleHooks = {},
): T | Promise<T> {
  if (typeof invoke !== 'function') throw new TypeError('Core apply lifecycle requires an invoke function')
  const succeed = typeof onSuccess === 'function' ? onSuccess : () => {}
  const fail = (error: unknown): never => {
    try {
      onFailure?.(error)
    } catch {
      // Cleanup/diagnostic failure must not replace the Core apply error.
    }
    throw error
  }

  let result: T | PromiseLike<T>
  try {
    result = invoke()
  } catch (error) {
    return fail(error)
  }

  if (
    result !== null
    && (typeof result === 'object' || typeof result === 'function')
    && typeof (result as PromiseLike<T>).then === 'function'
  ) {
    return Promise.resolve(result as PromiseLike<T>).then(
      (value) => {
        try {
          succeed()
          return value
        } catch (error) {
          return fail(error)
        }
      },
      fail,
    )
  }

  try {
    succeed()
    return result as T
  } catch (error) {
    return fail(error)
  }
}

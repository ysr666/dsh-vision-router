const catalogStateByAdapter = new WeakMap()

export const OFFICIAL_DEEPSEEK_CATALOG_FRESH_MS = 30_000
export const OFFICIAL_DEEPSEEK_CATALOG_STALE_IF_ERROR_MS = 10 * 60_000
export const OFFICIAL_DEEPSEEK_CATALOG_FAILURE_BACKOFF_MS = 5_000

function catalogUnavailable(cause) {
  const error = new Error('vision-router: the official DeepSeek catalog is temporarily unavailable')
  error.code = 'OFFICIAL_CATALOG_UNAVAILABLE'
  if (cause !== undefined) error.cause = cause
  return error
}

function normalizedModels(listed) {
  if (!Array.isArray(listed)) {
    throw new TypeError('official DeepSeek adapter listModels() did not return an array')
  }
  return Object.freeze(
    listed
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => Object.freeze({ ...entry })),
  )
}

/**
 * Process-local authority for the live official DeepSeek catalog.
 *
 * The special DeepSeek vision wrapper must not infer product identity from an
 * adapter's permissive resolveModel() behavior. Membership therefore remains
 * fail-closed to a catalog actually observed from the official adapter. A
 * short fresh cache coalesces duplicate Core/replay reads; a bounded
 * stale-if-error window keeps transient endpoint failures from taking down a
 * long-lived session. Cold start and expired-cache failures stay fail-closed.
 *
 * State is keyed by adapter identity so Host adapter replacement cannot inherit
 * another registration's catalog. Nothing is persisted across process restart:
 * a previous process is not durable authority for a newly started Host.
 */
export async function getOfficialDeepSeekCatalog(adapter, {
  provider = 'deepseek-official',
  now = Date.now,
  freshMs = OFFICIAL_DEEPSEEK_CATALOG_FRESH_MS,
  staleIfErrorMs = OFFICIAL_DEEPSEEK_CATALOG_STALE_IF_ERROR_MS,
  failureBackoffMs = OFFICIAL_DEEPSEEK_CATALOG_FAILURE_BACKOFF_MS,
} = {}) {
  if (!adapter || typeof adapter.listModels !== 'function') {
    throw catalogUnavailable()
  }

  let state = catalogStateByAdapter.get(adapter)
  if (state === undefined) {
    state = {
      models: undefined,
      fetchedAt: 0,
      inFlight: undefined,
      failure: undefined,
      failedAt: 0,
    }
    catalogStateByAdapter.set(adapter, state)
  }

  const currentTime = Number(now())
  const age =
    state.models === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, currentTime - state.fetchedAt)
  if (state.models !== undefined && age <= Math.max(0, Number(freshMs) || 0)) {
    return state.models
  }
  if (state.inFlight !== undefined) return state.inFlight

  const failureAge =
    state.failure === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, currentTime - state.failedAt)
  if (failureAge <= Math.max(0, Number(failureBackoffMs) || 0)) {
    if (
      state.models !== undefined
      && age <= Math.max(0, Number(staleIfErrorMs) || 0)
    ) {
      return state.models
    }
    throw state.failure
  }

  const refresh = (async () => {
    try {
      const listed = await adapter.listModels(provider)
      const models = normalizedModels(listed)
      state.models = models
      state.fetchedAt = Number(now())
      state.failure = undefined
      state.failedAt = 0
      return models
    } catch (cause) {
      const failureTime = Number(now())
      const error = catalogUnavailable(cause)
      state.failure = error
      state.failedAt = failureTime
      const staleAge =
        state.models === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, failureTime - state.fetchedAt)
      if (
        state.models !== undefined
        && staleAge <= Math.max(0, Number(staleIfErrorMs) || 0)
      ) {
        return state.models
      }
      throw error
    }
  })()

  state.inFlight = refresh
  try {
    return await refresh
  } finally {
    if (state.inFlight === refresh) state.inFlight = undefined
  }
}

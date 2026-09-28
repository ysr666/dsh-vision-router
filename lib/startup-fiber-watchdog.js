const STATE_NAMES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
const MAX_ROWS = 64
const MAX_INJECT = 64
const MAX_LABEL = 160

function stateName(value) {
  return Number.isInteger(value) && STATE_NAMES[value] ? STATE_NAMES[value] : `UNKNOWN(${String(value)})`
}

function boundedLabel(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value.length <= MAX_LABEL ? value : `${value.slice(0, MAX_LABEL)}…`
}

function boundedOwnKeys(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return { pairs: [], truncated: false }
  }
  const pairs = []
  let truncated = false
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (pairs.length >= MAX_INJECT) {
        truncated = true
        break
      }
      pairs.push({ raw: key, display: boundedLabel(key, '<unnamed>') })
    }
  } catch {
    return { pairs: [], truncated: true }
  }
  pairs.sort((left, right) => left.raw.localeCompare(right.raw))
  return { pairs, truncated }
}

function missingServices(fiber, injectPairs) {
  // Cordis keeps resolved dependency implementations in _store even while a
  // fiber is PENDING. Reading that plain map is observational; calling ctx.get()
  // here could invoke a third-party service accessor and perturb the hang.
  const store = fiber?._store ?? fiber?.store
  if (store === null || typeof store !== 'object') return null
  try {
    return injectPairs
      .filter(({ raw }) => !Object.prototype.hasOwnProperty.call(store, raw))
      .map(({ display }) => display)
  } catch {
    return null
  }
}

function fiberRow(runtime, fiber) {
  const inject = boundedOwnKeys(fiber?.inject)
  return {
    plugin: boundedLabel(runtime?.name, '<anonymous>'),
    uid: Number.isSafeInteger(fiber?.uid) ? fiber.uid : null,
    state: stateName(fiber?.state),
    inject: inject.pairs.map(({ display }) => display),
    missing: missingServices(fiber, inject.pairs),
    injectTruncated: inject.truncated,
    inertia: fiber?.inertia !== undefined,
  }
}

export function collectStartupFiberSnapshot(ctx) {
  const fibers = []
  let fibersTruncated = false
  try {
    outer: for (const runtime of ctx?.registry?.values?.() ?? []) {
      for (const fiber of runtime?.fibers ?? []) {
        if (fiber?.state === 2) continue
        if (fibers.length >= MAX_ROWS) {
          fibersTruncated = true
          break outer
        }
        fibers.push(fiberRow(runtime, fiber))
      }
    }
  } catch {
    fibersTruncated = true
  }

  const entries = []
  let entriesTruncated = false
  try {
    for (const entry of ctx?.get?.('loader')?.entries?.() ?? []) {
      const fiber = entry?.fiber
      if (entry?.disabled === true || fiber?.state === 2) continue
      if (entries.length >= MAX_ROWS) {
        entriesTruncated = true
        break
      }
      entries.push({
        id: boundedLabel(entry?.options?.id, null),
        module: boundedLabel(entry?.options?.name, null),
        fiberUid: Number.isSafeInteger(fiber?.uid) ? fiber.uid : null,
        state: fiber === undefined ? 'UNMOUNTED' : stateName(fiber.state),
      })
    }
  } catch {
    entriesTruncated = true
  }

  return { fibers, entries, truncated: { fibers: fibersTruncated, entries: entriesTruncated } }
}

export function installStartupFiberWatchdog(ctx, options = {}) {
  const ready = ctx?.get?.('appReady')
  if (!ready || typeof ready.onReady !== 'function') return () => {}

  const delayMs = Number.isFinite(options.delayMs) && options.delayMs > 0 ? options.delayMs : 30_000
  let settled = false
  let timer
  const cancelReady = ready.onReady(() => {
    settled = true
    if (timer !== undefined) clearTimeout(timer)
  })
  timer = setTimeout(() => {
    if (settled) return
    const snapshot = collectStartupFiberSnapshot(ctx)
    ctx?.logger?.warn?.(
      'vision-router: DSH startup still not ready after %dms; unresolved lifecycle snapshot: %s',
      delayMs,
      JSON.stringify(snapshot),
    )
  }, delayMs)
  timer.unref?.()

  const dispose = () => {
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    try { cancelReady?.() } catch {}
  }
  try {
    ctx?.effect?.(() => dispose, 'vision-router: startup fiber watchdog')
  } catch {
    dispose()
  }
  return dispose
}

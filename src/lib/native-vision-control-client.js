// Browser-safe transport helpers. All functions serialized into the shipping
// prelude are self-contained or refer only to the other helpers in this file.
export const NATIVE_VISION_REMOTE = 'dvrNativeVision'

export function createNativeVisionControlContribution(schemas) {
  const NATIVE_VISION_REMOTE = 'dvrNativeVision'
  const PACKAGE = 'dsh-vision-router-native-control'
  const SESSION_TYPE = '@deepseek-ai/dsh-session/types#SessionId'
  const codec = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, create: () => schema })
  return {
    package: PACKAGE,
    descriptors: [{
      id: PACKAGE + '#' + NATIVE_VISION_REMOTE + '/observe',
      service: NATIVE_VISION_REMOTE,
      namespace: NATIVE_VISION_REMOTE,
      method: 'observe',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
        codec: codec(SESSION_TYPE, schemas.id) }],
      cancellation: { parameter: 'signal' },
      result: codec(PACKAGE + '#NativeVisionControlView', schemas.view),
    }, {
      id: PACKAGE + '#' + NATIVE_VISION_REMOTE + '/set',
      service: NATIVE_VISION_REMOTE,
      namespace: NATIVE_VISION_REMOTE,
      method: 'set',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
          codec: codec(SESSION_TYPE, schemas.id) },
        { name: 'request', wire: 'request', source: 'json',
          codec: codec(PACKAGE + '#NativeVisionMutationRequest', schemas.request) },
      ],
      cancellation: { parameter: 'signal' },
      result: codec(PACKAGE + '#NativeVisionMutationReceipt', schemas.receipt),
    }],
  }
}

export function createNativeVisionClientSchemas() {
  const bad = () => { throw new TypeError('Invalid DVR native Vision wire value') }
  const exact = (v, keys) => v !== null && typeof v === 'object' &&
    !Array.isArray(v) && Object.keys(v).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(v, key))
  const string = v => typeof v === 'string' && v.length > 0
  const selection = v => exact(v, ['provider', 'model']) && string(v.provider) && string(v.model)
  const bool = v => typeof v === 'boolean'
  const check = predicate => ({ parse(value) { if (!predicate(value)) bad(); return value } })
  return {
    id: check(string),
    request: check(v => exact(v, ['enabled', 'selection']) && bool(v.enabled) && selection(v.selection)),
    receipt: check(v => exact(v, ['kind', 'text']) && ['success', 'error'].includes(v.kind) &&
      typeof v.text === 'string' && v.text.length <= 1024),
    view: check(v => {
      if (!v || typeof v !== 'object') return false
      if (v.kind === 'native') return exact(v, ['kind', 'selection', 'enabled', 'requestedEnabled', 'canEnable', 'durable']) &&
        selection(v.selection) && bool(v.enabled) && bool(v.requestedEnabled) && bool(v.canEnable) && (bool(v.durable) || v.durable === null)
      if (v.kind === 'legacy') return exact(v, ['kind', 'reason', 'selection']) &&
        selection(v.selection) && ['dvr-wrapper', 'text-only'].includes(v.reason)
      return v.kind === 'unavailable' && exact(v, ['kind', 'reason']) &&
        ['inactive-session', 'host-control-unsupported', 'no-selection', 'no-registration', 'metadata-unavailable',
          'stale-selection', 'policy-store-unavailable', 'policy-read-failed', 'observer-unavailable'].includes(v.reason)
    }),
  }
}

export function nativeVisionSameRoute(a, b) {
  return !!a && !!b && a.provider === b.provider && a.model === b.model
}

// One mount per client plugin fiber, not per conversation. The namespace is
// consumed through its own injection scope. An old client without $mount
// keeps its previously supported picker; a transport error is not OFF.
export function createNativeVisionClientBridge(scope) {
  let snapshot = { kind: 'legacy' }
  const listeners = new Set()
  const publish = state => {
    snapshot = state
    for (const notify of [...listeners]) notify()
  }
  const bridge = {
    subscribe(notify) { listeners.add(notify); return () => listeners.delete(notify) },
    getSnapshot() { return snapshot },
  }
  let remote, typert
  try { remote = scope.get?.('remote'); typert = scope.get?.('typert') } catch {}
  if (typeof remote?.$mount !== 'function' || !typert ||
      typeof scope.inject !== 'function' || typeof scope.effect !== 'function') return bridge
  publish({ kind: 'waiting' })
  scope.inject(['remote', 'typert'], owner => {
    owner.effect(async () => {
      let closed = false
      let dispose
      try {
        dispose = await owner.remote.$mount(createNativeVisionControlContribution(createNativeVisionClientSchemas()))
        owner.inject(['remote.dvrNativeVision'], caller => {
          if (closed) return
          const api = caller.remote.dvrNativeVision
          const ready = () => publish({ kind: 'ready', api })
          ready()
          caller.on?.('connection/reset', ready)
          caller.effect(() => () => {
            if (!closed) publish({ kind: 'waiting' })
          }, 'vision-router: native namespace retirement')
        })
      } catch {
        if (!closed) publish({ kind: 'failed' })
      }
      return async () => {
        closed = true
        publish({ kind: 'failed' })
        await dispose?.()
      }
    }, 'vision-router: native Remote client mount')
  })
  return bridge
}

// Each active composer Session owns one observation. Never reuse a previous
// Session or connection's value; retirement is synchronous even if the
// transport refuses cancellation. No polling or optimistic toggle state.
export function startNativeVisionClientObservation(api, sessionId, publish, { retryDelays = [100, 350, 1000, 2000, 3000] } = {}) {
  const schemas = createNativeVisionClientSchemas()
  const ctl = new AbortController()
  let active = true
  let stream
  let seen = false
  let latest
  let writing = false
  let snapshot
  let generation = 0
  let resumeRetry
  const legacyWaiters = new Set()
  // Compare only a previously authorized legacy decision, not arbitrary
  // unavailable/native observations or object identity across Remote frames.
  const legacyKey = state => {
    if (!state || state.writing) return null
    if (state.kind === 'legacy') return JSON.stringify(['legacy', state.reason])
    if (state.kind !== 'value') return null
    const view = state.view
    if (view.kind === 'legacy') return JSON.stringify([view.kind, view.reason, view.selection.provider, view.selection.model])
    if (view.kind === 'unavailable' && view.reason === 'host-control-unsupported') return view.reason
    return null
  }
  const isLegacyCurrent = previous => {
    const key = legacyKey(previous)
    return active && key !== null && key === legacyKey(snapshot)
  }
  const notifyLegacyWaiters = () => { for (const inspect of [...legacyWaiters]) inspect() }
  const stop = () => {
    if (!active) return
    active = false
    ctl.abort()
    resumeRetry?.()
    try { stream?.dispose() } catch {}
    notifyLegacyWaiters()
  }
  const update = state => {
    if (active) {
      snapshot = state
      publish(state)
      notifyLegacyWaiters()
    }
  }
  update({ kind: 'waiting' })
  const pause = ms => new Promise(resolve => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      if (resumeRetry === finish) resumeRetry = undefined
      resolve()
    }
    resumeRetry = finish
  })
  void (async () => {
    for (let attempt = 0; active; attempt++) {
      const epoch = ++generation
      let reason = 'stream-ended'
      let retryable = true
      try {
        stream = api.observe(schemas.id.parse(sessionId), ctl.signal)
        for await (const value of stream) {
          if (!active || epoch !== generation) break
          try { latest = schemas.view.parse(value) }
          catch { reason = 'invalid-frame'; retryable = false; break }
          seen = true
          update({ kind: 'value', view: latest, writing })
        }
      } catch (error) {
        reason = typeof error?.code === 'string' && /^[a-z0-9/-]{1,80}$/.test(error.code)
          ? error.code : 'transport-failed'
        if (!active) return
        // Only a positively absent endpoint BEFORE any valid frame is old-
        // Host compatibility. A retired or denied namespace never is.
        // A never-seen strict endpoint could mean an old Host, OR a modern
        // Host whose Agent lookup / plugin fiber has not mounted yet. Do not
        // permanently label it legacy on the first racing lookup. Probe only
        // a bounded number of READs (no SRC call, no model mutation), then
        // report legacy compatibility if the endpoint truly stays absent.
        const tentativeLegacy = !seen && reason === 'gateway/invocation-unavailable'
        if (tentativeLegacy && attempt >= Math.min(3, retryDelays.length)) {
          latest = undefined
          update({ kind: 'legacy', reason })
          return
        }
        // The Host can briefly retire its Agent lookup while keeping the
        // DVR strict endpoint registered. The Gateway then correctly rejects
        // observation with a missing lookup/service; retry the READ only for
        // a finite startup/HMR budget. Even a temporarily withdrawn strict
        // definition may reappear after a plugin generation swap; retry the
        // SAME strict read endpoint, never SRC fallback. Writes are never
        // replayed. Provider mismatch and principal denial stay hard errors.
        retryable = tentativeLegacy || ['transport-failed', 'gateway/internal', 'session/not-found',
          'gateway/lookup-unavailable', 'gateway/service-unavailable',
          'gateway/definition-unavailable'].includes(reason)
      } finally {
        try { stream?.dispose() } catch {}
        stream = undefined
      }
      if (!active) return
      latest = undefined
      ++generation
      // A model selection can retire its live Agent or interrupt the carrier.
      // Retry ONLY the read subscription, with a bounded budget. No write is
      // replayed, no stale frame stays actionable, denial/malformed data stops.
      if (!retryable || attempt >= retryDelays.length) {
        update({ kind: 'failed', reason })
        return
      }
      update({ kind: 'waiting', reason })
      await pause(retryDelays[attempt])
    }
  })()
  return {
    stop,
    isCurrent(state) { return active && snapshot === state },
    isLegacyCurrent,
    // Preserve one explicit legacy click during a same-observer read gap.
    // Never convert a denied/unknown/native decision into permission. Only
    // wait through a bounded transport read retry or adapter withdrawal,
    // and require the original exact legacy decision to be observed again.
    waitForLegacy(previous, timeoutMs = 5000) {
      if (!active || legacyKey(previous) === null) return Promise.resolve(false)
      if (isLegacyCurrent(previous)) return Promise.resolve(true)
      return new Promise(resolve => {
        let done = false
        let timer
        const finish = result => {
          if (done) return
          done = true
          legacyWaiters.delete(inspect)
          clearTimeout(timer)
          resolve(result)
        }
        const inspect = () => {
          if (!active) return finish(false)
          if (isLegacyCurrent(previous)) return finish(true)
          const temporarilyUnavailable = snapshot?.kind === 'waiting' ||
            (snapshot?.kind === 'value' && snapshot.view.kind === 'unavailable' && snapshot.view.reason === 'no-registration')
          if (!temporarilyUnavailable) finish(false)
        }
        legacyWaiters.add(inspect)
        timer = setTimeout(() => finish(false), timeoutMs)
        inspect()
      })
    },
    async set(view, expected) {
      if (!active || writing || latest !== view || view?.kind !== 'native' ||
          !nativeVisionSameRoute(view.selection, expected) || !view.canEnable) return false
      const epoch = generation
      writing = true
      update({ kind: 'value', view: latest, writing })
      let accepted = false
      try {
        const request = schemas.request.parse({ enabled: !view.enabled, selection: view.selection })
        const result = await api.set(sessionId, request, ctl.signal)
        accepted = active && epoch === generation && result?.ok === true && schemas.receipt.parse(result.value).kind === 'success'
      } catch {}
      writing = false
      if (active && latest) update({ kind: 'value', view: latest, writing })
      return accepted
    },
  }
}

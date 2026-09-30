async function closeDispatcher(dispatcher) {
  if (!dispatcher || (typeof dispatcher !== 'object' && typeof dispatcher !== 'function')) return
  try {
    if (typeof dispatcher.close === 'function') {
      await dispatcher.close()
      return
    }
    if (typeof dispatcher.destroy === 'function') await dispatcher.destroy()
  } catch {
    // Cleanup must not turn a completed request into an unload failure.
  }
}

export function createProxyDispatcherPool({ importUndici = () => import('undici'), label = 'vision proxy transport' } = {}) {
  let cachedEntry
  let disposed = false
  let disposePromise
  const liveEntries = new Set()

  const maybeCloseEntry = (entry) => {
    if (!entry.obsolete || entry.refs !== 0 || !entry.dispatcher || entry.closing) return
    entry.closing = Promise.resolve().then(() => closeDispatcher(entry.dispatcher)).finally(() => {
      liveEntries.delete(entry)
      entry.resolveDone()
    })
  }
  const retireEntry = (entry) => {
    if (!entry || entry.obsolete) return
    entry.obsolete = true
    maybeCloseEntry(entry)
  }
  const createEntry = (proxyUrl) => {
    let resolveDone
    const entry = {
      proxyUrl, refs: 0, obsolete: false, dispatcher: undefined, getGlobalDispatcher: undefined, closing: undefined,
      done: new Promise((resolve) => { resolveDone = resolve }), resolveDone: () => resolveDone(), promise: undefined,
    }
    liveEntries.add(entry)
    entry.promise = Promise.resolve().then(() => importUndici()).then(({ ProxyAgent, getGlobalDispatcher }) => {
      if (typeof ProxyAgent !== 'function') throw new Error(`${label}: undici ProxyAgent is unavailable`)
      if (typeof getGlobalDispatcher !== 'function') throw new Error(`${label}: undici getGlobalDispatcher is unavailable`)
      entry.getGlobalDispatcher = getGlobalDispatcher
      entry.dispatcher = new ProxyAgent(proxyUrl)
      maybeCloseEntry(entry)
      return entry.dispatcher
    }).catch((error) => {
      if (cachedEntry === entry) cachedEntry = undefined
      liveEntries.delete(entry)
      entry.resolveDone()
      throw error
    })
    return entry
  }
  const reconcile = (proxyUrl) => {
    if (cachedEntry && cachedEntry.proxyUrl !== proxyUrl) {
      const previous = cachedEntry
      cachedEntry = undefined
      retireEntry(previous)
    }
  }
  const acquire = async (proxyUrl) => {
    if (disposed) throw new Error(`${label}: dispatcher pool is disposed`)
    let entry = cachedEntry
    if (!entry || entry.proxyUrl !== proxyUrl || entry.obsolete) {
      if (entry) retireEntry(entry)
      entry = createEntry(proxyUrl)
      cachedEntry = entry
    }
    entry.refs += 1
    try {
      const dispatcher = await entry.promise
      let released = false
      return { dispatcher, getGlobalDispatcher: entry.getGlobalDispatcher, release() {
        if (released) return
        released = true
        entry.refs = Math.max(0, entry.refs - 1)
        maybeCloseEntry(entry)
      } }
    } catch (error) {
      entry.refs = Math.max(0, entry.refs - 1)
      maybeCloseEntry(entry)
      throw error
    }
  }
  const dispose = () => {
    if (disposePromise) return disposePromise
    disposed = true
    const current = cachedEntry
    cachedEntry = undefined
    retireEntry(current)
    for (const entry of liveEntries) retireEntry(entry)
    disposePromise = Promise.all([...liveEntries].map((entry) => entry.done)).then(() => undefined)
    return disposePromise
  }
  return Object.freeze({ acquire, reconcile, dispose })
}

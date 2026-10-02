import {
  proxyDispatcherLike,
  type DispatcherLike,
  type FetchDispatcher,
} from './proxy-routing.js'

type OwnedDispatcher = FetchDispatcher

interface DispatcherEntry {
  readonly proxyUrl: string
  refs: number
  obsolete: boolean
  dispatcher: OwnedDispatcher | undefined
  getGlobalDispatcher: (() => FetchDispatcher) | undefined
  closing: Promise<void> | undefined
  readonly done: Promise<void>
  readonly resolveDone: () => void
  promise: Promise<OwnedDispatcher> | undefined
}

export interface ProxyDispatcherLease {
  readonly dispatcher: FetchDispatcher
  getGlobalDispatcher(): FetchDispatcher
  release(): void
}

export interface ProxyDispatcherPool {
  acquire(proxyUrl: string): Promise<ProxyDispatcherLease>
  reconcile(proxyUrl: string | undefined): void
  dispose(): Promise<void>
}

export interface ProxyDispatcherPoolOptions {
  readonly importUndici?: () => unknown | PromiseLike<unknown>
  readonly label?: string
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined
}

async function closeDispatcher(dispatcher: unknown): Promise<void> {
  const value = objectRecord(dispatcher)
  if (value === undefined) return
  try {
    if (typeof value.close === 'function') {
      await value.close.call(dispatcher)
      return
    }
    if (typeof value.destroy === 'function') await value.destroy.call(dispatcher)
  } catch {
    // Cleanup must not turn a completed request into an unload failure.
  }
}

export function createProxyDispatcherPool({
  importUndici = () => import('undici'),
  label = 'vision proxy transport',
}: ProxyDispatcherPoolOptions = {}): Readonly<ProxyDispatcherPool> {
  let cachedEntry: DispatcherEntry | undefined
  let disposed = false
  let disposePromise: Promise<void> | undefined
  const liveEntries = new Set<DispatcherEntry>()

  const maybeCloseEntry = (entry: DispatcherEntry): void => {
    if (!entry.obsolete || entry.refs !== 0 || !entry.dispatcher || entry.closing) return
    entry.closing = Promise.resolve()
      .then(() => closeDispatcher(entry.dispatcher))
      .finally(() => {
        liveEntries.delete(entry)
        entry.resolveDone()
      })
  }

  const retireEntry = (entry: DispatcherEntry | undefined): void => {
    if (!entry || entry.obsolete) return
    entry.obsolete = true
    maybeCloseEntry(entry)
  }

  const createEntry = (proxyUrl: string): DispatcherEntry => {
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const entry: DispatcherEntry = {
      proxyUrl,
      refs: 0,
      obsolete: false,
      dispatcher: undefined,
      getGlobalDispatcher: undefined,
      closing: undefined,
      done,
      resolveDone,
      promise: undefined,
    }
    liveEntries.add(entry)
    entry.promise = Promise.resolve()
      .then(importUndici)
      .then((moduleValue) => {
        const module = objectRecord(moduleValue)
        const ProxyAgent = module?.ProxyAgent
        const getGlobalDispatcher = module?.getGlobalDispatcher
        if (typeof ProxyAgent !== 'function') {
          throw new Error(`${label}: undici ProxyAgent is unavailable`)
        }
        if (typeof getGlobalDispatcher !== 'function') {
          throw new Error(`${label}: undici getGlobalDispatcher is unavailable`)
        }

        const Constructor = ProxyAgent as new (url: string) => unknown
        const dispatcher = new Constructor(proxyUrl)
        if (!proxyDispatcherLike(dispatcher)) {
          throw new Error(`${label}: undici ProxyAgent has no dispatcher contract`)
        }

        entry.getGlobalDispatcher = () => {
          const globalDispatcher = getGlobalDispatcher.call(moduleValue)
          if (!proxyDispatcherLike(globalDispatcher)) {
            throw new Error(`${label}: undici global dispatcher has no dispatcher contract`)
          }
          return globalDispatcher as FetchDispatcher
        }
        entry.dispatcher = dispatcher as OwnedDispatcher
        maybeCloseEntry(entry)
        return entry.dispatcher
      })
      .catch((error: unknown) => {
        if (cachedEntry === entry) cachedEntry = undefined
        liveEntries.delete(entry)
        entry.resolveDone()
        throw error
      })
    return entry
  }

  const reconcile = (proxyUrl: string | undefined): void => {
    if (cachedEntry && cachedEntry.proxyUrl !== proxyUrl) {
      const previous = cachedEntry
      cachedEntry = undefined
      retireEntry(previous)
    }
  }

  const acquire = async (proxyUrl: string): Promise<ProxyDispatcherLease> => {
    if (disposed) throw new Error(`${label}: dispatcher pool is disposed`)
    let entry = cachedEntry
    if (!entry || entry.proxyUrl !== proxyUrl || entry.obsolete) {
      if (entry) retireEntry(entry)
      entry = createEntry(proxyUrl)
      cachedEntry = entry
    }
    entry.refs += 1
    try {
      const promise = entry.promise
      if (!promise) throw new Error(`${label}: dispatcher entry failed to initialize`)
      const dispatcher = await promise
      const getGlobalDispatcher = entry.getGlobalDispatcher
      if (!getGlobalDispatcher) {
        throw new Error(`${label}: global dispatcher accessor is unavailable`)
      }
      let released = false
      return {
        dispatcher,
        getGlobalDispatcher,
        release(): void {
          if (released) return
          released = true
          entry.refs = Math.max(0, entry.refs - 1)
          maybeCloseEntry(entry)
        },
      }
    } catch (error) {
      entry.refs = Math.max(0, entry.refs - 1)
      maybeCloseEntry(entry)
      throw error
    }
  }

  const dispose = (): Promise<void> => {
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

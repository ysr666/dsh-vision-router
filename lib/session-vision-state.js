const DEFAULTS = Object.freeze({
  maxSessions: 64,
  idleTtlMs: 60 * 60 * 1000,
  descriptionMaxEntries: 64,
  descriptionMaxChars: 256 * 1024,
  attachmentMaxEntries: 256,
})

// Exact Session-object bridge for entry-layer compatibility policy. The value
// remains a view over the owning store rather than a copied Map, so eviction,
// forgetSession(), and bounded-LRU semantics stay authoritative in one place.
// Weak keys prevent a finished Session from being retained by this seam.
const knownSessionMemoryViews = new WeakMap()

function isSessionKey(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

export function knownSessionVisionMemory(session) {
  return isSessionKey(session) ? knownSessionMemoryViews.get(session) : undefined
}

class WeightedLruMap {
  constructor({ maxEntries, maxWeight = Infinity, weightOf = () => 1 } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 1))
    this.maxWeight = Number.isFinite(maxWeight) && maxWeight >= 0 ? maxWeight : Infinity
    this.weightOf = typeof weightOf === 'function' ? weightOf : () => 1
    this.entries = new Map()
    this.weight = 0
  }

  _weight(value, key) {
    const weight = Number(this.weightOf(value, key))
    return Number.isFinite(weight) && weight > 0 ? weight : 0
  }

  get(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  peek(key) {
    return this.entries.get(key)?.value
  }

  has(key) {
    return this.entries.has(key)
  }

  set(key, value) {
    const old = this.entries.get(key)
    if (old !== undefined) {
      this.weight -= old.weight
      this.entries.delete(key)
    }
    const weight = this._weight(value, key)
    this.entries.set(key, { value, weight })
    this.weight += weight
    this._trim()
    return this
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    this.weight -= entry.weight
    return this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
    this.weight = 0
  }

  _trim() {
    while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  get size() {
    return this.entries.size
  }

  keys() {
    return this.entries.keys()
  }

  values() {
    return [...this.entries.values()].map((entry) => entry.value).values()
  }

  entriesIterator() {
    return [...this.entries.entries()].map(([key, entry]) => [key, entry.value]).values()
  }
}

function normalizeId(value) {
  if (value === undefined || value === null) return undefined
  const id = String(value)
  return id === '' ? undefined : id
}

function textWeight(value) {
  return typeof value === 'string' ? value.length : String(value ?? '').length
}

function createState(key, stable, options, now) {
  return {
    key,
    stable,
    lastAccessAt: now,
    descriptions: new WeightedLruMap({
      maxEntries: options.descriptionMaxEntries,
      maxWeight: options.descriptionMaxChars,
      weightOf: textWeight,
    }),
    attachments: new WeightedLruMap({
      maxEntries: options.attachmentMaxEntries,
    }),
    scannedEventSeq: 0,
  }
}

class SessionMemoryView extends Map {
  constructor(store, session) {
    super()
    this.store = store
    this.session = session
  }

  get(key) {
    return this.store.getDescription(this.session, key)
  }

  has(key) {
    return this.store.hasDescription(this.session, key)
  }

  set(key, value) {
    this.store.setDescription(this.session, key, value)
    return this
  }

  delete(key) {
    return this.store.deleteDescription(this.session, key)
  }

  clear() {
    this.store.clearDescriptions(this.session)
  }

  get size() {
    return this.store.stateStats(this.session)?.descriptions ?? 0
  }
}

class DescriptionFacade extends Map {
  constructor(store) {
    super()
    this.store = store
  }

  get(key) {
    const state = this.store.uniqueStableOwner(key)
    return state?.descriptions.get(String(key))
  }

  has(key) {
    const state = this.store.uniqueStableOwner(key)
    return state?.descriptions.has(String(key)) === true
  }

  set(key, value) {
    const state = this.store.uniqueStableOwner(key)
    if (state !== undefined) {
      state.descriptions.set(String(key), value)
      this.store.touchState(state)
    }
    return this
  }

  delete(key) {
    const state = this.store.uniqueStableOwner(key)
    if (state === undefined) return false
    this.store.touchState(state)
    return state.descriptions.delete(String(key))
  }

  clear() {
    for (const state of this.store.stableStates()) state.descriptions.clear()
  }

  get size() {
    let size = 0
    for (const state of this.store.stableStates()) size += state.descriptions.size
    return size
  }
}

export function createSessionVisionStateStore(config = {}) {
  const options = {
    maxSessions: Math.max(1, Math.floor(Number(config.maxSessions) || DEFAULTS.maxSessions)),
    idleTtlMs:
      Number.isFinite(Number(config.idleTtlMs)) && Number(config.idleTtlMs) >= 0
        ? Number(config.idleTtlMs)
        : DEFAULTS.idleTtlMs,
    descriptionMaxEntries: Math.max(
      1,
      Math.floor(Number(config.descriptionMaxEntries) || DEFAULTS.descriptionMaxEntries),
    ),
    descriptionMaxChars: Math.max(
      1,
      Math.floor(Number(config.descriptionMaxChars) || DEFAULTS.descriptionMaxChars),
    ),
    attachmentMaxEntries: Math.max(
      1,
      Math.floor(Number(config.attachmentMaxEntries) || DEFAULTS.attachmentMaxEntries),
    ),
  }
  const now = typeof config.now === 'function' ? config.now : Date.now
  const statesById = new Map()
  const weakStates = new WeakMap()

  const prune = () => {
    const cutoff = options.idleTtlMs <= 0 ? -Infinity : now() - options.idleTtlMs
    for (const [key, state] of statesById) {
      if (state.lastAccessAt < cutoff) statesById.delete(key)
    }
    while (statesById.size > options.maxSessions) {
      const oldest = statesById.keys().next().value
      if (oldest === undefined) break
      statesById.delete(oldest)
    }
  }

  const touchState = (state) => {
    state.lastAccessAt = now()
    if (!state.stable) return
    if (statesById.get(state.key) === state) {
      statesById.delete(state.key)
      statesById.set(state.key, state)
    }
    prune()
  }

  const stateFor = (session, create = true) => {
    if (!isSessionKey(session)) return undefined
    prune()
    const id = normalizeId(session.id)
    if (id !== undefined) {
      let state = statesById.get(id)
      if (state === undefined && create) {
        state = createState(id, true, options, now())
        statesById.set(id, state)
        prune()
      }
      if (state !== undefined) touchState(state)
      return state
    }
    let state = weakStates.get(session)
    if (state === undefined && create) {
      state = createState(undefined, false, options, now())
      weakStates.set(session, state)
    }
    if (state !== undefined) touchState(state)
    return state
  }

  const stableStates = () => {
    prune()
    return [...statesById.values()]
  }

  const uniqueStableOwner = (attachmentId) => {
    const id = normalizeId(attachmentId)
    if (id === undefined) return undefined
    let owner
    for (const state of stableStates()) {
      if (!state.attachments.has(id) && !state.descriptions.has(id)) continue
      if (owner !== undefined && owner !== state) return undefined
      owner = state
    }
    if (owner !== undefined) touchState(owner)
    return owner
  }

  const store = {
    options,
    stateFor,
    stableStates,
    uniqueStableOwner,
    touchState,

    memoryForSession(session) {
      const memory = new SessionMemoryView(store, session)
      if (isSessionKey(session)) knownSessionMemoryViews.set(session, memory)
      return memory
    },

    getDescription(session, attachmentId) {
      const id = normalizeId(attachmentId)
      if (id === undefined) return undefined
      return stateFor(session, false)?.descriptions.get(id)
    },

    hasDescription(session, attachmentId) {
      const id = normalizeId(attachmentId)
      if (id === undefined) return false
      return stateFor(session, false)?.descriptions.has(id) === true
    },

    setDescription(session, attachmentId, description) {
      const id = normalizeId(attachmentId)
      if (id === undefined) return false
      const state = stateFor(session, true)
      if (state === undefined) return false
      state.descriptions.set(id, description)
      touchState(state)
      return state.descriptions.has(id)
    },

    deleteDescription(session, attachmentId) {
      const id = normalizeId(attachmentId)
      if (id === undefined) return false
      const state = stateFor(session, false)
      if (state === undefined) return false
      touchState(state)
      return state.descriptions.delete(id)
    },

    clearDescriptions(session) {
      const state = stateFor(session, false)
      if (state !== undefined) state.descriptions.clear()
    },

    recordAttachments(session, refs) {
      if (!Array.isArray(refs) || refs.length === 0) return
      const state = stateFor(session, true)
      if (state === undefined) return
      for (const ref of refs) {
        const id = normalizeId(ref && (ref.attachmentId ?? ref.id))
        if (id !== undefined) state.attachments.set(id, ref)
      }
      touchState(state)
    },

    lookupAttachment(session, attachmentId) {
      const id = normalizeId(attachmentId)
      if (id === undefined) return undefined
      return stateFor(session, false)?.attachments.get(id)
    },

    getScannedEventSeq(session) {
      return stateFor(session, false)?.scannedEventSeq ?? 0
    },

    setScannedEventSeq(session, seq) {
      const state = stateFor(session, true)
      if (state === undefined) return
      const next = Number.isFinite(Number(seq)) && Number(seq) >= 0 ? Math.floor(Number(seq)) : 0
      state.scannedEventSeq = next
      touchState(state)
    },

    forgetSession(sessionOrId) {
      const id =
        typeof sessionOrId === 'string' || typeof sessionOrId === 'number'
          ? normalizeId(sessionOrId)
          : normalizeId(sessionOrId && sessionOrId.id)
      if (id !== undefined) return statesById.delete(id)
      if (isSessionKey(sessionOrId)) {
        knownSessionMemoryViews.delete(sessionOrId)
        return weakStates.delete(sessionOrId)
      }
      return false
    },

    stateStats(session) {
      const state = stateFor(session, false)
      if (state === undefined) return undefined
      return {
        stable: state.stable,
        descriptions: state.descriptions.size,
        descriptionChars: state.descriptions.weight,
        attachments: state.attachments.size,
        scannedEventSeq: state.scannedEventSeq,
      }
    },

    stats() {
      prune()
      let descriptions = 0
      let descriptionChars = 0
      let attachments = 0
      for (const state of statesById.values()) {
        descriptions += state.descriptions.size
        descriptionChars += state.descriptions.weight
        attachments += state.attachments.size
      }
      return {
        stableSessions: statesById.size,
        descriptions,
        descriptionChars,
        attachments,
      }
    },
  }

  store.descriptionFacade = new DescriptionFacade(store)
  return store
}

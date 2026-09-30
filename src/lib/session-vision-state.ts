import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

const DEFAULTS = Object.freeze({
  maxSessions: 64,
  idleTtlMs: 60 * 60 * 1000,
  descriptionMaxEntries: 64,
  descriptionMaxChars: 256 * 1024,
  attachmentMaxEntries: 256,
})

export interface LegacySessionVisionAttachmentRef {
  readonly attachmentId?: unknown
  readonly id?: unknown
  readonly [key: string]: unknown
}

export type SessionVisionAttachmentRef =
  | ImageAttachmentRef
  | LegacySessionVisionAttachmentRef

export interface SessionVisionStateStats {
  readonly stable: boolean
  readonly descriptions: number
  readonly descriptionChars: number
  readonly attachments: number
}

export interface SessionVisionStoreStats {
  readonly stableSessions: number
  readonly descriptions: number
  readonly descriptionChars: number
  readonly attachments: number
}

interface SessionVisionState {
  readonly key: string | undefined
  readonly stable: boolean
  lastAccessAt: number
  readonly descriptions: WeightedLruMap<string, unknown>
  readonly attachments: WeightedLruMap<string, SessionVisionAttachmentRef>
}

export interface SessionVisionStateStore {
  readonly options: {
    readonly maxSessions: number
    readonly idleTtlMs: number
    readonly descriptionMaxEntries: number
    readonly descriptionMaxChars: number
    readonly attachmentMaxEntries: number
  }
  stateFor(session: unknown, create?: boolean): SessionVisionState | undefined
  stableStates(): SessionVisionState[]
  uniqueStableOwner(attachmentId: unknown): SessionVisionState | undefined
  touchState(state: SessionVisionState): void
  memoryForSession(session: unknown): Map<string, unknown>
  getDescription(session: unknown, attachmentId: unknown): unknown
  hasDescription(session: unknown, attachmentId: unknown): boolean
  setDescription(session: unknown, attachmentId: unknown, description: unknown): boolean
  deleteDescription(session: unknown, attachmentId: unknown): boolean
  clearDescriptions(session: unknown): void
  recordAttachments(session: unknown, refs: unknown): void
  lookupAttachment(session: unknown, attachmentId: unknown): SessionVisionAttachmentRef | undefined
  forgetSession(sessionOrId: unknown): boolean
  stateStats(session: unknown): SessionVisionStateStats | undefined
  stats(): SessionVisionStoreStats
  descriptionFacade: Map<string, unknown>
}

const knownSessionMemoryViews = new WeakMap<object, SessionMemoryView>()

function objectRecord(value: unknown): Record<PropertyKey, unknown> | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<PropertyKey, unknown>
    : undefined
}

function isSessionKey(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function attachmentRef(value: unknown): SessionVisionAttachmentRef | undefined {
  return objectRecord(value) ? value as SessionVisionAttachmentRef : undefined
}

function attachmentIdOf(value: unknown): unknown {
  const record = objectRecord(value)
  return record?.attachmentId ?? record?.id
}

export function knownSessionVisionMemory(session: unknown): Map<string, unknown> | undefined {
  return isSessionKey(session) ? knownSessionMemoryViews.get(session) : undefined
}

class WeightedLruMap<K, V> {
  readonly maxEntries: number
  readonly maxWeight: number
  readonly weightOf: (value: V, key: K) => unknown
  readonly entries = new Map<K, { value: V; weight: number }>()
  weight = 0

  constructor({
    maxEntries,
    maxWeight = Infinity,
    weightOf = () => 1,
  }: {
    readonly maxEntries?: unknown
    readonly maxWeight?: unknown
    readonly weightOf?: (value: V, key: K) => unknown
  } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 1))
    this.maxWeight = Number.isFinite(Number(maxWeight)) && Number(maxWeight) >= 0
      ? Number(maxWeight)
      : Infinity
    this.weightOf = typeof weightOf === 'function' ? weightOf : () => 1
  }

  _weight(value: V, key: K): number {
    const weight = Number(this.weightOf(value, key))
    return Number.isFinite(weight) && weight > 0 ? weight : 0
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  peek(key: K): V | undefined {
    return this.entries.get(key)?.value
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  set(key: K, value: V): this {
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

  delete(key: K): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    this.weight -= entry.weight
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.weight = 0
  }

  _trim(): void {
    while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }

  keys(): IterableIterator<K> {
    return this.entries.keys()
  }

  values(): IterableIterator<V> {
    return [...this.entries.values()].map((entry) => entry.value).values()
  }

  entriesIterator(): IterableIterator<[K, V]> {
    return [...this.entries.entries()].map(([key, entry]) => [key, entry.value] as [K, V]).values()
  }
}

function normalizeId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const id = String(value)
  return id === '' ? undefined : id
}

function textWeight(value: unknown): number {
  return typeof value === 'string' ? value.length : String(value ?? '').length
}

function createState(
  key: string | undefined,
  stable: boolean,
  options: SessionVisionStateStore['options'],
  now: number,
): SessionVisionState {
  return {
    key,
    stable,
    lastAccessAt: now,
    descriptions: new WeightedLruMap<string, unknown>({
      maxEntries: options.descriptionMaxEntries,
      maxWeight: options.descriptionMaxChars,
      weightOf: textWeight,
    }),
    attachments: new WeightedLruMap<string, SessionVisionAttachmentRef>({
      maxEntries: options.attachmentMaxEntries,
    }),
  }
}

class SessionMemoryView extends Map<string, unknown> {
  readonly store: SessionVisionStateStore
  readonly session: unknown

  constructor(store: SessionVisionStateStore, session: unknown) {
    super()
    this.store = store
    this.session = session
  }

  override get(key: string): unknown {
    return this.store.getDescription(this.session, key)
  }

  override has(key: string): boolean {
    return this.store.hasDescription(this.session, key)
  }

  override set(key: string, value: unknown): this {
    this.store.setDescription(this.session, key, value)
    return this
  }

  override delete(key: string): boolean {
    return this.store.deleteDescription(this.session, key)
  }

  override clear(): void {
    this.store.clearDescriptions(this.session)
  }

  override get size(): number {
    return this.store.stateStats(this.session)?.descriptions ?? 0
  }
}

class DescriptionFacade extends Map<string, unknown> {
  readonly store: SessionVisionStateStore

  constructor(store: SessionVisionStateStore) {
    super()
    this.store = store
  }

  override get(key: string): unknown {
    const state = this.store.uniqueStableOwner(key)
    return state?.descriptions.get(String(key))
  }

  override has(key: string): boolean {
    const state = this.store.uniqueStableOwner(key)
    return state?.descriptions.has(String(key)) === true
  }

  override set(key: string, value: unknown): this {
    const state = this.store.uniqueStableOwner(key)
    if (state !== undefined) {
      state.descriptions.set(String(key), value)
      this.store.touchState(state)
    }
    return this
  }

  override delete(key: string): boolean {
    const state = this.store.uniqueStableOwner(key)
    if (state === undefined) return false
    this.store.touchState(state)
    return state.descriptions.delete(String(key))
  }

  override clear(): void {
    for (const state of this.store.stableStates()) state.descriptions.clear()
  }

  override get size(): number {
    let size = 0
    for (const state of this.store.stableStates()) size += state.descriptions.size
    return size
  }
}

export function createSessionVisionStateStore(config: unknown = {}): SessionVisionStateStore {
  const source = objectRecord(config) ?? {}
  const options: SessionVisionStateStore['options'] = {
    maxSessions: Math.max(1, Math.floor(Number(source.maxSessions) || DEFAULTS.maxSessions)),
    idleTtlMs:
      Number.isFinite(Number(source.idleTtlMs)) && Number(source.idleTtlMs) >= 0
        ? Number(source.idleTtlMs)
        : DEFAULTS.idleTtlMs,
    descriptionMaxEntries: Math.max(
      1,
      Math.floor(Number(source.descriptionMaxEntries) || DEFAULTS.descriptionMaxEntries),
    ),
    descriptionMaxChars: Math.max(
      1,
      Math.floor(Number(source.descriptionMaxChars) || DEFAULTS.descriptionMaxChars),
    ),
    attachmentMaxEntries: Math.max(
      1,
      Math.floor(Number(source.attachmentMaxEntries) || DEFAULTS.attachmentMaxEntries),
    ),
  }
  const now = typeof source.now === 'function'
    ? source.now as () => number
    : Date.now
  const statesById = new Map<string, SessionVisionState>()
  const weakStates = new WeakMap<object, SessionVisionState>()

  const prune = (): void => {
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

  const touchState = (state: SessionVisionState): void => {
    state.lastAccessAt = now()
    if (!state.stable || state.key === undefined) return
    if (statesById.get(state.key) === state) {
      statesById.delete(state.key)
      statesById.set(state.key, state)
    }
    prune()
  }

  const stateFor = (session: unknown, create = true): SessionVisionState | undefined => {
    if (!isSessionKey(session)) return undefined
    prune()
    const id = normalizeId(objectRecord(session)?.id)
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

  const stableStates = (): SessionVisionState[] => {
    prune()
    return [...statesById.values()]
  }

  const uniqueStableOwner = (attachmentId: unknown): SessionVisionState | undefined => {
    const id = normalizeId(attachmentId)
    if (id === undefined) return undefined
    let owner: SessionVisionState | undefined
    for (const state of stableStates()) {
      if (!state.attachments.has(id) && !state.descriptions.has(id)) continue
      if (owner !== undefined && owner !== state) return undefined
      owner = state
    }
    if (owner !== undefined) touchState(owner)
    return owner
  }

  const store: SessionVisionStateStore = {
    options,
    stateFor,
    stableStates,
    uniqueStableOwner,
    touchState,

    memoryForSession(session: unknown): Map<string, unknown> {
      const memory = new SessionMemoryView(store, session)
      if (isSessionKey(session)) knownSessionMemoryViews.set(session, memory)
      return memory
    },

    getDescription(session: unknown, attachmentId: unknown): unknown {
      const id = normalizeId(attachmentId)
      if (id === undefined) return undefined
      return stateFor(session, false)?.descriptions.get(id)
    },

    hasDescription(session: unknown, attachmentId: unknown): boolean {
      const id = normalizeId(attachmentId)
      if (id === undefined) return false
      return stateFor(session, false)?.descriptions.has(id) === true
    },

    setDescription(session: unknown, attachmentId: unknown, description: unknown): boolean {
      const id = normalizeId(attachmentId)
      if (id === undefined) return false
      const state = stateFor(session, true)
      if (state === undefined) return false
      state.descriptions.set(id, description)
      touchState(state)
      return state.descriptions.has(id)
    },

    deleteDescription(session: unknown, attachmentId: unknown): boolean {
      const id = normalizeId(attachmentId)
      if (id === undefined) return false
      const state = stateFor(session, false)
      if (state === undefined) return false
      touchState(state)
      return state.descriptions.delete(id)
    },

    clearDescriptions(session: unknown): void {
      const state = stateFor(session, false)
      if (state !== undefined) state.descriptions.clear()
    },

    recordAttachments(session: unknown, refs: unknown): void {
      if (!Array.isArray(refs) || refs.length === 0) return
      const state = stateFor(session, true)
      if (state === undefined) return
      for (const value of refs) {
        const ref = attachmentRef(value)
        if (ref === undefined) continue
        const id = normalizeId(attachmentIdOf(ref))
        if (id !== undefined) state.attachments.set(id, ref)
      }
      touchState(state)
    },

    lookupAttachment(session: unknown, attachmentId: unknown): SessionVisionAttachmentRef | undefined {
      const id = normalizeId(attachmentId)
      if (id === undefined) return undefined
      return stateFor(session, false)?.attachments.get(id)
    },

    forgetSession(sessionOrId: unknown): boolean {
      const id =
        typeof sessionOrId === 'string' || typeof sessionOrId === 'number'
          ? normalizeId(sessionOrId)
          : normalizeId(objectRecord(sessionOrId)?.id)
      if (id !== undefined) return statesById.delete(id)
      if (isSessionKey(sessionOrId)) {
        knownSessionMemoryViews.delete(sessionOrId)
        return weakStates.delete(sessionOrId)
      }
      return false
    },

    stateStats(session: unknown): SessionVisionStateStats | undefined {
      const state = stateFor(session, false)
      if (state === undefined) return undefined
      return {
        stable: state.stable,
        descriptions: state.descriptions.size,
        descriptionChars: state.descriptions.weight,
        attachments: state.attachments.size,
      }
    },

    stats(): SessionVisionStoreStats {
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

    descriptionFacade: undefined as unknown as Map<string, unknown>,
  }

  store.descriptionFacade = new DescriptionFacade(store)
  return store
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { rawSessionIdentity } from './session-affinity.js'

interface VisionSessionAffinityState {
  readonly affinityId: string
  active: boolean
}

type UnknownRecord = Record<PropertyKey, unknown>

const affinityRuntime = new AsyncLocalStorage<VisionSessionAffinityState>()

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as UnknownRecord
    : undefined
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof propertyBag(value)?.then === 'function'
}

export function currentVisionSessionAffinityId(): string | undefined {
  const state = affinityRuntime.getStore()
  return state?.active === true ? state.affinityId : undefined
}

export function runWithVisionSessionAffinity<Result>(
  affinityId: unknown,
  callback: () => PromiseLike<Result>,
): Promise<Result>
export function runWithVisionSessionAffinity<Result>(
  affinityId: unknown,
  callback: () => Result,
): Result
export function runWithVisionSessionAffinity(
  affinityId: unknown,
  callback: () => unknown,
): unknown {
  const raw = rawSessionIdentity(affinityId)
  if (raw === undefined) return callback()

  const state: VisionSessionAffinityState = {
    affinityId: raw,
    active: true,
  }

  let result: unknown
  try {
    result = affinityRuntime.run(state, callback)
  } catch (error) {
    state.active = false
    throw error
  }

  if (isPromiseLike(result)) {
    return Promise.resolve(result).finally(() => {
      state.active = false
    })
  }

  state.active = false
  return result
}

export function streamWithVisionSessionAffinity<Item>(
  affinityId: unknown,
  streamFactory: () => AsyncIterable<Item> | PromiseLike<AsyncIterable<Item>>,
): AsyncIterable<Item> | PromiseLike<AsyncIterable<Item>> {
  const raw = rawSessionIdentity(affinityId)
  if (raw === undefined) return streamFactory()

  return {
    [Symbol.asyncIterator](): AsyncIterator<Item> {
      const state: VisionSessionAffinityState = {
        affinityId: raw,
        active: true,
      }
      let iteratorPromise: Promise<AsyncIterator<Item>> | undefined

      const retire = (): void => {
        state.active = false
      }

      const ensure = (): Promise<AsyncIterator<Item>> => {
        if (iteratorPromise === undefined) {
          iteratorPromise = affinityRuntime.run(state, async () => {
            const stream = await streamFactory()
            if (
              stream === null
              || (typeof stream !== 'object' && typeof stream !== 'function')
              || typeof stream[Symbol.asyncIterator] !== 'function'
            ) {
              throw new TypeError('scoped vision stream is not async iterable')
            }
            return stream[Symbol.asyncIterator]()
          })
        }
        return iteratorPromise
      }

      return {
        next(value?: unknown): Promise<IteratorResult<Item>> {
          return affinityRuntime.run(state, async () => {
            try {
              const result = await (await ensure()).next(value)
              if (result?.done === true) retire()
              return result
            } catch (error) {
              retire()
              throw error
            }
          })
        },

        return(value?: unknown): Promise<IteratorResult<Item>> {
          if (iteratorPromise === undefined) {
            retire()
            return Promise.resolve({ done: true, value } as IteratorReturnResult<unknown>)
          }
          return affinityRuntime.run(state, async () => {
            try {
              const active = await ensure()
              return typeof active.return === 'function'
                ? await active.return(value)
                : { done: true, value } as IteratorReturnResult<unknown>
            } finally {
              retire()
            }
          })
        },

        throw(error?: unknown): Promise<IteratorResult<Item>> {
          if (iteratorPromise === undefined) {
            retire()
            return Promise.reject(error)
          }
          return affinityRuntime.run(state, async () => {
            try {
              const active = await ensure()
              if (typeof active.throw === 'function') return await active.throw(error)
              throw error
            } finally {
              retire()
            }
          })
        },
      }
    },
  }
}

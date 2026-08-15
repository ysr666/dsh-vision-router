import { AsyncLocalStorage } from 'node:async_hooks'
import * as core from '../index.js'
import { fetchWithOpenAICompatibility } from './http-compat.js'

export * from '../index.js'
export * from './http-compat.js'

const httpCompatibilityContext = new AsyncLocalStorage()

export function visionDescribeHttpPrompt(args = {}) {
  const question = String(args.question ?? '')
  return args.json === true
    ? question + '\n\n' + core.describeStructuredInstruction(question)
    : question
}

function compatibilityStoreForTool(definition, args) {
  return {
    active: true,
    prompt: definition?.name === 'vision_describe' ? visionDescribeHttpPrompt(args) : '',
  }
}

function wrapToolDefinition(definition) {
  if (
    !definition ||
    typeof definition.name !== 'string' ||
    !definition.name.startsWith('vision_') ||
    typeof definition.execute !== 'function'
  ) {
    return definition
  }
  const execute = definition.execute
  return {
    ...definition,
    execute(args, exec) {
      return httpCompatibilityContext.run(
        compatibilityStoreForTool(definition, args),
        () => execute.call(definition, args, exec),
      )
    },
  }
}

async function* iterateInCompatibilityContext(iterator, store) {
  let completed = false
  try {
    for (;;) {
      const step = await httpCompatibilityContext.run(store, () => iterator.next())
      if (step.done) {
        completed = true
        return step.value
      }
      yield step.value
    }
  } finally {
    if (!completed && iterator && typeof iterator.return === 'function') {
      try {
        await httpCompatibilityContext.run(store, () => iterator.return())
      } catch {
        // Cancellation cleanup is best-effort; preserve the caller's original
        // generator completion/error semantics.
      }
    }
  }
}

function wrapVisionHttpAdapter(adapter) {
  if (!adapter || typeof adapter.stream !== 'function') return adapter
  return {
    ...adapter,
    async *stream(options) {
      const store = { active: true, prompt: '' }
      const iterator = httpCompatibilityContext.run(store, () =>
        adapter.stream.call(adapter, options),
      )
      yield* iterateInCompatibilityContext(iterator, store)
    },
  }
}

function proxyTools(tools) {
  if (!tools || typeof tools !== 'object') return tools
  return new Proxy(tools, {
    get(target, property) {
      if (property === 'register') {
        return (definition) => target.register(wrapToolDefinition(definition))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function proxyLlm(llm) {
  if (!llm || typeof llm !== 'object') return llm
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'registerAdapter') {
        return (routes, adapter, ...rest) => {
          const list = Array.isArray(routes) ? routes : [routes]
          const nextAdapter = list.includes('vision-http') ? wrapVisionHttpAdapter(adapter) : adapter
          return target.registerAdapter(routes, nextAdapter, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Package entry seam. The large core stays provider-agnostic; this boundary
 * adds transport compatibility only around vision-router-owned tool/adapter
 * calls, so another plugin in the same DSH process is not silently modified.
 */
export function apply(ctx, config = {}) {
  const previousFetch = globalThis.fetch
  const compatFetch = (input, init) =>
    fetchWithOpenAICompatibility(
      previousFetch,
      input,
      init,
      httpCompatibilityContext.getStore() ?? {},
    )

  const tools = proxyTools(ctx.tools)
  const llm = proxyLlm(ctx.llm)
  let proxyFetchEffectRegistered = false

  const proxiedCtx = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return tools
      if (property === 'llm') return llm
      if (property === 'effect') {
        return (factory, label, ...rest) => {
          if (label !== 'vision-router: proxy fetch') {
            return target.effect(factory, label, ...rest)
          }
          proxyFetchEffectRegistered = true
          return target.effect(
            () => {
              let dispose
              try {
                dispose = factory()
              } catch (error) {
                if (globalThis.fetch === compatFetch) globalThis.fetch = previousFetch
                throw error
              }
              return () => {
                try {
                  if (typeof dispose === 'function') dispose()
                } finally {
                  // The core proxy restores the fetch it captured (compatFetch).
                  // Peel off this outer compatibility layer afterwards.
                  if (globalThis.fetch === compatFetch) globalThis.fetch = previousFetch
                }
              }
            },
            label,
            ...rest,
          )
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  globalThis.fetch = compatFetch
  try {
    const result = core.apply(proxiedCtx, config)
    // Core normally installs its own proxy-fetch effect synchronously. Keep a
    // defensive cleanup when running against a stripped/minimal host that does
    // not register that effect.
    if (!proxyFetchEffectRegistered && globalThis.fetch === compatFetch) {
      globalThis.fetch = previousFetch
    }
    return result
  } catch (error) {
    if (globalThis.fetch === compatFetch) globalThis.fetch = previousFetch
    throw error
  }
}

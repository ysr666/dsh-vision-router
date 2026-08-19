import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Execution policy for adapter-backed Vision Router calls.
 *
 * DSH intentionally treats an undeclared image capability as text-only. A
 * provider can still accept images, so an explicitly selected Vision Router
 * backend is allowed to prove itself. The important boundary is *where* the
 * failure happened: only DSH/pi-ai's local pre-wire image admission may unlock
 * the direct OpenAI-compatible compatibility bridge. Provider/network/auth
 * failures must stay failures — retrying them through a second transport can
 * duplicate requests, spend quota twice, and bypass adapter semantics.
 */

const visionExecutionScope = new AsyncLocalStorage()
const wrappedContexts = new WeakMap()

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function failureFromChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return undefined
  if (chunk.type === 'finish') {
    const reason = chunk.reason
    if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) return reason.failure
    return undefined
  }
  if (chunk.type === 'error' || chunk.type === 'aborted') return chunk.failure
  return undefined
}

/**
 * Exact DSH/pi-ai pre-wire admission rejection that proves the provider was
 * never contacted. Keep this intentionally narrow: another UNSUPPORTED_CONTENT
 * error (for example missing durable attachment support) is not evidence that
 * bypassing the adapter is safe.
 */
export function isLocalImageCapabilityAdmissionFailure(failure) {
  if (!failure || typeof failure !== 'object') return false
  if (failure.code !== 'UNSUPPORTED_CONTENT') return false
  if (failure.status !== undefined) return false
  const message = typeof failure.message === 'string' ? failure.message.trim() : ''
  return /^pi-ai model "[^"]+" does not support image input$/.test(message)
}

/** Exact pi-ai catalog miss: also pre-wire, but safe only with live evidence. */
export function isLocalUnknownModelFailure(failure, provider, model) {
  if (!failure || typeof failure !== 'object') return false
  if (failure.code !== 'UNKNOWN_MODEL' || failure.status !== undefined) return false
  const message = typeof failure.message === 'string' ? failure.message.trim() : ''
  return message === `pi-ai provider "${provider}" has no configured model "${model}"`
}

/**
 * Classify a terminal adapter result for compatibility-bridge policy.
 * `allow` means a direct bridge is safe to attempt; `deny` means the adapter
 * reached any other failure class and the original failure must propagate.
 */
export function bridgeDispositionForFailure(failure) {
  return isLocalImageCapabilityAdmissionFailure(failure) ? 'allow' : 'deny'
}

function policyKey(provider, model) {
  return `${String(provider ?? '')}\u0000${String(model ?? '')}`
}

function setPolicy(scope, provider, model, disposition) {
  if (!scope || !isNonEmptyString(provider) || !isNonEmptyString(model)) return
  scope.byPair.set(policyKey(provider, model), disposition)
  scope.byProvider.set(provider, disposition)
}

function clearPolicy(scope, provider, model) {
  if (!scope || !isNonEmptyString(provider)) return
  if (isNonEmptyString(model)) scope.byPair.delete(policyKey(provider, model))
  scope.byProvider.delete(provider)
}

function currentDisposition(provider, model) {
  const scope = visionExecutionScope.getStore()
  if (!scope || !isNonEmptyString(provider)) return undefined
  if (isNonEmptyString(model)) {
    const exact = scope.byPair.get(policyKey(provider, model))
    if (exact !== undefined) return exact
  }
  return scope.byProvider.get(provider)
}

function adapterWithoutPrivateTransport(adapter) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return adapter
  return new Proxy(adapter, {
    get(target, property) {
      // index.js's legacy direct bridge feature-detects PiAiAdapter.config.
      // Hide only after a non-admission failure so channelBridgePlan() fails
      // closed without mutating the real adapter or the host registry.
      if (property === 'config') return undefined
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function registrationForPolicy(registration, provider) {
  if (!registration || currentDisposition(provider) !== 'deny') return registration
  return {
    ...registration,
    adapter: adapterWithoutPrivateTransport(registration.adapter),
  }
}

function settingsWithoutBlockedProvider(settings) {
  if (!settings || (typeof settings !== 'object' && typeof settings !== 'function')) return settings
  return new Proxy(settings, {
    get(target, property) {
      if (property !== 'get') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const get = Reflect.get(target, property, target)
      if (typeof get !== 'function') return get
      return (namespace, ...args) => {
        const value = get.call(target, namespace, ...args)
        if (namespace !== 'llm-pi-ai' || !value || typeof value !== 'object') return value
        const providers = value.providers
        if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return value
        const scope = visionExecutionScope.getStore()
        const blocked = [...(scope?.byProvider?.entries?.() ?? [])]
          .filter(([, disposition]) => disposition === 'deny')
          .map(([provider]) => provider)
        if (blocked.length === 0) return value
        const nextProviders = { ...providers }
        let changed = false
        for (const provider of blocked) {
          if (Object.prototype.hasOwnProperty.call(nextProviders, provider)) {
            delete nextProviders[provider]
            changed = true
          }
        }
        return changed ? { ...value, providers: nextProviders } : value
      }
    },
  })
}

function llmWithExecutionPolicy(llm, options = {}) {
  const isLiveDiscovered = typeof options.isLiveDiscovered === 'function' ? options.isLiveDiscovered : () => false
  if (!llm || (typeof llm !== 'object' && typeof llm !== 'function')) return llm
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'registration') {
        const registration = Reflect.get(target, property, target)
        if (typeof registration !== 'function') return registration
        return (provider, ...args) => registrationForPolicy(
          registration.call(target, provider, ...args),
          provider,
        )
      }
      if (property === 'stream') {
        const stream = Reflect.get(target, property, target)
        if (typeof stream !== 'function') return stream
        return (optionsForCall) => {
          const scope = visionExecutionScope.getStore()
          const provider = optionsForCall && optionsForCall.provider
          const model = optionsForCall && optionsForCall.model
          if (scope === undefined || !isNonEmptyString(provider) || !isNonEmptyString(model)) {
            return stream.call(target, optionsForCall)
          }

          // A new adapter attempt owns the decision for this exact pair. Never
          // let a previous fallback attempt leak its bridge permission/denial.
          clearPolicy(scope, provider, model)
          const iterable = stream.call(target, optionsForCall)
          return {
            async *[Symbol.asyncIterator]() {
              let sawTerminalFailure = false
              try {
                for await (const chunk of iterable) {
                  const failure = failureFromChunk(chunk)
                  if (failure !== undefined) {
                    sawTerminalFailure = true
                    const liveCatalogMiss =
                      isLocalUnknownModelFailure(failure, provider, model) &&
                      isLiveDiscovered(provider, model) === true
                    setPolicy(
                      scope,
                      provider,
                      model,
                      liveCatalogMiss ? 'allow' : bridgeDispositionForFailure(failure),
                    )
                  }
                  yield chunk
                }
              } catch (error) {
                // Waterfall/plugin errors are not the known pi-ai local
                // admission shape. Fail closed instead of authorizing a bypass.
                sawTerminalFailure = true
                setPolicy(scope, provider, model, 'deny')
                throw error
              } finally {
                // A successful stream leaves no stale policy behind. Terminal
                // failure state intentionally survives until the caller's
                // immediate bridge decision, then the next attempt clears it.
                if (!sawTerminalFailure) clearPolicy(scope, provider, model)
              }
            },
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function toolsWithExecutionScope(tools) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  const wrappedDefinitions = new WeakMap()
  return new Proxy(tools, {
    get(target, property) {
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (definition, ...rest) => {
          if (
            !definition ||
            typeof definition !== 'object' ||
            !isNonEmptyString(definition.name) ||
            !definition.name.startsWith('vision_') ||
            typeof definition.execute !== 'function'
          ) {
            return register.call(target, definition, ...rest)
          }
          let wrapped = wrappedDefinitions.get(definition)
          if (wrapped === undefined) {
            const execute = definition.execute
            wrapped = {
              ...definition,
              execute(...args) {
                return visionExecutionScope.run(
                  { byPair: new Map(), byProvider: new Map() },
                  () => execute.apply(definition, args),
                )
              },
            }
            wrappedDefinitions.set(definition, wrapped)
          }
          return register.call(target, wrapped, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Private context view used only by Vision Router's core implementation.
 *
 * The legacy core already owns the direct HTTP bridge; this boundary supplies
 * the missing provenance information without mutating DSH globally. During a
 * vision tool call it observes the structured terminal failure emitted by the
 * LLM runtime. Non-admission failures temporarily hide the private pi-ai
 * transport/config facts that the legacy bridge requires, so it cannot retry a
 * real provider/network failure through a second path. The exact local
 * text-only image-admission failure leaves those facts visible and therefore
 * preserves the intended no-YAML compatibility bridge. A local UNKNOWN_MODEL
 * is bridge-eligible only when the Host's live endpoint discovery independently
 * saw that exact provider/model, which solves static-catalog lag without making
 * arbitrary model ids a direct-request capability.
 */
export function contextWithVisionExecutionPolicy(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const llm = llmWithExecutionPolicy(ctx.llm, options)
  const tools = toolsWithExecutionScope(ctx.tools)
  const settingsCache = new WeakMap()
  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llm
      if (property === 'tools') return tools
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (name, ...args) => {
          const value = get.call(target, name, ...args)
          if (name !== 'settings' || value === undefined || value === null) return value
          let view = settingsCache.get(value)
          if (view === undefined) {
            view = settingsWithoutBlockedProvider(value)
            settingsCache.set(value, view)
          }
          return view
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedContexts.set(ctx, wrapped)
  try {
    ctx.effect?.(
      () => () => {
        if (wrappedContexts.get(ctx) === wrapped) wrappedContexts.delete(ctx)
      },
      'vision-router: strict vision execution policy context',
    )
  } catch {
    /* lifecycle hardening must never block plugin apply */
  }
  return wrapped
}

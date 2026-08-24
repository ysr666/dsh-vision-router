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

function safeLog(logger, level, ...args) {
  const method = logger && typeof logger[level] === 'function' ? logger[level] : undefined
  if (!method) return
  try {
    method.apply(logger, args)
  } catch {
    // Diagnostics must never alter execution semantics.
  }
}

function compactFailureCode(failure) {
  if (!failure || typeof failure !== 'object') return 'UNKNOWN'
  if (typeof failure.code === 'string' && failure.code !== '') return failure.code
  if (failure.status !== undefined) return `HTTP_${String(failure.status)}`
  return failure?.name || 'ERROR'
}

function compactDiagnosticDetail(value, maxLength = 800) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}…`
}

function evidenceSource(options, provider, model) {
  const resolver = typeof options.evidenceSource === 'function' ? options.evidenceSource : undefined
  if (!resolver) return 'catalog-or-configured'
  try {
    const source = resolver(provider, model)
    return isNonEmptyString(source) ? source : 'catalog-or-configured'
  } catch {
    return 'catalog-or-configured'
  }
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

/** Exact pi-ai catalog miss: also pre-wire, but safe only with trusted evidence. */
export function isLocalUnknownModelFailure(failure, provider, model) {
  if (!failure || typeof failure !== 'object') return false
  if (failure.code !== 'UNKNOWN_MODEL' || failure.status !== undefined) return false
  const message = typeof failure.message === 'string' ? failure.message.trim() : ''
  return message === `pi-ai provider "${provider}" has no configured model "${model}"`
}

/**
 * Classify a provider/local failure for compatibility-bridge policy.
 * `allow` means a direct bridge is safe to attempt; `deny` means the adapter
 * reached any other failure class and the original failure must propagate.
 */
export function bridgeDispositionForFailure(failure) {
  return isLocalImageCapabilityAdmissionFailure(failure) ? 'allow' : 'deny'
}

/**
 * Apply the same narrow bridge policy to both structured terminal chunks and
 * errors thrown directly by an adapter's async iterator. DSH pi-ai throws its
 * exact pre-wire UNKNOWN_MODEL from modelOf() before yielding a chunk, so a
 * trusted/live model omitted from DSH's static catalog must not be converted
 * into a blanket deny merely because the failure arrived through `throw`.
 */
export function bridgeDispositionForObservedFailure(failure, provider, model, hasBridgeEvidence = () => false) {
  let evidence = false
  if (isLocalUnknownModelFailure(failure, provider, model)) {
    try {
      evidence = hasBridgeEvidence(provider, model) === true
    } catch {
      evidence = false
    }
  }
  return evidence ? 'allow' : bridgeDispositionForFailure(failure)
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

function markBridgeAttempt(scope, provider) {
  if (!scope || currentDisposition(provider) !== 'allow') return
  const failure = scope.lastFailureByProvider.get(provider)
  if (!failure) return
  const key = policyKey(failure.provider, failure.model)
  if (scope.bridgeAttempts.has(key)) return
  scope.bridgeAttempts.add(key)
  scope.lastBridge = failure
  scope.bridgeFallbackObserved = false
  scope.bridgeSuperseded = false
  safeLog(
    scope.diagnosticLogger,
    'info',
    'vision-router: vision bridge attempt [%s/%s] source=%s reason=%s',
    failure.provider,
    failure.model,
    failure.source,
    failure.code,
  )
}

function registrationForPolicy(registration, provider) {
  if (!registration) return registration
  const disposition = currentDisposition(provider)
  if (disposition === 'allow') markBridgeAttempt(visionExecutionScope.getStore(), provider)
  if (disposition !== 'deny') return registration
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

function recordObservedFailure(scope, options, hasBridgeEvidence, provider, model, failure) {
  const disposition = bridgeDispositionForObservedFailure(
    failure,
    provider,
    model,
    hasBridgeEvidence,
  )
  const source = evidenceSource(options, provider, model)
  const code = compactFailureCode(failure)
  const record = { provider, model, source, code, disposition }
  setPolicy(scope, provider, model, disposition)
  scope.lastFailureByProvider.set(provider, record)
  safeLog(
    scope.diagnosticLogger,
    'info',
    'vision-router: vision backend failed [%s/%s] via=adapter source=%s code=%s bridge=%s',
    provider,
    model,
    source,
    code,
    disposition,
  )
}

function llmWithExecutionPolicy(llm, options = {}) {
  // PR #230 intentionally wrapped liveDiscovery.hasModel() with endpoint-scoped
  // trusted visual hints. Keep the old option name for compatibility, but treat
  // it as generic bridge evidence rather than endpoint-list evidence only.
  const hasBridgeEvidence =
    typeof options.isBridgeEvidence === 'function'
      ? options.isBridgeEvidence
      : typeof options.isLiveDiscovered === 'function'
        ? options.isLiveDiscovered
        : () => false
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
          if (scope.lastBridge) scope.bridgeSuperseded = true
          const source = evidenceSource(options, provider, model)
          safeLog(
            scope.diagnosticLogger,
            'info',
            'vision-router: vision backend attempt [%s/%s] via=adapter source=%s',
            provider,
            model,
            source,
          )
          return {
            async *[Symbol.asyncIterator]() {
              let sawTerminalFailure = false
              try {
                // Construct the iterable inside the guarded section too. Most
                // adapters throw lazily during iteration, but a synchronous
                // pre-wire refusal must receive the identical classification.
                const iterable = stream.call(target, optionsForCall)
                for await (const chunk of iterable) {
                  const failure = failureFromChunk(chunk)
                  if (failure !== undefined) {
                    sawTerminalFailure = true
                    recordObservedFailure(scope, options, hasBridgeEvidence, provider, model, failure)
                  }
                  yield chunk
                }
              } catch (error) {
                // PiAiAdapter throws UNKNOWN_MODEL and local image-admission
                // failures directly from the async iterator before any chunk.
                // Classify that exact pre-wire shape just like a terminal
                // failure chunk; every provider/network/auth error still denies.
                sawTerminalFailure = true
                recordObservedFailure(scope, options, hasBridgeEvidence, provider, model, error)
                throw error
              } finally {
                // A successful stream leaves no stale policy behind. Terminal
                // failure state intentionally survives until the caller's
                // immediate bridge decision, then the next attempt clears it.
                if (!sawTerminalFailure) {
                  clearPolicy(scope, provider, model)
                  scope.lastSuccessfulAdapter = { provider, model, source }
                  safeLog(
                    scope.diagnosticLogger,
                    'info',
                    'vision-router: vision backend success [%s/%s] via=adapter source=%s',
                    provider,
                    model,
                    source,
                  )
                }
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

function loggerWithExecutionDiagnostics(logger, diagnosticLogger) {
  if (!logger || (typeof logger !== 'object' && typeof logger !== 'function')) return logger
  return new Proxy(logger, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args) => {
        const scope = visionExecutionScope.getStore()
        const bridgeFailureFormat = 'vision-router: vision_describe fallback [%s] (%s, %d ms): %s'
        if (
          scope &&
          property === 'warn' &&
          args[0] === bridgeFailureFormat &&
          scope.lastBridge
        ) {
          const backend = String(args[1] ?? '')
          const expectedBackend = `${scope.lastBridge.provider}/${scope.lastBridge.model}`
          if (backend === expectedBackend) {
            scope.bridgeFallbackObserved = true
            safeLog(
              diagnosticLogger,
              'info',
              'vision-router: vision bridge failed [%s/%s] source=%s kind=%s detail=%s',
              scope.lastBridge.provider,
              scope.lastBridge.model,
              scope.lastBridge.source,
              compactDiagnosticDetail(args[2] ?? 'unknown'),
              compactDiagnosticDetail(args[4] ?? ''),
            )
          }
        }
        return value.apply(target, args)
      }
    },
  })
}

function toolsWithExecutionScope(tools, options = {}) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  const wrappedDefinitions = new WeakMap()
  const diagnosticLogger = options.logger
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
                const scope = {
                  byPair: new Map(),
                  byProvider: new Map(),
                  lastFailureByProvider: new Map(),
                  bridgeAttempts: new Set(),
                  lastBridge: undefined,
                  bridgeFallbackObserved: false,
                  bridgeSuperseded: false,
                  lastSuccessfulAdapter: undefined,
                  diagnosticLogger,
                  toolName: definition.name,
                }
                return visionExecutionScope.run(scope, async () => {
                  try {
                    const result = await execute.apply(definition, args)
                    if (
                      scope.lastBridge &&
                      !scope.bridgeFallbackObserved &&
                      !scope.bridgeSuperseded
                    ) {
                      safeLog(
                        diagnosticLogger,
                        'info',
                        'vision-router: vision backend success [%s/%s] via=direct-bridge source=%s tool=%s',
                        scope.lastBridge.provider,
                        scope.lastBridge.model,
                        scope.lastBridge.source,
                        definition.name,
                      )
                    }
                    return result
                  } catch (error) {
                    if (
                      scope.lastBridge &&
                      !scope.bridgeFallbackObserved &&
                      !scope.bridgeSuperseded
                    ) {
                      safeLog(
                        diagnosticLogger,
                        'info',
                        'vision-router: vision bridge ended without success [%s/%s] source=%s code=%s tool=%s',
                        scope.lastBridge.provider,
                        scope.lastBridge.model,
                        scope.lastBridge.source,
                        compactFailureCode(error),
                        definition.name,
                      )
                    }
                    throw error
                  }
                })
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
 * vision tool call it observes both structured terminal failures and direct
 * adapter throws. Non-admission failures temporarily hide the private pi-ai
 * transport/config facts that the legacy bridge requires, so it cannot retry a
 * real provider/network failure through a second path. The exact local
 * text-only image-admission failure leaves those facts visible and therefore
 * preserves the intended no-YAML compatibility bridge. A local UNKNOWN_MODEL
 * is bridge-eligible only when the Host's private registry has trusted evidence
 * for that exact provider/model (current live discovery or an endpoint-scoped
 * trusted hint), which solves static-catalog lag without making arbitrary model
 * ids a direct-request capability. The same scope records backend provenance so
 * bug reports can show which model was attempted, whether the direct bridge was
 * entered, and which adapter/bridge path actually completed.
 */
export function contextWithVisionExecutionPolicy(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const llm = llmWithExecutionPolicy(ctx.llm, options)
  const tools = toolsWithExecutionScope(ctx.tools, options)
  const settingsCache = new WeakMap()
  const diagnosticCtxLogger = loggerWithExecutionDiagnostics(ctx.logger, options.logger)
  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llm
      if (property === 'tools') return tools
      if (property === 'logger') return diagnosticCtxLogger
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

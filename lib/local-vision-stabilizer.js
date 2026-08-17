/**
 * Narrow runtime guard around the local-vision features merged in #141.
 *
 * The large router core stays untouched: this layer only fixes seams that are
 * specific to opt-in local vision, while non-local providers continue through
 * the original adapters byte-for-byte.
 */
export function installLocalVisionStabilizer(ctx, config = {}, core) {
  if (!ctx || typeof ctx !== 'object') return { ctx, bootConfig: config }

  let rawScope
  let preStepDepth = 0
  let wrapperStreamDepth = 0
  let screenshotCandidate
  let screenshotHandle
  let screenshotMountedDef

  const rawTools = ctx.tools
  const rawLlm = ctx.llm
  const rawInject = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : undefined
  const rawOn = typeof ctx.on === 'function' ? ctx.on.bind(ctx) : undefined

  const positive = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? Number(value) : fallback

  const actualConfig = () => {
    try {
      const value = rawScope && typeof rawScope.get === 'function' ? rawScope.get() : config
      return value && typeof value === 'object' ? value : config
    } catch {
      return config
    }
  }

  const localTaskBudget = (value = actualConfig()) =>
    Math.max(
      1000,
      Math.min(
        positive(value.timeoutMs, 120000),
        positive(value.visionTaskTimeoutMs, 45000),
      ),
    )

  const configForCore = () => {
    const actual = actualConfig()
    let view = actual
    // instantDescribe is a pre-step convenience; do not let its local HTTP
    // pass exceed the normal whole-vision task deadline (120s -> 45s by
    // default). Other tools keep the user's ordinary timeoutMs unchanged.
    if (preStepDepth > 0 && actual.instantDescribe === true) {
      const bounded = localTaskBudget(actual)
      if (positive(actual.timeoutMs, 120000) !== bounded) {
        view = { ...view, timeoutMs: bounded }
      }
    }
    // The pre-step owns the single automatic local caption pass. If that pass
    // failed, the wrapper must not immediately repeat it with a fresh timeout.
    if (wrapperStreamDepth > 0 && view.instantDescribe === true) {
      view = { ...view, instantDescribe: false }
    }
    return view
  }

  const unmountScreenshot = () => {
    if (typeof screenshotHandle === 'function') {
      try { screenshotHandle() } catch { /* best effort */ }
    }
    screenshotHandle = undefined
    screenshotMountedDef = undefined
  }

  const syncScreenshot = () => {
    if (!screenshotCandidate || !rawTools || typeof rawTools.register !== 'function') return
    if (actualConfig().desktopScreenshot !== true) {
      unmountScreenshot()
      return
    }
    if (screenshotHandle && screenshotMountedDef === screenshotCandidate) return
    unmountScreenshot()
    screenshotHandle = rawTools.register(screenshotCandidate)
    screenshotMountedDef = screenshotCandidate
  }

  // Core must construct the screenshot definition even when the persisted
  // setting is currently off, otherwise a later GUI opt-in has nothing to
  // register. The settings base is replaced with the real config below, so
  // this construction-only flag never changes the user's resolved default.
  const bootConfig = { ...config, desktopScreenshot: true }

  const tools = rawTools && typeof rawTools === 'object'
    ? new Proxy(rawTools, {
        get(target, property) {
          if (property !== 'register') {
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (def) => {
            if (def && def.name === 'vision_screenshot') {
              screenshotCandidate = def
              syncScreenshot()
              let active = true
              return () => {
                if (!active) return
                active = false
                if (screenshotCandidate === def) screenshotCandidate = undefined
                if (screenshotMountedDef === def) unmountScreenshot()
              }
            }
            return target.register(def)
          }
        },
      })
    : rawTools

  const resolveCredential = async (ref) => {
    if (typeof ref !== 'string' || ref === '') return undefined
    try {
      return (await ctx.get('credentials')?.resolve(ref))?.value
    } catch {
      return undefined
    }
  }

  const localMessages = async (options) => {
    const attachments = ctx.get('attachments')
    const current = actualConfig()
    const messages = []
    for (const message of options.messages ?? []) {
      if (!message || !Array.isArray(message.content)) continue
      const content = []
      for (const block of message.content) {
        if (block && block.type === 'image' && block.attachment) {
          if (!attachments || typeof attachments.readImage !== 'function') continue
          try {
            const stored = await attachments.readImage(block.attachment)
            let bytes = stored.data
            if (current.downscale !== false && bytes && bytes.length > 0) {
              bytes = await core.downscaleImage(
                bytes,
                positive(current.downscaleMaxPixels, 4000000),
              )
            }
            content.push(...core.toOpenAIContent([block], () => bytes))
          } catch (error) {
            ctx.logger?.warn(
              'vision-http: failed to read image attachment: %s',
              error && error.message ? error.message : String(error),
            )
          }
        } else if (block && block.type === 'tool-result') {
          const parts = []
          for (const nested of Array.isArray(block.content) ? block.content : []) {
            if (nested && nested.type === 'text' && typeof nested.text === 'string') {
              parts.push(nested.text)
            } else if (nested && nested.type === 'image') {
              const attachment = nested.attachment || {}
              const id = attachment.attachmentId || attachment.id || 'unknown'
              parts.push(
                `[attached image: ${id}] this tool result contained an image; ` +
                  'inspect it with vision_describe (or re-read it with read_image)',
              )
            }
          }
          if (parts.length > 0) {
            const call = typeof block.toolCallId === 'string' ? block.toolCallId : ''
            content.push({
              type: 'text',
              text: `[tool result${call ? ` ${call}` : ''}]\n${parts.join('\n')}`,
            })
          }
        } else if (block && block.type === 'text' && typeof block.text === 'string') {
          content.push({ type: 'text', text: block.text })
        }
      }
      if (content.length > 0) messages.push({ role: message.role, content })
    }
    return messages
  }

  const wrapVisionHttpAdapter = (adapter) =>
    new Proxy(adapter, {
      get(target, property) {
        if (property !== 'stream') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async function* stream(options) {
          const local = core
            .localProvidersOf(actualConfig())
            .find((provider) => `${provider.name}/${provider.model}` === options.model)
          if (!local) {
            yield* target.stream(options)
            return
          }
          try {
            // Both local protocols go through the same local dispatcher. This
            // is what preserves explicit temperature/top_p in the default
            // OpenAI route as well as the Anthropic route.
            const text = await core.callLocalBackend(local, await localMessages(options), {
              maxTokens: local.maxTokens ?? 4096,
              signal: options.signal,
              resolveCredential,
            })
            if (text !== '') {
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'text-delta', index: 0, text }
              yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          } catch (error) {
            const classification = core.classifyVisionFailure(error)
            const kinds = core.VISION_FAILURE_KINDS || {}
            const code =
              classification.kind === kinds.AUTH
                ? 'AUTH'
                : classification.kind === kinds.RATE_LIMIT
                  ? 'RATE_LIMIT'
                  : classification.kind === kinds.TIMEOUT
                    ? 'TIMEOUT'
                    : 'HTTP_PROVIDER_FAILED'
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  message: error && error.message ? error.message : String(error),
                  code,
                },
              },
            }
          }
        }
      },
    })

  const isWrapperRoute = (provider) => {
    if (typeof provider !== 'string' || provider === '') return false
    const current = actualConfig()
    const wrapper =
      typeof current.wrapperRoute === 'string' && current.wrapperRoute !== ''
        ? current.wrapperRoute
        : 'deepseek-vision'
    return provider === wrapper || provider === 'deepseek-official' || provider.endsWith('-vision')
  }

  const wrapWrapperAdapter = (adapter) =>
    new Proxy(adapter, {
      get(target, property) {
        if (property !== 'stream') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async function* stream(options) {
          wrapperStreamDepth += 1
          try {
            yield* target.stream(options)
          } finally {
            wrapperStreamDepth = Math.max(0, wrapperStreamDepth - 1)
          }
        }
      },
    })

  const llm = rawLlm && typeof rawLlm === 'object'
    ? new Proxy(rawLlm, {
        get(target, property) {
          if (property !== 'registerAdapter') {
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (providers, adapter) => {
            const list = Array.isArray(providers) ? providers : []
            let wrapped = adapter
            if (list.includes('vision-http')) wrapped = wrapVisionHttpAdapter(wrapped)
            else if (list.some(isWrapperRoute)) wrapped = wrapWrapperAdapter(wrapped)
            return target.registerAdapter(providers, wrapped)
          }
        },
      })
    : rawLlm

  const wrapScope = (scope) =>
    new Proxy(scope, {
      get(target, property) {
        if (property === 'get') return () => configForCore()
        if (property === 'watch') {
          const watch = Reflect.get(target, property, target)
          if (typeof watch !== 'function') return watch
          return (listener) =>
            watch.call(target, (...args) => {
              syncScreenshot()
              return listener(...args)
            })
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

  const wrapSettings = (settings) =>
    new Proxy(settings, {
      get(target, property) {
        if (property !== 'register') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (namespace, schema, options = {}) => {
          // Core receives bootConfig only so it constructs the screenshot tool;
          // resolved Settings must still inherit the user's real composition
          // config (where desktopScreenshot remains false unless opted in).
          const fixedOptions =
            namespace === 'vision-router' ? { ...options, base: config } : options
          const scope = target.register(namespace, schema, fixedOptions)
          if (namespace === 'vision-router') {
            rawScope = scope
            syncScreenshot()
            return wrapScope(scope)
          }
          return scope
        }
      },
    })

  const probeLocal = async (provider, signal) => {
    try {
      const response = await globalThis.fetch(`${provider.baseURL.replace(/\/$/, '')}/models`, {
        method: 'GET',
        signal,
      })
      if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
      const data = await response.json().catch(() => undefined)
      const models = data && Array.isArray(data.data) ? data.data : undefined
      if (
        models &&
        typeof provider.model === 'string' &&
        provider.model !== '' &&
        !models.some((entry) => entry && String(entry.id) === provider.model)
      ) {
        return {
          ok: false,
          status: response.status,
          models: models.length,
          error: `configured model "${provider.model}" was not returned by /models`,
        }
      }
      return {
        ok: true,
        status: response.status,
        models: models ? models.length : undefined,
        endpoint: provider.baseURL,
      }
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }

  const wrapWebServer = (webServer) =>
    new Proxy(webServer, {
      get(target, property) {
        if (property !== 'register') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (spec) => {
          if (!spec || spec.path !== '/_dsh/vision-router/test-connection') {
            return target.register(spec)
          }
          const originalHandler = spec.handler
          return target.register({
            ...spec,
            handler: async (req, res) => {
              const locals = core.localProvidersOf(actualConfig())
              if (req.method !== 'GET' || locals.length < 2) return originalHandler(req, res)
              const started = Date.now()
              const attempts = []
              for (let index = 0; index < locals.length; index++) {
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), 5000)
                try {
                  const result = await probeLocal(locals[index], controller.signal)
                  attempts.push({ backend: locals[index].name, ...result })
                  if (result.ok) {
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({
                      ...result,
                      ok: true,
                      backend: locals[index].name,
                      fallbackUsed: index > 0,
                      latencyMs: Date.now() - started,
                      attempts,
                    }))
                    return
                  }
                } finally {
                  clearTimeout(timer)
                }
              }
              res.writeHead(502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({
                ok: false,
                latencyMs: Date.now() - started,
                error: 'all enabled local vision backends failed the connection probe',
                attempts,
              }))
            },
          })
        }
      },
    })

  const inject = rawInject
    ? (deps, callback) =>
        rawInject(deps, (childCtx) => {
          let wrapped = childCtx
          if (Array.isArray(deps) && deps.includes('settings') && childCtx?.settings) {
            const parent = wrapped
            wrapped = new Proxy(parent, {
              get(target, property) {
                if (property === 'settings') return wrapSettings(target.settings)
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          }
          if (Array.isArray(deps) && deps.includes('webServer') && childCtx?.webServer) {
            const parent = wrapped
            wrapped = new Proxy(parent, {
              get(target, property) {
                if (property === 'webServer') return wrapWebServer(target.webServer)
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          }
          return callback(wrapped)
        })
    : undefined

  const on = rawOn
    ? (event, handler) => {
        if (event !== 'agent/pre-step') return rawOn(event, handler)
        return rawOn(event, async (...args) => {
          preStepDepth += 1
          try {
            return await handler(...args)
          } finally {
            preStepDepth = Math.max(0, preStepDepth - 1)
          }
        })
      }
    : undefined

  try {
    ctx.effect?.(
      () => () => unmountScreenshot(),
      'vision-router: local vision stabilizer',
    )
  } catch {
    /* cleanup registration is best effort */
  }

  const stabilizedCtx = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return tools
      if (property === 'llm') return llm
      if (property === 'inject' && inject) return inject
      if (property === 'on' && on) return on
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return { ctx: stabilizedCtx, bootConfig }
}

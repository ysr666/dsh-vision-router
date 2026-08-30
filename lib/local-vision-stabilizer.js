import { execFile } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { sameOriginRequest } from './adversarial-hardening.js'
import { normalizeRuntimeVisionConfig } from './runtime-config-normalizer.js'

/**
 * Narrow runtime guard around the local-vision features merged in #141.
 *
 * The large router core stays untouched: this layer only fixes seams that are
 * specific to opt-in local vision, while non-local providers continue through
 * the original adapters byte-for-byte.
 */
export async function triggerDesktopScreenshotPermission({
  platform = typeof process !== 'undefined' ? process.platform : '',
  run = promisify(execFile),
  remove = unlink,
  tempDir = tmpdir(),
} = {}) {
  // Windows has no Screen Recording privacy prompt equivalent and Linux
  // capture permission is compositor-specific. macOS is the platform where
  // enabling this feature must proactively cross an OS privacy boundary.
  if (platform !== 'darwin') return { ok: true, platform, requested: false }
  const target = path.join(
    tempDir,
    `vision-screenshot-permission-${Date.now()}-${Math.floor(Math.random() * 1e9)}.png`,
  )
  try {
    await run('screencapture', ['-x', '-m', target], { timeout: 15000 })
    return { ok: true, platform, requested: true }
  } catch (error) {
    return {
      ok: false,
      platform,
      requested: true,
      error: error && error.message ? error.message : String(error),
    }
  } finally {
    try { await remove(target) } catch { /* best effort */ }
  }
}

export function installLocalVisionStabilizer(ctx, config = {}, core) {
  config = normalizeRuntimeVisionConfig(config)
  if (!ctx || typeof ctx !== 'object') return { ctx, bootConfig: config }

  let rawScope
  let preStepDepth = 0
  let wrapperStreamDepth = 0
  let screenshotCandidate
  let screenshotHandle
  let screenshotMountedDef
  const screenshotPermissionRoutes = new Map()

  const rawTools = ctx.tools
  const rawLlm = ctx.llm
  const rawInject = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : undefined
  const rawOn = typeof ctx.on === 'function' ? ctx.on.bind(ctx) : undefined

  const positive = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? Number(value) : fallback

  const actualConfig = () => {
    try {
      const value = rawScope && typeof rawScope.get === 'function' ? rawScope.get() : config
      return normalizeRuntimeVisionConfig(value && typeof value === 'object' ? value : config)
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
    // `instantDescribe` / `localDescribeStyle` are retained in the schema only
    // so old profiles keep loading. The public model now has exactly one
    // automatic first-pass switch: structuredVisionBootstrap (1+x). Keep the
    // old automatic caption path disabled and use one fixed structured prompt
    // for the optional screenshot-identify helper.
    return { ...actual, instantDescribe: false, localDescribeStyle: 'structured' }
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
    const current = actualConfig()
    // desktopScreenshot owns schema exposure. The global tool toggle is a live
    // execution permission enforced by the runtime boundary (and the captured
    // execute guard below), so flipping it must not churn the tool schema.
    if (current.desktopScreenshot !== true) {
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
  const bootConfig = { ...config, desktopScreenshot: true, instantDescribe: false, localDescribeStyle: 'structured' }

  const tools = rawTools && typeof rawTools === 'object'
    ? new Proxy(rawTools, {
        get(target, property) {
          if (property !== 'register') {
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (def) => {
            if (def && def.name === 'vision_screenshot') {
              const candidate =
                typeof def.execute === 'function'
                  ? {
                      ...def,
                      async execute(args, exec) {
                        if (actualConfig().tool === false) {
                          throw new Error(
                            'vision_screenshot: vision tools are disabled in the Vision Router settings',
                          )
                        }
                        return def.execute.call(this, args, exec)
                      },
                    }
                  : def
              screenshotCandidate = candidate
              syncScreenshot()
              let active = true
              return () => {
                if (!active) return
                active = false
                if (screenshotCandidate === candidate) screenshotCandidate = undefined
                if (screenshotMountedDef === candidate) unmountScreenshot()
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

  const wrapSettings = (settings, ownerCtx) =>
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
            // The Settings service is dynamic. Never keep its scope after the
            // owning injection fiber unloads; during the gap fall back to the
            // composition config, then bind the new scope on service restore.
            try {
              ownerCtx?.effect?.(
                () => () => {
                  if (rawScope !== scope) return
                  rawScope = undefined
                  syncScreenshot()
                },
                'vision-router: local settings scope lifecycle',
              )
            } catch {
              /* lifecycle hardening must not block Settings registration */
            }
            return wrapScope(scope)
          }
          return scope
        }
      },
    })

  const releaseScreenshotPermissionRoute = (webServer, handle) => {
    if (!screenshotPermissionRoutes.has(webServer)) return
    if (screenshotPermissionRoutes.get(webServer) !== handle) return
    try {
      if (typeof handle === 'function') handle()
    } catch {
      /* best effort */
    }
    screenshotPermissionRoutes.delete(webServer)
  }

  const ensureScreenshotPermissionRoute = (webServer, ownerCtx) => {
    if (!webServer || typeof webServer.register !== 'function') return
    if (screenshotPermissionRoutes.has(webServer)) return
    const handle = webServer.register({
      path: '/_dsh/vision-router/request-screenshot-permission',
      handler: async (req, res) => {
        res.setHeader?.('content-type', 'application/json')
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        if (!sameOriginRequest(req)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'cross-origin screenshot permission request rejected' }))
          return
        }
        const current = actualConfig()
        if (current.tool === false) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'vision tools are disabled' }))
          return
        }
        if (current.desktopScreenshot !== true) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'desktop screenshot is disabled' }))
          return
        }
        const result = await triggerDesktopScreenshotPermission()
        res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      },
    })
    screenshotPermissionRoutes.set(webServer, handle)
    // Multiple core injections share one webServer instance. The Map prevents
    // duplicate routes, while the first owning child fiber removes the route
    // when that server instance disappears so a replacement can mount afresh.
    try {
      ownerCtx?.effect?.(
        () => () => releaseScreenshotPermissionRoute(webServer, handle),
        'vision-router: screenshot permission route lifecycle',
      )
    } catch {
      /* parent stabilizer cleanup remains a final fallback */
    }
  }

  // Register the screenshot-permission endpoint from its own raw webServer
  // injection. Do not proxy core webServer child contexts: DSH 0.1.0-rc.6
  // associates effect ownership with the original injected child context, and
  // substituting a Proxy caused later route effects (update/self-update/model
  // capabilities) to disappear while the first route survived (#160).
  try {
    rawInject?.(['webServer'], (ownerCtx) => {
      ensureScreenshotPermissionRoute(ownerCtx?.webServer, ownerCtx)
    })
  } catch (error) {
    ctx.logger?.warn(
      'vision-router: screenshot permission route injection failed: %s',
      error && error.message ? error.message : String(error),
    )
  }

  const inject = rawInject
    ? (deps, callback) =>
        rawInject(deps, (childCtx) => {
          let wrapped = childCtx
          if (Array.isArray(deps) && deps.includes('settings') && childCtx?.settings) {
            const parent = wrapped
            wrapped = new Proxy(parent, {
              get(target, property) {
                if (property === 'settings') return wrapSettings(target.settings, childCtx)
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
      () => () => {
        rawScope = undefined
        unmountScreenshot()
        for (const [webServer, handle] of screenshotPermissionRoutes) {
          releaseScreenshotPermissionRoute(webServer, handle)
        }
        screenshotPermissionRoutes.clear()
      },
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

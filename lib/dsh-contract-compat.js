const HOST_OWNED_ROUTES = new Set(['deepseek-official', 'deepseek-official-native'])

const LEGACY_VISION_ATTACHMENT_BYTES = 20 * 1024 * 1024
const LEGACY_VISION_ATTACHMENT_PIXELS = 100_000_000
const DSH_RC8_DEFAULT_IMAGE_DIMENSION = 2000
const VISION_ROUTER_IMAGE_DIMENSION = 10_000

function attachmentStoreOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return undefined
  try {
    if (typeof ctx.get === 'function') {
      const store = ctx.get('attachments')
      if (store && typeof store === 'object') return store
    }
  } catch {
    // A detached/partial test context may not expose the service yet.
  }
  try {
    const store = ctx.attachments
    return store && typeof store === 'object' ? store : undefined
  } catch {
    return undefined
  }
}

/**
 * Detect the released batch-attachment contract directly. DSH rc.6 exposes
 * validateImage/saveImage/readImage only; rc.7+ adds AttachmentStore.saveImages().
 * Do not infer this from unrelated LLM/settings methods: rc.6 already shipped
 * registerConfigurableProviders(), so those methods cannot prove the attachment
 * ownership generation.
 */
export function hasBatchAttachmentContract(ctx) {
  const store = attachmentStoreOf(ctx)
  return !!store && typeof store.saveImages === 'function'
}

/**
 * Repair one historical Vision Router profile overlay on DSH rc.8.
 *
 * Before rc.8 introduced maxImageDimension, Vision Router wrote a profile-local
 * attachment-local override containing only 20MiB / 100MP. DSH patch rows
 * replace the WHOLE config object instead of deep-merging it, so that later
 * profile layer shadows the newer bundle row and rc.8 silently rematerializes
 * its own 2000px default. Plugin updates cannot delete a user's profile layer.
 *
 * The historical 20MiB + 100MP pair is therefore the migration fingerprint.
 * Only when that exact pair is combined with rc.8's exact 2000px default do we
 * raise the live store policy to Vision Router's 10000px contract. Explicitly
 * customised dimensions or unrelated attachment deployments are never touched.
 * LocalAttachmentStore reads `this.imageLimits` for every validation/save, so
 * replacing this immutable policy object repairs authoritative admission as
 * well as the limits projected to the browser for error copy.
 */
export function ensureVisionAttachmentAdmissionPolicy(ctx, logger, options = {}) {
  const store = attachmentStoreOf(ctx)
  const limits = store && store.imageLimits
  if (!store || !limits || typeof limits !== 'object') {
    return { changed: false, reason: 'attachment-limits-unavailable' }
  }

  const targetDimension = Number.isInteger(options.maxImageDimension)
    ? Math.max(1, options.maxImageDimension)
    : VISION_ROUTER_IMAGE_DIMENSION
  const legacy =
    limits.maxImageBytes === LEGACY_VISION_ATTACHMENT_BYTES &&
    limits.maxImagePixels === LEGACY_VISION_ATTACHMENT_PIXELS &&
    limits.maxImageDimension === DSH_RC8_DEFAULT_IMAGE_DIMENSION

  if (!legacy) return { changed: false, reason: 'not-legacy-overlay', limits }

  const next = Object.freeze({ ...limits, maxImageDimension: targetDimension })
  let changed = false
  try {
    changed = Reflect.set(store, 'imageLimits', next)
  } catch {
    changed = false
  }
  if (!changed || store.imageLimits !== next) {
    try {
      logger?.warn?.(
        'vision-router: detected the legacy attachment-local 20MiB/100MP overlay but could not repair maxImageDimension; DSH may still enforce 2000px',
      )
    } catch {
      // Diagnostics must never break Host startup.
    }
    return { changed: false, reason: 'limits-readonly', limits }
  }

  try {
    logger?.info?.(
      'vision-router: repaired legacy attachment-local overlay — maxImageDimension %d -> %d',
      DSH_RC8_DEFAULT_IMAGE_DIMENSION,
      targetDimension,
    )
  } catch {
    // Diagnostics must never break Host startup.
  }
  return { changed: true, reason: 'legacy-overlay-repaired', limits: next }
}

/**
 * Keep the migration attached to the service lifecycle, not only initial boot.
 * DSH hot-reloads profile/home patch files transactionally; attachment-local can
 * therefore be reconstructed after Vision Router has already started. Cordis'
 * service injection reruns this narrow check for each replacement instance.
 */
export function installVisionAttachmentAdmissionPolicy(ctx, logger, options = {}) {
  const initial = ensureVisionAttachmentAdmissionPolicy(ctx, logger, options)
  try {
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['attachments'], (attachmentCtx) => {
        ensureVisionAttachmentAdmissionPolicy(attachmentCtx, logger, options)
      })
    }
  } catch {
    // Older/partial contexts may not expose lifecycle injection. The initial
    // repair above is still authoritative for the currently mounted store.
  }
  return initial
}

/**
 * Preserve host ownership of official DeepSeek routes on the batch-attachment
 * contract generation. Vision Router may wrap/delegate those routes, but must
 * not synthesize or replace them. Other adapters pass through unchanged.
 */
export function protectHostProviderOwnership(ctx) {
  if (!ctx || typeof ctx !== 'object' || !ctx.llm || typeof ctx.llm !== 'object') return ctx
  const llm = new Proxy(ctx.llm, {
    get(target, property) {
      if (property === 'registerAdapter') {
        return (routes, adapter) => {
          const list = Array.isArray(routes) ? routes : [routes]
          if (list.some((route) => HOST_OWNED_ROUTES.has(String(route)))) {
            const error = new Error(
              'vision-router: DSH owns deepseek-official on this host contract; use the auto-vision wrapper instead of provider takeover',
            )
            error.code = 'DSH_HOST_PROVIDER_OWNERSHIP'
            throw error
          }
          return target.registerAdapter(routes, adapter)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llm
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * The common rc.6+ SettingsProvider service is the stable public seam. This
 * helper mirrors installSettingsSection's attach/detach semantics without
 * forcing a newer package-resolution edge into the minimum-supported host.
 */
export function installSettingsSectionCompat(ctx, namespace, Config, entryConfig, hooks) {
  hooks.setSource(() => entryConfig)
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(namespace, Config, { base: entryConfig })
    hooks.setSource(() => scope.get())
    hooks.onChange()
    const disposeWatch = scope.watch(() => hooks.onChange())
    sctx.effect(
      () => () => {
        if (typeof disposeWatch === 'function') disposeWatch()
        hooks.setSource(() => entryConfig)
        hooks.onChange()
      },
      'vision-router: host settings compatibility source',
    )
  })
}

/**
 * Bridge the newer public settings-section semantics to core's legacy-shaped
 * `ctx.inject(['settings']) -> settings.register()` callback. The old `stealth`
 * flag is masked because host-owned official routes cannot be taken over on
 * this contract generation.
 */
export function installHostSettingsCompatibility(ctx, entryConfig, options = {}) {
  const install = options.installSettingsSection ?? installSettingsSectionCompat
  const ns = options.namespace
  const Config = options.Config
  if (Config === undefined) {
    throw new TypeError('vision-router: host settings compatibility requires Config')
  }

  let activeSource = () => ({ ...entryConfig, stealth: false })
  const watchers = new Set()

  install(ctx, ns, Config, entryConfig, {
    setSource(source) {
      activeSource = () => {
        const value = typeof source === 'function' ? source() : source
        if (!value || typeof value !== 'object') return { ...entryConfig, stealth: false }
        return { ...value, stealth: false }
      }
    },
    onChange() {
      const next = activeSource()
      for (const watcher of [...watchers]) {
        try {
          watcher(next, undefined)
        } catch {
          // Settings observer failures are isolated by the host as well.
        }
      }
    },
  })

  const scope = {
    get() {
      return activeSource()
    },
    watch(callback) {
      if (typeof callback !== 'function') return () => {}
      watchers.add(callback)
      return () => watchers.delete(callback)
    },
  }
  const settingsFacade = {
    register(namespace) {
      if (namespace !== 'vision-router') {
        throw new Error(`vision-router: unexpected settings namespace ${String(namespace)}`)
      }
      return scope
    },
  }

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'inject') {
        return (dependencies, callback) => {
          if (
            Array.isArray(dependencies) &&
            dependencies.length === 1 &&
            dependencies[0] === 'settings' &&
            typeof callback === 'function'
          ) {
            const settingsCtx = new Proxy(target, {
              get(inner, key) {
                if (key === 'settings') return settingsFacade
                const value = Reflect.get(inner, key, inner)
                return typeof value === 'function' ? value.bind(inner) : value
              },
            })
            callback(settingsCtx)
            return undefined
          }
          return target.inject(dependencies, callback)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * The minimum-supported host keeps the narrow Termux fallback. A
 * batch-capable attachment service keeps AttachmentId store-owned, so that
 * host context passes through untouched.
 */
export function attachmentContextForContract(ctx, logger, options = {}) {
  if (hasBatchAttachmentContract(ctx)) return ctx
  const install = options.installAndroidAttachmentCompat
  if (typeof install !== 'function') return ctx
  return install(ctx, logger, options.android)
}

// Transitional aliases for external/tests written against the rc.7-era names.
// New code must consume the capability-named exports above so future DSH
// releases do not accrete `if (rc8) / if (rc9)` branches.
export const isRc7ContractRuntime = hasBatchAttachmentContract
export const protectRc7ProviderOwnership = protectHostProviderOwnership
export const installRc7SettingsCompatibility = installHostSettingsCompatibility

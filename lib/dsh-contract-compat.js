import { inspectDshHostCapabilities } from './dsh-host-capabilities.js'

/**
 * Compatibility inventory
 * Reason: preserve Vision Router's released behavior across the supported DSH Host window.
 * Host gap: attachment ownership, settings-section and adapter-ownership seams differ across supported Hosts.
 * First needed for: rc.6 minimum support and the later batch-attachment/settings migration.
 * Feature detection: concrete attachment/settings/LLM methods only; never a DSH version string.
 * Removal condition: the minimum supported Host natively provides every seam used below and the legacy profile overlay is outside the support window.
 * Tests: rc6-rc7-compat, rc6-real-settings-persistence, attachment-admission-policy, DSH contract CI.
 */

const HOST_OWNED_ROUTES = new Set(['deepseek-official', 'deepseek-official-native'])

const LEGACY_VISION_ATTACHMENT_BYTES = 20 * 1024 * 1024
const LEGACY_VISION_ATTACHMENT_PIXELS = 100_000_000
const DSH_RC8_DEFAULT_IMAGE_DIMENSION = 2000
const DSH_ALPHA_DEFAULT_IMAGE_DIMENSION = 8192
const VISION_ROUTER_IMAGE_DIMENSION = 10_000
const DSH_ALPHA_DEFAULT_NORMALIZED_PIXELS = 2048 * 2048
const DSH_ALPHA_DEFAULT_NORMALIZED_DIMENSION = 8192
const DSH_ALPHA_DEFAULT_NORMALIZED_BYTES = 4 * 1024 * 1024
const VISION_ROUTER_NORMALIZED_PIXELS = LEGACY_VISION_ATTACHMENT_PIXELS
const VISION_ROUTER_NORMALIZED_DIMENSION = VISION_ROUTER_IMAGE_DIMENSION
const VISION_ROUTER_NORMALIZED_BYTES = LEGACY_VISION_ATTACHMENT_BYTES
const HOST_CAPABILITIES_PATH = '/_dsh/vision-router/host-capabilities'
const capabilityRouteInstalls = new WeakSet()

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

function sendCapabilityJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Expose the same side-effect-free Host capability snapshot Doctor consumes.
 * The endpoint is GET-only and contains no settings values, credentials,
 * provider ids or version-derived guesses. Failing to install it is advisory.
 */
export function installDshHostCapabilityDiagnostics(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return false
  if (capabilityRouteInstalls.has(ctx)) return true
  capabilityRouteInstalls.add(ctx)
  try {
    if (typeof ctx.inject !== 'function') return false
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.effect(
          () => webCtx.webServer.register({
            kind: 'exact',
            path: HOST_CAPABILITIES_PATH,
            handler: async (req, res) => {
              if (req.method !== 'GET') {
                res.setHeader('Allow', 'GET')
                sendCapabilityJson(res, 405, { ok: false, error: 'method not allowed' })
                return
              }
              let capabilities
              try {
                capabilities = inspectDshHostCapabilities(webCtx)
              } catch {
                capabilities = undefined
              }
              sendCapabilityJson(res, 200, {
                ok: true,
                capabilities: capabilities ?? {},
              })
            },
          }),
          'vision-router: host capability diagnostics route',
        )
      } catch {
        // Diagnostics must never veto webServer injection or plugin startup.
      }
    })
    return true
  } catch {
    return false
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

function exactAlphaNormalizationDefaults(policy) {
  return !!policy && typeof policy === 'object' &&
    policy.maxPixels === DSH_ALPHA_DEFAULT_NORMALIZED_PIXELS &&
    policy.maxDimension === DSH_ALPHA_DEFAULT_NORMALIZED_DIMENSION &&
    policy.maxBytes === DSH_ALPHA_DEFAULT_NORMALIZED_BYTES
}

function knownVisionRouterAdmissionShape(limits) {
  if (!limits || typeof limits !== 'object') return false
  if (
    limits.maxImageBytes !== LEGACY_VISION_ATTACHMENT_BYTES ||
    limits.maxImagePixels !== LEGACY_VISION_ATTACHMENT_PIXELS
  ) return false
  return limits.maxImageDimension === DSH_RC8_DEFAULT_IMAGE_DIMENSION ||
    limits.maxImageDimension === DSH_ALPHA_DEFAULT_IMAGE_DIMENSION
}

function replaceFrozenPolicy(store, property, next) {
  let changed = false
  try {
    changed = Reflect.set(store, property, next)
  } catch {
    changed = false
  }
  return changed && store[property] === next
}

/**
 * Repair historical Vision Router profile overlays across supported DSH Hosts.
 *
 * DSH patch rows replace the WHOLE config object instead of deep-merging it.
 * Old Vision Router profiles therefore retain a later `attachment-local` row
 * containing only the released 20MiB / 100MP admission pair. On rc.8 that
 * shadowed the later 10000px bundle value and rematerialized the Host's 2000px
 * default. On 0.1.2-alpha.1 the same stale row additionally omits the new
 * normalization fields, rematerializing 8192px admission plus the Host's
 * 4.2MP / 4MiB canonical-image defaults.
 *
 * This migration never edits a user's profile file and never creates another
 * attachment owner. LocalAttachmentStore exposes the resolved immutable
 * `imageLimits` and (alpha+) `normalizationPolicy` objects, and reads those
 * properties for every later validate/save. We replace only those policy
 * objects on one exact historical fingerprint:
 *
 * - admission bytes === 20MiB and pixels === 100MP; and
 * - dimension is rc.8's 2000px default or alpha's 8192px default; and
 * - normalization, when repaired, is EXACTLY alpha.1's 4.2MP/8192px/4MiB
 *   default tuple.
 *
 * Any custom admission dimension or any custom normalization tuple is left
 * untouched. This is capability/shape detection only; no DSH version string is
 * consulted.
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
  const targetNormalizedPixels = Number.isInteger(options.normalizedImageMaxPixels)
    ? Math.max(1, options.normalizedImageMaxPixels)
    : VISION_ROUTER_NORMALIZED_PIXELS
  const targetNormalizedDimension = Number.isInteger(options.normalizedImageMaxDimension)
    ? Math.max(1, options.normalizedImageMaxDimension)
    : VISION_ROUTER_NORMALIZED_DIMENSION
  const targetNormalizedBytes = Number.isInteger(options.normalizedImageMaxBytes)
    ? Math.max(1, options.normalizedImageMaxBytes)
    : VISION_ROUTER_NORMALIZED_BYTES

  if (!knownVisionRouterAdmissionShape(limits)) {
    return { changed: false, reason: 'not-legacy-overlay', limits }
  }

  const repairNormalization =
    limits.maxImageDimension === DSH_ALPHA_DEFAULT_IMAGE_DIMENSION &&
    exactAlphaNormalizationDefaults(store.normalizationPolicy)
  const repairDimension =
    limits.maxImageDimension === DSH_RC8_DEFAULT_IMAGE_DIMENSION ||
    repairNormalization

  if (!repairDimension && !repairNormalization) {
    return { changed: false, reason: 'not-legacy-overlay', limits }
  }

  if (repairDimension) {
    const nextLimits = Object.freeze({ ...limits, maxImageDimension: targetDimension })
    if (!replaceFrozenPolicy(store, 'imageLimits', nextLimits)) {
      try {
        logger?.warn?.(
          'vision-router: detected the legacy attachment-local admission overlay but could not repair maxImageDimension; DSH may still enforce the Host default',
        )
      } catch {
        // Diagnostics must never break Host startup.
      }
      return { changed: false, reason: 'limits-readonly', limits }
    }
  }

  if (repairNormalization) {
    const nextNormalization = Object.freeze({
      maxPixels: targetNormalizedPixels,
      maxDimension: targetNormalizedDimension,
      maxBytes: targetNormalizedBytes,
    })
    if (!replaceFrozenPolicy(store, 'normalizationPolicy', nextNormalization)) {
      // If admission was already repaired above, leave that safe improvement in
      // place but report the unresolved canonical-image blocker explicitly.
      try {
        logger?.warn?.(
          'vision-router: detected the legacy attachment-local alpha normalization defaults but could not repair normalizationPolicy; canonical images may still be downscaled',
        )
      } catch {
        // Diagnostics must never break Host startup.
      }
      return {
        changed: repairDimension,
        reason: 'normalization-policy-readonly',
        limits: store.imageLimits,
        normalizationPolicy: store.normalizationPolicy,
      }
    }
  }

  try {
    if (repairNormalization) {
      logger?.info?.(
        'vision-router: repaired legacy attachment-local policy — admission %dpx; canonical image %dpx/%dpx/%d bytes',
        store.imageLimits.maxImageDimension,
        store.normalizationPolicy.maxPixels,
        store.normalizationPolicy.maxDimension,
        store.normalizationPolicy.maxBytes,
      )
    } else {
      logger?.info?.(
        'vision-router: repaired legacy attachment-local overlay — maxImageDimension %d -> %d',
        DSH_RC8_DEFAULT_IMAGE_DIMENSION,
        targetDimension,
      )
    }
  } catch {
    // Diagnostics must never break Host startup.
  }

  return {
    changed: true,
    reason: repairNormalization ? 'legacy-alpha-policy-repaired' : 'legacy-overlay-repaired',
    limits: store.imageLimits,
    ...(repairNormalization ? { normalizationPolicy: store.normalizationPolicy } : {}),
  }
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
  installDshHostCapabilityDiagnostics(ctx)
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
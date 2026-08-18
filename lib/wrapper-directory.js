// DSH rc.7 split the live adapter registry from the Models settings directory.
// A wrapper registered only through llm.registerAdapter() is callable and shows
// up in llm.models, but Settings -> Models intentionally hides live routes that
// have no settings address. Vision Router's main `deepseek-vision` route is a
// derived view of the configured text provider, not an independently configured
// backend, so publish it in the directory as an alias of that source provider.

const DEFAULT_WRAPPER_ROUTE = 'deepseek-vision'
const DEFAULT_TEXT_PROVIDER = 'deepseek-official'

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function resolvedVisionRouterConfig(ctx, baseConfig) {
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    const live = settings && typeof settings.get === 'function' ? settings.get('vision-router') : undefined
    if (live && typeof live === 'object') return live
  } catch {
    // The settings service is optional during early composition startup.
  }
  return baseConfig && typeof baseConfig === 'object' ? baseConfig : {}
}

/**
 * Resolve the rc.7 Models-directory entry for the main auto-vision wrapper.
 * The wrapper deliberately reuses the source provider's settings namespace and
 * path: editing the derived row edits the provider it delegates text calls to.
 * Returns undefined until both the wrapper adapter and a configurable source
 * provider are visible, preserving older DSH behavior as a no-op fallback.
 */
export function resolveWrapperDirectoryEntry(ctx, baseConfig = {}) {
  const llm = ctx && ctx.llm
  if (
    !llm ||
    typeof llm.listProviders !== 'function' ||
    typeof llm.listConfigurableProviders !== 'function'
  ) {
    return undefined
  }

  const config = resolvedVisionRouterConfig(ctx, baseConfig)
  const wrapperRoute = nonEmptyString(config.wrapperRoute, DEFAULT_WRAPPER_ROUTE)
  const sourceProvider = nonEmptyString(config.textProvider && config.textProvider.provider, DEFAULT_TEXT_PROVIDER)

  let liveProviders
  let configurableProviders
  try {
    liveProviders = llm.listProviders()
    configurableProviders = llm.listConfigurableProviders()
  } catch {
    return undefined
  }
  if (!Array.isArray(liveProviders) || !Array.isArray(configurableProviders)) return undefined

  const wrapper = liveProviders.find((entry) => entry && entry.id === wrapperRoute)
  if (!wrapper) return undefined

  const source = configurableProviders.find((entry) => entry && entry.provider === sourceProvider)
  if (!source || typeof source.settingsNs !== 'string' || source.settingsNs === '') return undefined

  return {
    provider: wrapperRoute,
    displayName:
      typeof wrapper.name === 'string' && wrapper.name !== ''
        ? wrapper.name
        : 'DeepSeek + 自动识图',
    settingsNs: source.settingsNs,
    settingsPath: Array.isArray(source.settingsPath) ? [...source.settingsPath] : [],
  }
}

/**
 * Keep the wrapper's configurable-provider alias synchronized with live
 * settings/topology. registerConfigurableProviders() itself emits
 * llm/adapters-updated, so the small re-entrancy guard is required.
 */
export function installWrapperDirectoryAlias(ctx, baseConfig = {}, logger = ctx && ctx.logger) {
  const llm = ctx && ctx.llm
  if (
    !llm ||
    typeof llm.registerConfigurableProviders !== 'function' ||
    typeof llm.listConfigurableProviders !== 'function'
  ) {
    return () => undefined
  }

  let handle
  let ownedProvider
  let heldKey
  let syncing = false

  const sync = () => {
    if (syncing) return
    const next = resolveWrapperDirectoryEntry(ctx, baseConfig)
    const nextEntries = next ? [next] : []
    const nextKey = JSON.stringify(nextEntries)

    // A future Harness/plugin version may already own this exact directory
    // route. Never fight it; if we currently own an older alias, withdraw ours.
    if (next && next.provider !== ownedProvider) {
      let directory = []
      try {
        directory = llm.listConfigurableProviders()
      } catch {
        directory = []
      }
      if (Array.isArray(directory) && directory.some((entry) => entry && entry.provider === next.provider)) {
        if (handle && ownedProvider !== undefined) {
          syncing = true
          try {
            handle.replace([])
            ownedProvider = undefined
            heldKey = undefined
          } catch (error) {
            logger?.warn?.(
              'vision-router: failed to withdraw stale Models-directory alias: %s',
              error && error.message ? error.message : String(error),
            )
          } finally {
            syncing = false
          }
        }
        return
      }
    }

    if (handle && heldKey === nextKey) return
    if (!handle && !next) return

    syncing = true
    try {
      if (handle) {
        handle.replace(nextEntries)
      } else {
        handle = llm.registerConfigurableProviders(nextEntries)
      }
      ownedProvider = next ? next.provider : undefined
      heldKey = nextKey
    } catch (error) {
      // Directory publication affects Settings -> Models discoverability only;
      // never turn a healthy wrapper adapter into a plugin startup failure.
      logger?.warn?.(
        'vision-router: Models-directory alias sync failed: %s',
        error && error.message ? error.message : String(error),
      )
    } finally {
      syncing = false
    }
  }

  sync()
  if (typeof ctx.on === 'function') {
    ctx.on('llm/adapters-updated', sync)
    ctx.on('settings/updated', (ns) => {
      if (String(ns) === 'vision-router') sync()
    })
    ctx.on('settings/document-updated', (ns) => {
      if (String(ns) === 'vision-router') sync()
    })
  }

  return sync
}

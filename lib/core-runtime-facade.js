/**
 * Narrow runtime facade over the mature Core.
 *
 * The legacy Core still exports transport-capable provider helpers, but runtime
 * composition owns the concrete VisionProviderTransport. Bind that dependency
 * explicitly here instead of exposing it through a process-global registry.
 * Keep this facade deliberately small: it is an extraction seam, not a service
 * locator or a second Core API.
 */
export function createCoreRuntimeFacade(core, { providerTransport } = {}) {
  if (!core || typeof core !== 'object') throw new TypeError('core runtime facade requires core exports')

  const withTransport = (options) => ({
    ...(options && typeof options === 'object' ? options : {}),
    ...(providerTransport === undefined ? {} : { transport: providerTransport }),
  })

  const facade = Object.create(core)

  if (typeof core.callOpenAICompatible === 'function') {
    facade.callOpenAICompatible = (provider, messages, options = {}) =>
      core.callOpenAICompatible(provider, messages, withTransport(options))
  }
  if (typeof core.callLocalBackend === 'function') {
    facade.callLocalBackend = (provider, messages, options = {}) =>
      core.callLocalBackend(provider, messages, withTransport(options))
  }
  if (typeof core.apply === 'function') {
    facade.apply = (ctx, config = {}, runtime = {}) =>
      core.apply(ctx, config, {
        ...(runtime && typeof runtime === 'object' ? runtime : {}),
        ...(providerTransport === undefined ? {} : { providerTransport }),
      })
  }

  return Object.freeze(facade)
}

const UNKNOWN = 'unknown'

function serviceOf(ctx, name) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name)
      if (service !== undefined && service !== null) return service
    }
  } catch {
    // Capability diagnostics are advisory and must not break plugin startup.
  }
  try {
    const service = ctx[name]
    return service === undefined || service === null ? undefined : service
  } catch {
    return undefined
  }
}

function hasFunction(value, name) {
  try {
    return !!value && typeof value[name] === 'function'
  } catch {
    return false
  }
}

function known(value) {
  return value === true || value === false ? value : UNKNOWN
}

/**
 * Return a side-effect-free capability snapshot of the mounted DSH Host.
 *
 * The probe deliberately never registers adapters, tools, jobs, settings or
 * client surfaces just to learn whether a feature exists. If a capability
 * cannot be proven from a stable readable seam, it is reported as `unknown`
 * rather than inferred from a DSH version string.
 */
export function inspectDshHostCapabilities(ctx) {
  const attachments = serviceOf(ctx, 'attachments')
  const llm = serviceOf(ctx, 'llm')
  const jobs = serviceOf(ctx, 'jobs')
  const settings = serviceOf(ctx, 'settings')
  const tools = serviceOf(ctx, 'tools')
  const client = serviceOf(ctx, 'client')

  let maxImageDimension = false
  try {
    const value = attachments?.imageLimits?.maxImageDimension
    maxImageDimension = Number.isFinite(Number(value)) && Number(value) > 0
  } catch {
    maxImageDimension = false
  }

  const adapterRegistration = hasFunction(llm, 'registerAdapter')
  const configurableProviderRegistration = hasFunction(llm, 'registerConfigurableProviders')
  const prepareCall = hasFunction(llm, 'prepareCall')
  const toolRegistration = hasFunction(tools, 'register') || hasFunction(tools, 'registerTool')
  const toolExecution = hasFunction(tools, 'call') || hasFunction(tools, 'execute') || hasFunction(tools, 'invoke')

  return Object.freeze({
    batchAttachments: hasFunction(attachments, 'saveImages'),
    maxImageDimension,
    adapterRegistration,
    // A replace() method lives on the registration handle returned by the Host.
    // Proving it would require a real registration, so a read-only doctor must
    // not manufacture a route just for diagnostics.
    registrationReplace: adapterRegistration && configurableProviderRegistration ? UNKNOWN : false,
    jobs: jobs === undefined ? false : true,
    // DSH client-surface replacement has no universally readable service flag
    // across the supported window. Keep this honest until a safe seam exists.
    surfaceReplacement: client === undefined ? UNKNOWN : UNKNOWN,
    settingsLiveNamespace:
      hasFunction(settings, 'register') && (hasFunction(settings, 'get') || hasFunction(settings, 'scope')),
    // Browser exposure is a presentation capability and is not safely implied
    // by the Host settings service alone.
    settingsWebExposure: UNKNOWN,
    prepareCall,
    toolRegistration,
    toolExecution,
  })
}

export function normalizeDshHostCapabilities(value) {
  const source = value && typeof value === 'object' ? value : {}
  return Object.freeze({
    batchAttachments: known(source.batchAttachments),
    maxImageDimension: known(source.maxImageDimension),
    adapterRegistration: known(source.adapterRegistration),
    registrationReplace: known(source.registrationReplace),
    jobs: known(source.jobs),
    surfaceReplacement: known(source.surfaceReplacement),
    settingsLiveNamespace: known(source.settingsLiveNamespace),
    settingsWebExposure: known(source.settingsWebExposure),
    prepareCall: known(source.prepareCall),
    toolRegistration: known(source.toolRegistration),
    toolExecution: known(source.toolExecution),
  })
}

export function formatDshHostCapability(value) {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return UNKNOWN
}

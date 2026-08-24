/**
 * DSH 0.1.1-rc.1 lets a pi-ai route/model declare OpenAI-completions wire
 * compatibility such as `compat.maxTokensField`, and route-owned request
 * headers. Vision Router's legacy direct compatibility bridge predates that
 * surface: after an exact pre-wire image-capability refusal it sends one
 * non-streaming OpenAI-compatible request itself.
 *
 * Keep that legacy bridge transport-equivalent without reaching into DSH's
 * credential records or changing provider priority. The bridge has a useful
 * wire fingerprint (`stream:false`, image_url content, /chat/completions), so a
 * narrowly scoped fetch wrapper can recover the exact resolved pi-ai
 * route/model by URL + model id and apply only the missing wire facts.
 * Normal DSH/pi-ai traffic is streaming and therefore never matches.
 */

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value))
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function completionsUrl(baseURL) {
  const base = normalizedUrl(baseURL)
  return base === undefined ? undefined : `${base}/chat/completions`
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return normalizedUrl(input)
  if (typeof Request !== 'undefined' && input instanceof Request) return normalizedUrl(input.url)
  return undefined
}

function parseJsonBody(init) {
  if (!init || typeof init.body !== 'string') return undefined
  try {
    const parsed = JSON.parse(init.body)
    return isObject(parsed) && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function containsImageUrl(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    if (content.some((block) => block?.type === 'image_url' && typeof block?.image_url?.url === 'string')) {
      return true
    }
  }
  return false
}

function providerIds(ctx) {
  const ids = new Set()
  try {
    const listed = ctx?.llm?.listProviders?.()
    for (const entry of Array.isArray(listed) ? listed : []) {
      if (typeof entry?.id === 'string' && entry.id !== '') ids.add(entry.id)
    }
  } catch {
    // Registry enumeration is advisory; settings may still name the routes.
  }
  try {
    const settings = ctx?.get?.('settings')
    const section = settings?.get?.('llm-pi-ai')
    for (const id of Object.keys(section?.providers ?? {})) ids.add(id)
  } catch {
    // No settings service: registered routes above remain enough.
  }
  return [...ids]
}

function profilesMapOf(ctx, provider) {
  try {
    const registration = ctx?.llm?.registration?.(provider)
    const config = registration?.adapter?.config
    const profiles = typeof config?.profiles === 'function' ? config.profiles() : undefined
    return typeof profiles?.get === 'function' ? profiles : undefined
  } catch {
    return undefined
  }
}

function resolvedModelOf(profile, modelId) {
  try {
    const getModels = profile?.piProvider?.getModels
    const models = typeof getModels === 'function' ? getModels.call(profile.piProvider) : undefined
    return Array.isArray(models)
      ? models.find((entry) => entry && String(entry.id) === String(modelId))
      : undefined
  } catch {
    return undefined
  }
}

/**
 * pi-ai resolves an omitted maxTokensField from the route/model identity.
 * The bridge reads the materialized Model before pi-ai's private getCompat()
 * boundary, so model.compat contains only explicit overrides. Mirror the
 * installed openai-completions default for this one field instead of silently
 * falling back to the legacy bridge's max_tokens spelling.
 */
function resolvedMaxTokensField(model) {
  if (model?.compat?.maxTokensField === 'max_completion_tokens' || model?.compat?.maxTokensField === 'max_tokens') {
    return model.compat.maxTokensField
  }
  const provider = String(model?.provider ?? '')
  const baseUrl = String(model?.baseUrl ?? '')
  let hostname = ''
  try { hostname = new URL(baseUrl).hostname.toLowerCase() } catch {}
  const atHost = (expected) => hostname === expected || hostname.endsWith(`.${expected}`)
  const useMaxTokens =
    atHost('chutes.ai') ||
    provider === 'moonshotai' ||
    provider === 'moonshotai-cn' ||
    atHost('api.moonshot.ai') ||
    atHost('api.moonshot.cn') ||
    provider === 'cloudflare-ai-gateway' ||
    atHost('gateway.ai.cloudflare.com') ||
    provider === 'together' ||
    atHost('api.together.ai') ||
    atHost('api.together.xyz') ||
    provider === 'nvidia' ||
    atHost('integrate.api.nvidia.com') ||
    provider === 'ant-ling' ||
    atHost('api.ant-ling.com')
  return useMaxTokens ? 'max_tokens' : 'max_completion_tokens'
}

function compactHeaders(value) {
  if (!isObject(value) || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([name, headerValue]) => typeof name === 'string' && name !== '' && typeof headerValue === 'string',
    ),
  )
}

function factsEqual(a, b) {
  if (a.maxTokensField !== b.maxTokensField) return false
  const ah = Object.entries(a.headers).sort(([x], [y]) => x.localeCompare(y))
  const bh = Object.entries(b.headers).sort(([x], [y]) => x.localeCompare(y))
  return JSON.stringify(ah) === JSON.stringify(bh)
}

/**
 * Resolve the unique pi-ai route/model whose actual OpenAI-completions endpoint
 * matches this non-streaming image request. Ambiguous aliases fail closed.
 */
export function resolvePiAiBridgeWireFacts(ctx, url, modelId) {
  const wantedUrl = normalizedUrl(url)
  if (wantedUrl === undefined || typeof modelId !== 'string' || modelId === '') return undefined
  const matches = []
  const seenMaps = new Set()
  for (const provider of providerIds(ctx)) {
    const profiles = profilesMapOf(ctx, provider)
    if (profiles === undefined || seenMaps.has(profiles)) continue
    seenMaps.add(profiles)
    for (const [route, profile] of profiles.entries()) {
      const model = resolvedModelOf(profile, modelId)
      if (!model || model.api !== 'openai-completions') continue
      if (completionsUrl(model.baseUrl) !== wantedUrl) continue
      matches.push({
        provider: route,
        model: modelId,
        maxTokensField: resolvedMaxTokensField(model),
        headers: compactHeaders(profile?.headers),
      })
    }
  }
  if (matches.length === 0) return undefined
  // Two aliases to the same deployment are safe only when they resolve to the
  // exact same wire facts. Otherwise the request carries no route id, so
  // choosing one would silently apply another provider's contract.
  const first = matches[0]
  if (!matches.every((candidate) => factsEqual(first, candidate))) return undefined
  return first
}

function mergeHeaders(profileHeaders, requestHeaders) {
  if (Object.keys(profileHeaders ?? {}).length === 0) return requestHeaders
  if (typeof Headers !== 'undefined') {
    const merged = new Headers(profileHeaders)
    const existing = new Headers(requestHeaders ?? {})
    existing.forEach((value, name) => merged.set(name, value))
    return merged
  }
  // Node 22+ always exposes Headers, but keep a plain-object fallback for unit
  // tests and unusual embedders. Request-owned fields win case-sensitively here;
  // the real runtime follows the case-insensitive Headers path above.
  return { ...profileHeaders, ...(requestHeaders ?? {}) }
}

/** Pure request rewrite used by the installed fetch boundary and tests. */
export function applyPiAiBridgeWireFacts(init, body, facts) {
  if (!facts || !isObject(body)) return init
  let nextBody = body
  let changed = false
  const tokenValue = body.max_tokens ?? body.max_completion_tokens
  if (facts.maxTokensField === 'max_completion_tokens' && tokenValue !== undefined) {
    if (body.max_completion_tokens !== tokenValue || Object.hasOwn(body, 'max_tokens')) {
      nextBody = { ...body, max_completion_tokens: tokenValue }
      delete nextBody.max_tokens
      changed = true
    }
  } else if (facts.maxTokensField === 'max_tokens' && tokenValue !== undefined) {
    if (body.max_tokens !== tokenValue || Object.hasOwn(body, 'max_completion_tokens')) {
      nextBody = { ...body, max_tokens: tokenValue }
      delete nextBody.max_completion_tokens
      changed = true
    }
  }
  const hasProfileHeaders = Object.keys(facts.headers ?? {}).length > 0
  if (!changed && !hasProfileHeaders) return init
  return {
    ...init,
    ...(hasProfileHeaders ? { headers: mergeHeaders(facts.headers, init?.headers) } : {}),
    ...(changed ? { body: JSON.stringify(nextBody) } : {}),
  }
}

/**
 * Install one process fetch wrapper. It is inert for ordinary streaming DSH
 * calls and for Vision Router's unrelated HTTP providers. Cleanup disables the
 * wrapper even if another later patch sits above it in the fetch chain.
 */
export function installPiAiBridgeWireCompat(ctx, logger) {
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}
  let active = true
  const wrapped = async (input, init) => {
    if (!active) return Reflect.apply(original, globalThis, [input, init])
    try {
      const body = parseJsonBody(init)
      const url = requestUrl(input)
      const bridgeShape =
        body?.stream === false &&
        typeof body?.model === 'string' &&
        containsImageUrl(body?.messages) &&
        typeof url === 'string' &&
        /\/chat\/completions$/.test(new URL(url).pathname.replace(/\/$/, ''))
      if (bridgeShape) {
        const facts = resolvePiAiBridgeWireFacts(ctx, url, body.model)
        if (facts !== undefined) {
          const patched = applyPiAiBridgeWireFacts(init, body, facts)
          if (patched !== init) {
            try {
              logger?.info?.(
                'vision-router: applied pi-ai bridge wire compat [%s/%s] maxTokensField=%s headers=%d',
                facts.provider,
                facts.model,
                facts.maxTokensField ?? 'default',
                Object.keys(facts.headers).length,
              )
            } catch {
              // Diagnostics never affect the request.
            }
            return Reflect.apply(original, globalThis, [input, patched])
          }
        }
      }
    } catch {
      // Compatibility lookup is advisory. Any unexpected shape keeps the
      // exact pre-existing request rather than turning a bridge into a crash.
    }
    return Reflect.apply(original, globalThis, [input, init])
  }
  globalThis.fetch = wrapped
  const cleanup = () => {
    active = false
    if (globalThis.fetch === wrapped) globalThis.fetch = original
  }
  try {
    ctx?.effect?.(() => cleanup, 'vision-router: pi-ai bridge wire compatibility')
  } catch {
    // Direct callers without Cordis lifecycle still receive the cleanup below.
  }
  return cleanup
}

const MAX_SESSION_AFFINITY_ID_LENGTH = 512

/**
 * Preserve DSH's opaque conversation identity. OpenCode Go needs a stable
 * per-conversation value, not a plugin-generated UUID shape. We therefore do
 * only header-safety normalization and never rewrite the identifier itself.
 */
export function normalizeSessionAffinityId(value) {
  if (value === undefined || value === null) return undefined
  let text
  try {
    text = String(value).trim()
  } catch {
    return undefined
  }
  if (text === '' || text.length > MAX_SESSION_AFFINITY_ID_LENGTH) return undefined
  if (/[\u0000-\u001f\u007f]/.test(text)) return undefined
  return text
}

/** Read the live DSH session id across released/alpha session shapes. */
export function sessionAffinityIdOf(session) {
  if (!session) return undefined
  try {
    const direct = normalizeSessionAffinityId(session.id)
    if (direct !== undefined) return direct
  } catch {
    /* continue to persisted/header shapes */
  }
  try {
    const header = normalizeSessionAffinityId(session.header?.id)
    if (header !== undefined) return header
  } catch {
    /* continue to requestHeader() */
  }
  try {
    if (typeof session.requestHeader === 'function') {
      return normalizeSessionAffinityId(session.requestHeader()?.id)
    }
  } catch {
    /* no usable session identity */
  }
  return undefined
}

/**
 * Direct transports bypass DSH's adapter wire logic, so only they add the Go
 * header themselves. Provider adapters receive `sessionId` and remain free to
 * use DSH's native session carrier.
 */
export function isOpenCodeGoProvider(provider) {
  // Keep affinity credentials endpoint-scoped. A user may name an arbitrary
  // custom HTTP row "opencode-go"; provider naming alone must never leak the
  // DSH conversation id to that endpoint.
  try {
    const url = new URL(String(provider?.baseURL ?? provider?.baseUrl ?? ''))
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'opencode.ai' &&
      /^\/zen\/go(?:\/|$)/i.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function directSessionAffinityHeaders(provider, sessionId) {
  if (!isOpenCodeGoProvider(provider)) return {}
  const normalized = normalizeSessionAffinityId(sessionId)
  if (normalized === undefined) {
    const error = new Error(
      'OpenCode Go requires a stable session identity; refusing a direct request without one',
    )
    error.code = 'OPENCODE_SESSION_REQUIRED'
    throw error
  }
  return { 'x-opencode-session': normalized }
}

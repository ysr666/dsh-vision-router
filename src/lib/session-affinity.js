const MAX_SESSION_AFFINITY_ID_LENGTH = 512

/** Preserve DSH's in-process session identity exactly; no wire rules belong here. */
export function rawSessionIdentity(value) {
  if (value === undefined || value === null) return undefined
  try {
    return String(value)
  } catch {
    return undefined
  }
}

/** Read the live DSH session id across released/alpha session shapes without rewriting it. */
export function sessionIdentityOf(session) {
  if (!session) return undefined
  try {
    const direct = rawSessionIdentity(session.id)
    if (direct !== undefined) return direct
  } catch {
    /* continue to persisted/header shapes */
  }
  try {
    const header = rawSessionIdentity(session.header?.id)
    if (header !== undefined) return header
  } catch {
    /* continue to requestHeader() */
  }
  try {
    if (typeof session.requestHeader === 'function') {
      return rawSessionIdentity(session.requestHeader()?.id)
    }
  } catch {
    /* no usable session identity */
  }
  return undefined
}

/**
 * Admit an opaque identity to an HTTP header without changing it. Fetch/undici
 * requires ByteString-compatible header values; use visible ASCII so behavior
 * is identical across Node 22/24 and HTTP implementations. Leading/trailing
 * whitespace is rejected because Headers would normalize it, violating the
 * requirement to preserve the DSH identity unchanged.
 */
export function wireSessionAffinityId(value) {
  const text = rawSessionIdentity(value)
  if (text === undefined || text === '' || text.length > MAX_SESSION_AFFINITY_ID_LENGTH) return undefined
  if (text.trim() !== text) return undefined
  if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(text)) return undefined
  return text
}

export function isOfficialOpenCodeGoUrl(value) {
  try {
    const url = new URL(String(value))
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'opencode.ai' &&
      /^\/zen\/go(?:\/|$)/i.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function isOpenCodeGoProvider(provider) {
  return isOfficialOpenCodeGoUrl(provider?.baseURL ?? provider?.baseUrl ?? '')
}

function invalidAffinityError(sessionId) {
  const raw = rawSessionIdentity(sessionId)
  const error = new Error(
    raw === undefined || raw === ''
      ? 'OpenCode Go requires a stable session identity; refusing a direct request without one'
      : 'OpenCode Go session identity is not safe for an HTTP header; refusing to rewrite or truncate it',
  )
  error.code = raw === undefined || raw === '' ? 'OPENCODE_SESSION_REQUIRED' : 'OPENCODE_SESSION_INVALID'
  return error
}

export function directSessionAffinityHeaders(provider, sessionId) {
  if (!isOpenCodeGoProvider(provider)) return {}
  const wire = wireSessionAffinityId(sessionId)
  if (wire === undefined) throw invalidAffinityError(sessionId)
  return { 'x-opencode-session': wire }
}

export function openCodeSessionAffinityHeaderForUrl(url, sessionId) {
  if (!isOfficialOpenCodeGoUrl(url)) return undefined
  const wire = wireSessionAffinityId(sessionId)
  if (wire === undefined) throw invalidAffinityError(sessionId)
  return wire
}

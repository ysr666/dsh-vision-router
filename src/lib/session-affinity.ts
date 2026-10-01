const MAX_SESSION_AFFINITY_ID_LENGTH = 512

type UnknownRecord = Record<PropertyKey, unknown>

export type SessionAffinityErrorCode =
  | 'OPENCODE_SESSION_REQUIRED'
  | 'OPENCODE_SESSION_INVALID'

export type SessionAffinityError = Error & {
  readonly code: SessionAffinityErrorCode
}

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as UnknownRecord
    : undefined
}

function wireAsciiIdentity(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const edge = index === 0 || index === text.length - 1
    if (edge) {
      if (code < 33 || code > 126) return false
    } else if (code < 32 || code > 126) {
      return false
    }
  }
  return true
}

export function rawSessionIdentity(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  try {
    return String(value)
  } catch {
    return undefined
  }
}

export function sessionIdentityOf(session: unknown): string | undefined {
  const source = propertyBag(session)
  if (source === undefined) return undefined

  try {
    const direct = rawSessionIdentity(source.id)
    if (direct !== undefined) return direct
  } catch {}

  try {
    const header = rawSessionIdentity(propertyBag(source.header)?.id)
    if (header !== undefined) return header
  } catch {}

  try {
    const requestHeader = source.requestHeader
    if (typeof requestHeader === 'function') {
      return rawSessionIdentity(propertyBag(requestHeader.call(session))?.id)
    }
  } catch {}

  return undefined
}

export function wireSessionAffinityId(value: unknown): string | undefined {
  const text = rawSessionIdentity(value)
  if (
    text === undefined
    || text === ''
    || text.length > MAX_SESSION_AFFINITY_ID_LENGTH
  ) {
    return undefined
  }
  if (text.trim() !== text) return undefined
  return wireAsciiIdentity(text) ? text : undefined
}

export function isOfficialOpenCodeGoUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value))
    return (
      url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'opencode.ai'
      && /^\/zen\/go(?:\/|$)/i.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function isOpenCodeGoProvider(provider: unknown): boolean {
  const source = propertyBag(provider)
  return isOfficialOpenCodeGoUrl(source?.baseURL ?? source?.baseUrl ?? '')
}

function invalidAffinityError(sessionId: unknown): SessionAffinityError {
  const raw = rawSessionIdentity(sessionId)
  const code: SessionAffinityErrorCode =
    raw === undefined || raw === ''
      ? 'OPENCODE_SESSION_REQUIRED'
      : 'OPENCODE_SESSION_INVALID'
  return Object.assign(
    new Error(
      code === 'OPENCODE_SESSION_REQUIRED'
        ? 'OpenCode Go requires a stable session identity; refusing a direct request without one'
        : 'OpenCode Go session identity is not safe for an HTTP header; refusing to rewrite or truncate it',
    ),
    { code },
  )
}

export function directSessionAffinityHeaders(
  provider: unknown,
  sessionId: unknown,
): Record<string, string> {
  if (!isOpenCodeGoProvider(provider)) return {}
  const wire = wireSessionAffinityId(sessionId)
  if (wire === undefined) throw invalidAffinityError(sessionId)
  return { 'x-opencode-session': wire }
}

export function openCodeSessionAffinityHeaderForUrl(
  url: unknown,
  sessionId: unknown,
): string | undefined {
  if (!isOfficialOpenCodeGoUrl(url)) return undefined
  const wire = wireSessionAffinityId(sessionId)
  if (wire === undefined) throw invalidAffinityError(sessionId)
  return wire
}

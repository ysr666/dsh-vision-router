const SENSITIVE_QUERY = /^(?:api[_-]?key|key|token|secret|password|authorization|auth|signature|sig)$/i

function redactUrl(match) {
  try {
    const url = new URL(match)
    url.username = url.username ? '[redacted]' : ''
    url.password = url.password ? '[redacted]' : ''
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, '[redacted]')
    }
    return url.toString()
  } catch {
    return match
  }
}

export function redactDiagnosticText(value, max = 400) {
  const limit = Math.max(32, Math.min(4000, Math.floor(Number(max) || 400)))
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
  text = text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, redactUrl)
  text = text.replace(/\b(Authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, '$1[redacted]')
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[redacted]')
  text = text.replace(/\b(sk-(?:proj-)?)[A-Za-z0-9_-]{8,}/gi, '$1[redacted]')
  text = text.replace(/\b(api[_-]?key|token|secret|password|authorization|signature)\s*[:=]\s*([^\s,;&]+)/gi, '$1=[redacted]')
  return text.slice(0, limit)
}

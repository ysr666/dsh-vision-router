const SENSITIVE_QUERY = /^(?:api[_-]?key|key|token|secret|password|authorization|auth|signature|sig)$/i

/**
 * Credential shapes worth removing from anything that reaches a log, a support
 * report or a model-visible diagnostic.
 *
 * Two callers used to keep their own partial copy of this list, so each one
 * leaked what the other covered (`Authorization: token ghp_…`, `Cookie:`, bare
 * platform tokens, `#token=` fragments). One shared list is the fix: callers may
 * still add their own extra passes, but never their own subset of this one.
 */
// One spelling for every caller: the log path's own test pins the uppercase
// marker (`/\[REDACTED/`), the diagnostic path's test is case-insensitive, so
// uppercase is the only spelling that keeps both existing contracts intact.
const REDACTED = '[REDACTED]'
const CREDENTIAL_SHAPE_PATTERNS = [
  // Any Authorization scheme, not only Bearer/Basic (`token`, `ApiKey`, `AWS4-…`),
  // but only the credential itself: a single line may carry safe diagnostics
  // after the header and a support report must keep them. `;` stays inside the value
  // (the log sink has always consumed it) while `,` separates what follows.
  [/\b(Authorization\s*[:=]\s*)(?:[A-Za-z][A-Za-z0-9._-]*\s+)?[^\s,]+/gi, `$1${REDACTED}`],
  [/\b(Proxy-Authorization\s*[:=]\s*)(?:[A-Za-z][A-Za-z0-9._-]*\s+)?[^\s,]+/gi, `$1${REDACTED}`],
  // A real Cookie/Set-Cookie header owns the remainder of its line, so redact the
  // whole value there. The same words also appear inside arbitrary diagnostics,
  // URL query fragments and object dumps; those contexts must keep unrelated text.
  [/^(\s*(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gim, `$1${REDACTED}`],
  // Inline colon form: redact one scalar or a semicolon-separated cookie-pair run,
  // then stop at an unrelated comma/word so support diagnostics remain readable.
  [/\b((?:Set-)?Cookie\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^;\s,&"']+(?:\s*;\s*[^=;\s,&"']+\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^;\s,&"']+))*)/gi, `$1${REDACTED}`],
  // Assignment/query form: bound the value at ordinary diagnostic separators.
  [/\b((?:Set-)?Cookie\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,&"']+)/gi, `$1${REDACTED}`],
  // URL userinfo (`scheme://user:secret@host`) without needing a URL parser, so
  // the log path — which never parsed URLs — covers it too.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, `$1${REDACTED}`],
  // Vendor-prefixed keys: OpenAI/Anthropic, GitHub, AWS, Slack, Google, PEM.
  [/\b(sk-(?:proj-|ant-|or-)?)[A-Za-z0-9_-]{8,}/gi, `$1${REDACTED}`],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/gi, `$1${REDACTED}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, `${REDACTED}`],
  [/\b(xox[baprs]-)[A-Za-z0-9-]{8,}/gi, `$1${REDACTED}`],
  [/\b(AIza)[A-Za-z0-9_-]{16,}/g, `$1${REDACTED}`],
  // Signed JSON Web Tokens, with or without a leading scheme word.
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // An unterminated block (a bounded upstream read truncates before the END marker) must
  // redact to the end of the text: without the `$` alternative its whole body passes through.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // `api_key=…`-style assignments, including `apikey` and `access_token`. `;` stays inside the
  // value for the same reason as above; `&` separates an unrelated parameter a report must keep.
  [/\b(access[_-]?token|api[_-]?key|apikey|token|secret|password|passwd|signature|sig)\s*[:=]\s*([^\s,&"']+)/gi, `$1=${REDACTED}`],
]

/** Apply only the shared credential-shape passes (no URL parsing, no truncation). */
export function redactCredentialShapes(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of CREDENTIAL_SHAPE_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

function redactUrl(match) {
  try {
    const url = new URL(match)
    url.username = url.username ? REDACTED : ''
    url.password = url.password ? REDACTED : ''
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, REDACTED)
    }
    return redactCredentialShapes(url.toString())
  } catch {
    return redactCredentialShapes(match)
  }
}

export function redactDiagnosticText(value, max = 400) {
  const limit = Math.max(32, Math.min(4000, Math.floor(Number(max) || 400)))
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
  return redactCredentialShapes(
    text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, redactUrl),
  ).slice(0, limit)
}

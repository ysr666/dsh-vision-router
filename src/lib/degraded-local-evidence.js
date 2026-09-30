/** Bounded policy for stopping Host tools from re-parsing images after vision degradation. */

function flattenStrings(value, out = [], depth = 0) {
  if (out.length >= 64 || depth > 6 || value == null) return out
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) flattenStrings(item, out, depth + 1)
  }
  return out
}

function normalizedEvidenceTokens(tokens) {
  const out = []
  for (const token of tokens) {
    if (typeof token !== 'string' || token === '') continue
    out.push(token)
    if (token.startsWith('sha256:')) {
      const digest = token.slice('sha256:'.length)
      out.push(digest)
      if (digest.length >= 16) out.push(digest.slice(0, 16))
    }
  }
  return out
}

export function shouldBlockDegradedHostTool(name, args, evidenceTokens = []) {
  if (name !== 'bash' && name !== 'read_image') return false
  const tokens = normalizedEvidenceTokens(evidenceTokens)
  if (tokens.length === 0) return false
  const strings = flattenStrings(args)
  return strings.some((text) => {
    if (text.includes('.dsh/attachments') || text.includes('/attachments/v1/objects/')) return true
    return tokens.some(token => text.includes(token))
  })
}

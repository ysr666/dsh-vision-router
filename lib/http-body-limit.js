const DEFAULT_FALLBACK_MAX_BYTES = 4 * 1024 * 1024

export const MODEL_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
export const METADATA_RESPONSE_MAX_BYTES = 512 * 1024
export const ERROR_RESPONSE_MAX_BYTES = 64 * 1024

function normalizedLimit(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : DEFAULT_FALLBACK_MAX_BYTES
}

function responseTooLarge(label, limit, observed) {
  const suffix = Number.isFinite(observed) ? ` (observed ${observed} bytes)` : ''
  const error = new Error(`${label} exceeds the ${limit}-byte response limit${suffix}`)
  error.code = 'HTTP_RESPONSE_TOO_LARGE'
  error.maxBytes = limit
  if (Number.isFinite(observed)) error.observedBytes = observed
  return error
}

function declaredLength(response) {
  const raw = response?.headers?.get?.('content-length')
  if (raw === null || raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Consume one HTTP response body with a hard byte ceiling enforced while the
 * stream is read. Content-Length is only a preflight: fetch may transparently
 * decompress a response, so the decoded body stream is independently counted.
 */
export async function readResponseBytesBounded(response, maxBytes, options = {}) {
  const limit = normalizedLimit(maxBytes)
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'HTTP response'
  const declared = declaredLength(response)
  if (declared !== undefined && declared > limit) throw responseTooLarge(label, limit, declared)

  const body = response?.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? [])
        if (total + bytes.byteLength > limit) {
          try { await reader.cancel('response body limit exceeded') } catch { /* best effort */ }
          throw responseTooLarge(label, limit, total + bytes.byteLength)
        }
        total += bytes.byteLength
        chunks.push(Buffer.from(bytes))
      }
      return Buffer.concat(chunks, total)
    } finally {
      try { reader.releaseLock() } catch { /* best effort */ }
    }
  }

  // Synthetic test doubles may expose text()/arrayBuffer() without a WHATWG
  // body stream. Real Node fetch responses take the streaming path above, so
  // this compatibility fallback is not the production admission boundary.
  if (typeof response?.arrayBuffer === 'function') {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) throw responseTooLarge(label, limit, bytes.length)
    return bytes
  }
  if (typeof response?.text === 'function') {
    const text = await response.text()
    const bytes = Buffer.from(String(text ?? ''), 'utf8')
    if (bytes.length > limit) throw responseTooLarge(label, limit, bytes.length)
    return bytes
  }
  throw new Error(`${label} has no readable response body`)
}

export async function readResponseTextBounded(response, maxBytes, options = {}) {
  return (await readResponseBytesBounded(response, maxBytes, options)).toString('utf8')
}

export async function readResponseJsonBounded(response, maxBytes, options = {}) {
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'HTTP response'
  const text = await readResponseTextBounded(response, maxBytes, options)
  try {
    return JSON.parse(text)
  } catch (cause) {
    const error = new Error(`${label} returned invalid JSON`)
    error.code = 'HTTP_RESPONSE_INVALID_JSON'
    error.cause = cause
    throw error
  }
}

const DEFAULT_FALLBACK_MAX_BYTES = 4 * 1024 * 1024

export const MODEL_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
export const METADATA_RESPONSE_MAX_BYTES = 512 * 1024
export const ERROR_RESPONSE_MAX_BYTES = 64 * 1024
export const DOCTOR_RESPONSE_MAX_BYTES = 16 * 1024

export interface BoundedResponseReadOptions {
  readonly label?: string
}

interface HeadersLike {
  get?(name: string): unknown
}

interface ReaderLike {
  read(): Promise<{ readonly done?: boolean; readonly value?: unknown }>
  cancel?(reason?: unknown): unknown
  releaseLock?(): void
}

interface BodyLike {
  cancel?(reason?: unknown): unknown
  getReader?(): ReaderLike
}

interface ResponseLike {
  readonly headers?: HeadersLike
  readonly body?: BodyLike | null
  arrayBuffer?(): Promise<ArrayBufferLike>
  text?(): Promise<unknown>
}

interface HttpResponseLimitError extends Error {
  code: string
  maxBytes?: number
  observedBytes?: number
  cause?: unknown
}

function responseLike(value: unknown): ResponseLike {
  return value !== null && typeof value === 'object'
    ? value as ResponseLike
    : {}
}

function normalizedLimit(value: unknown): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : DEFAULT_FALLBACK_MAX_BYTES
}

function responseTooLarge(label: string, limit: number, observed: unknown): HttpResponseLimitError {
  const suffix = Number.isFinite(observed) ? ` (observed ${observed} bytes)` : ''
  const error = new Error(`${label} exceeds the ${limit}-byte response limit${suffix}`) as HttpResponseLimitError
  error.code = 'HTTP_RESPONSE_TOO_LARGE'
  error.maxBytes = limit
  if (typeof observed === 'number' && Number.isFinite(observed)) error.observedBytes = observed
  return error
}

function declaredLength(response: unknown): number | undefined {
  const raw = responseLike(response).headers?.get?.('content-length')
  if (raw === null || raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function chunkBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  return new Uint8Array((value ?? []) as ArrayBufferLike)
}

/**
 * Consume one HTTP response body with a hard byte ceiling enforced while the
 * stream is read. Content-Length is only a preflight: fetch may transparently
 * decompress a response, so the decoded body stream is independently counted.
 */
export async function readResponseBytesBounded(
  response: unknown,
  maxBytes: unknown,
  options: BoundedResponseReadOptions = {},
): Promise<Buffer> {
  const limit = normalizedLimit(maxBytes)
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'HTTP response'
  const declared = declaredLength(response)
  const readable = responseLike(response)
  if (declared !== undefined && declared > limit) {
    try { await readable.body?.cancel?.('response body limit exceeded') } catch { /* best effort */ }
    throw responseTooLarge(label, limit, declared)
  }

  const body = readable.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const bytes = chunkBytes(value)
        if (total + bytes.byteLength > limit) {
          try { await reader.cancel?.('response body limit exceeded') } catch { /* best effort */ }
          throw responseTooLarge(label, limit, total + bytes.byteLength)
        }
        total += bytes.byteLength
        chunks.push(Buffer.from(bytes))
      }
      return Buffer.concat(chunks, total)
    } finally {
      try { reader.releaseLock?.() } catch { /* best effort */ }
    }
  }

  // Synthetic test doubles may expose text()/arrayBuffer() without a WHATWG
  // body stream. Real Node fetch responses take the streaming path above, so
  // this compatibility fallback is not the production admission boundary.
  if (typeof readable.arrayBuffer === 'function') {
    const bytes = Buffer.from(await readable.arrayBuffer())
    if (bytes.length > limit) throw responseTooLarge(label, limit, bytes.length)
    return bytes
  }
  if (typeof readable.text === 'function') {
    const text = await readable.text()
    const bytes = Buffer.from(String(text ?? ''), 'utf8')
    if (bytes.length > limit) throw responseTooLarge(label, limit, bytes.length)
    return bytes
  }
  throw new Error(`${label} has no readable response body`)
}

export async function readResponseTextBounded(
  response: unknown,
  maxBytes: unknown,
  options: BoundedResponseReadOptions = {},
): Promise<string> {
  return (await readResponseBytesBounded(response, maxBytes, options)).toString('utf8')
}

export async function readResponseJsonBounded(
  response: unknown,
  maxBytes: unknown,
  options: BoundedResponseReadOptions = {},
): Promise<unknown> {
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'HTTP response'
  const text = await readResponseTextBounded(response, maxBytes, options)
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    const error = new Error(`${label} returned invalid JSON`) as HttpResponseLimitError
    error.code = 'HTTP_RESPONSE_INVALID_JSON'
    error.cause = cause
    throw error
  }
}

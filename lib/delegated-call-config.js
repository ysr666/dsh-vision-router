const ROUTE_OWNED_CALL_FIELDS = Object.freeze([
  'reasoningEffort',
  'temperature',
  'maxTokens',
  'stop',
])

/**
 * Project an internal Vision Router delegation onto a different provider/model.
 *
 * The delegated route owns its own call defaults and compatibility. Carry the
 * request payload and lifecycle through, but never leak source-route sampling,
 * reasoning or output-limit state into the target adapter. DSH will materialize
 * the target adapter's configured defaults when these fields are absent.
 *
 * Direct transports owned by Vision Router do not use this projection; their
 * wire compatibility remains the Router's responsibility.
 */
export function projectDelegatedCallConfig(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options
  if (!ROUTE_OWNED_CALL_FIELDS.some((field) => Object.hasOwn(options, field))) return options
  const next = { ...options }
  for (const field of ROUTE_OWNED_CALL_FIELDS) delete next[field]
  return next
}

export const delegatedRouteOwnedCallFields = ROUTE_OWNED_CALL_FIELDS

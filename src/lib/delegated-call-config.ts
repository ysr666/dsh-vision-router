import type { GenerateOptions } from '@deepseek-ai/dsh-llm/types'

const ROUTE_OWNED_CALL_FIELDS = Object.freeze([
  'reasoningEffort',
  'temperature',
  'maxTokens',
  'stop',
] as const satisfies readonly (keyof GenerateOptions)[])

export type DelegatedRouteOwnedCallField = (typeof ROUTE_OWNED_CALL_FIELDS)[number]

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
export function projectDelegatedCallConfig<T extends object>(
  options: T,
): Omit<T, DelegatedRouteOwnedCallField>
export function projectDelegatedCallConfig<T>(options: T): T
export function projectDelegatedCallConfig(options: unknown): unknown {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options
  const record = options as Record<string, unknown>
  if (!ROUTE_OWNED_CALL_FIELDS.some((field) => Object.hasOwn(record, field))) return options
  const next = { ...record }
  for (const field of ROUTE_OWNED_CALL_FIELDS) delete next[field]
  return next
}

export const delegatedRouteOwnedCallFields = ROUTE_OWNED_CALL_FIELDS

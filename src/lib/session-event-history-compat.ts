type UnknownRecord = Record<PropertyKey, unknown>

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as UnknownRecord
    : undefined
}

/**
 * Read the released Session-local event snapshot used only when the Host does
 * not advertise the asynchronous SessionQuery capability.
 *
 * Durable-data compatibility is intentionally separate from the current Host
 * floor: this helper feature-detects historical Session shapes at runtime and
 * never claims that either shape exists through a static Host type.
 */
export function legacySessionEvents(session: unknown): readonly unknown[] | undefined {
  const source = propertyBag(session)
  if (source === undefined) return undefined

  try {
    const snapshotEvents = source.snapshotEvents
    if (typeof snapshotEvents === 'function') {
      const events = snapshotEvents.call(session)
      return Array.isArray(events) ? events : undefined
    }
    const events = source.events
    return Array.isArray(events) ? events : undefined
  } catch {
    return undefined
  }
}

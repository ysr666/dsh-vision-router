/**
 * Project the persisted proxy setting into the syntax accepted by Undici.
 *
 * Older Vision Router settings copy explicitly recommended `socks5h://`.
 * Keep that persisted user intent untouched and translate only at the runtime
 * dispatcher boundary. Deliberately do not validate or reinterpret any other
 * proxy scheme here: Undici remains the execution authority.
 */
export function effectiveProxyUrlForUndici(value) {
  if (typeof value !== 'string') return value
  return value.replace(/^(\s*)socks5h:/i, '$1socks5:')
}

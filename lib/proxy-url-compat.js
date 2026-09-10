// Compatibility for proxy URLs that Vision Router historically advertised.
//
// Undici 7.x accepts SOCKS5 proxy URLs as `socks5:` / `socks:`. Older Vision
// Router Settings copy recommended `socks5h:` instead. Keep that persisted
// spelling valid without turning this layer into a second proxy-protocol
// authority: only rewrite that one historical scheme and leave every other
// value byte-for-byte unchanged for Undici to interpret as before.

const SOCKS5H_SCHEME = /^socks5h:/i

export function needsSocks5hProxyCompat(value) {
  return typeof value === 'string' && SOCKS5H_SCHEME.test(value)
}

export function normalizeProxyUrlForUndici(value) {
  if (!needsSocks5hProxyCompat(value)) return value
  return value.replace(SOCKS5H_SCHEME, 'socks5:')
}

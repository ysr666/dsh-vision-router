import {
  canonicalProxyHost,
  createPerHopProxyDispatcher,
  proxyDispatcherLike,
  proxyHostMatchesAny,
} from '../../../src/lib/proxy-routing.js'
import { effectiveProxyUrlForUndici } from '../../../src/lib/proxy-url-compat.js'

const projected: string = effectiveProxyUrlForUndici('socks5h://127.0.0.1:1080')
const unchanged: number = effectiveProxyUrlForUndici(42)
void projected
void unchanged

const dispatcher = {
  dispatch(_options: unknown, _handler: unknown) {
    return 'ok'
  },
}

if (proxyDispatcherLike(dispatcher)) {
  const perHop = createPerHopProxyDispatcher(dispatcher, dispatcher, ['example.com'])
  const result: unknown = perHop.dispatch({ origin: 'https://example.com' }, {})
  void result
}

const canonical: string = canonicalProxyHost('EXAMPLE.com.')
const matches: boolean = proxyHostMatchesAny('api.example.com', ['example.com'])
void canonical
void matches

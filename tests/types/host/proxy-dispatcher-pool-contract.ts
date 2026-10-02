import {
  createProxyDispatcherPool,
  type ProxyDispatcherLease,
} from '../../../src/lib/proxy-dispatcher-pool.js'

const pool = createProxyDispatcherPool({
  importUndici: async () => ({
    ProxyAgent: class {
      dispatch(_options: unknown, _handler: unknown) {
        return true
      }
      async close() {}
    },
    getGlobalDispatcher: () => ({
      dispatch(_options: unknown, _handler: unknown) {
        return true
      },
    }),
  }),
})

const pending: Promise<ProxyDispatcherLease> = pool.acquire('http://127.0.0.1:7890')
const disposed: Promise<void> = pool.dispose()
void pending
void disposed

pool.reconcile(undefined)

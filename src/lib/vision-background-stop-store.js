import path from 'node:path'
import { resolveDshHome } from './doctor.js'
import { createBackgroundBenchmarkStopStoreCore } from './vision-background-stop-store-core.js'

export function backgroundBenchmarkStopCachePath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cache', 'vision-router', 'background-benchmark-stops.json')
}

/**
 * Keep DSH-home discovery at the dynamic Host/path boundary. The typed core
 * owns durable stop validation, migration, retention and persistence.
 */
export function createBackgroundBenchmarkStopStore(options = {}) {
  const file = options.cacheFile ?? backgroundBenchmarkStopCachePath(options.dshHome)
  return createBackgroundBenchmarkStopStoreCore({
    ...options,
    file,
  })
}

import { installCapabilityBenchmarkLifecycleClient } from '../vision-capability-benchmark-client-lifecycle.js'

export function installVisionBenchmarkPanel(ctx) {
  installCapabilityBenchmarkLifecycleClient(ctx)
  return ctx
}

import { installCapabilityBenchmarkClient } from '../vision-capability-benchmark-client.js'

export function installVisionBenchmarkPanel(ctx) {
  installCapabilityBenchmarkClient(ctx)
  return ctx
}

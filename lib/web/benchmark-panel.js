import { installSwitchedCapabilityBenchmarkClient } from './benchmark-client-switch.js'

export function installVisionBenchmarkPanel(ctx) {
  installSwitchedCapabilityBenchmarkClient(ctx)
  return ctx
}

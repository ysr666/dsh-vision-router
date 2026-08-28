import { installVisionSettingsController } from './settings-controller.js'
import { installVisionRemoteSettingsClient } from './remote-settings-client.js'
import {
  installVisionModelPickerControls,
  installVisionModelPickerPresentation,
} from './model-picker.js'
import { installVisionOnboarding } from './onboarding.js'
import { installVisionRoutingSection } from './routing-section.js'
import { installVisionBenchmarkPanel } from './benchmark-panel.js'
import { installVisionDiagnosticsPanel } from './diagnostics-panel.js'

/** Preserve the pre-Host-settings wrapper order from the legacy entry. */
export function installVisionSettingsWebBoundary(ctx, logger) {
  installVisionSettingsController(ctx)
  installVisionRemoteSettingsClient(ctx, logger)
  return ctx
}

/**
 * P3-C web composition boundary.
 *
 * These installers intentionally keep the mature client implementations and
 * their historical order. The architectural change is responsibility
 * ownership: entry/runtime code calls one Web boundary, while Host-owned
 * product decisions are exposed through the diagnostics/product-state module.
 */
export function installVisionWebIntegration(ctx, options = {}) {
  installVisionModelPickerPresentation(ctx)
  installVisionOnboarding(ctx)
  installVisionModelPickerControls(ctx)
  installVisionRoutingSection(ctx)
  installVisionBenchmarkPanel(ctx)
  installVisionDiagnosticsPanel(ctx, options)
  return ctx
}

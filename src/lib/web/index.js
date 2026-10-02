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
import { installSettingsFactoryLifecycle } from '../settings-factory-lifecycle.js'

const DEFAULT_INSTALLERS = Object.freeze({
  settingsController: installVisionSettingsController,
  remoteSettings: installVisionRemoteSettingsClient,
  settingsFactoryLifecycle: installSettingsFactoryLifecycle,
  modelPresentation: installVisionModelPickerPresentation,
  onboarding: installVisionOnboarding,
  modelControls: installVisionModelPickerControls,
  routingSection: installVisionRoutingSection,
  benchmarkPanel: installVisionBenchmarkPanel,
  diagnosticsPanel: installVisionDiagnosticsPanel,
})

function installersOf(overrides) {
  return overrides && typeof overrides === 'object'
    ? { ...DEFAULT_INSTALLERS, ...overrides }
    : DEFAULT_INSTALLERS
}

/** Preserve the pre-Host-settings wrapper order from the legacy entry. */
export function installVisionSettingsWebBoundary(ctx, logger, overrides) {
  const installers = installersOf(overrides)
  installers.settingsController(ctx)
  installers.remoteSettings(ctx, logger)
  // SettingsController and remoteSettings keep registering their mature
  // transforms in historical order. Finalize them once, after both exist, so
  // one boundary owns queue -> live factory lifecycle on alpha/newer Hosts.
  installers.settingsFactoryLifecycle(ctx)
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
  const installers = installersOf(options.installers)
  installers.modelPresentation(ctx)
  installers.onboarding(ctx)
  installers.modelControls(ctx)
  installers.routingSection(ctx)
  installers.benchmarkPanel(ctx)
  installers.diagnosticsPanel(ctx, options)
  return ctx
}
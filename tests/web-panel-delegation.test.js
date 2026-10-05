import { test } from 'node:test'
import assert from 'node:assert/strict'

// The web/ panels are thin delegating wrappers: each one calls a real installer and
// returns the ctx it was given. They had no symbol-level test coverage, so the
// property worth pinning is the one every target shares — the carrier seam. Every
// target routes through installClientScriptCarriers, which needs ctx.inject and
// then registers a carrier on webServer; a wrapper that stopped delegating (or that
// started requiring more from the ctx) would fail here.

const SHIMS = [
  { name: 'benchmark-panel', module: '../lib/web/benchmark-panel.js', installers: ['installVisionBenchmarkPanel'] },
  { name: 'onboarding', module: '../lib/web/onboarding.js', installers: ['installVisionOnboarding'] },
  { name: 'routing-section', module: '../lib/web/routing-section.js', installers: ['installVisionRoutingSection'] },
  { name: 'settings-controller', module: '../lib/web/settings-controller.js', installers: ['installVisionSettingsController'] },
  {
    name: 'model-picker',
    module: '../lib/web/model-picker.js',
    installers: ['installVisionModelPickerPresentation', 'installVisionModelPickerControls', 'installVisionModelPicker'],
  },
]

function recordingContext() {
  const registrations = []
  const ctx = {
    on: (event, handler) => { registrations.push({ kind: 'on', event, handler }) },
    effect: (setup, label) => { registrations.push({ kind: 'effect', label }); return () => {} },
    get: () => undefined,
    inject(names, callback) {
      registrations.push({ kind: 'inject', names })
      return callback({
        on: (event, handler) => { registrations.push({ kind: 'on', event, handler }) },
        effect: (setup, label) => { registrations.push({ kind: 'effect', label }); const teardown = setup(); return typeof teardown === 'function' ? teardown : () => {} },
        webServer: { tapIndex: (transform) => { registrations.push({ kind: 'tapIndex' }); return () => {} } },
      })
    },
  }
  return { ctx, registrations }
}

for (const shim of SHIMS) {
  test(`${shim.name} delegates its installers to the shared client-carrier seam`, async () => {
    const module = await import(shim.module)
    for (const installerName of shim.installers) {
      assert.equal(typeof module[installerName], 'function', `${installerName} must stay exported`)

      const { ctx, registrations } = recordingContext()
      const returned = module[installerName](ctx)
      assert.equal(returned, ctx, `${installerName} must return the ctx it was given`)
      assert.ok(
        registrations.some((entry) => entry.kind === 'inject'),
        `${installerName} must install through ctx.inject`,
      )
      assert.ok(
        registrations.some((entry) => entry.kind === 'on' || entry.kind === 'effect' || entry.kind === 'tapIndex'),
        `${installerName} must register a carrier surface`,
      )
    }
  })

  test(`${shim.name} is inert for a host without the carrier surfaces`, async () => {
    const module = await import(shim.module)
    for (const installerName of shim.installers) {
      for (const value of [{}, null, undefined, 42, 'x']) {
        assert.doesNotThrow(() => module[installerName](value), `${installerName}(${String(value)}) must not throw`)
      }
      // No inject surface: the shim has nothing to install and must hand the ctx back.
      const bare = { on() {}, effect() {} }
      assert.equal(module[installerName](bare), bare)
    }
  })
}

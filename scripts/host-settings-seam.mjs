// Which reviewed settings seams does this Host actually provide?
//
// DVR's runtime adapts to the live settings surface by feature detection, never by
// version. The contract gate has to do the same: the 0.1.5 line exposes the native
// SettingsProvider.register() namespace, while 0.1.7 and every 0.2.x Host (rc.2
// included, and again the 0.2.1 alpha line) drop register() in favour of
// SettingsForms.describe() backed by ConfigEditor configuration()/edit(). A gate that
// hardcodes one shape reports "unsupported" for a Host DVR supports, so both seams are
// enumerated from the Host and the gate asserts whichever are present.
export const NATIVE_SETTINGS_SEAM = 'native-register'
export const CONFIG_EDITOR_SETTINGS_SEAM = 'config-editor'

function hasFunction(value, name) {
  return typeof value?.[name] === 'function'
}

export function settingsSeamsOf({
  nativeLiveNamespace = false,
  settingsForms,
  configEditor,
} = {}) {
  const seams = []
  if (nativeLiveNamespace === true || hasFunction(settingsForms, 'register')) {
    seams.push(NATIVE_SETTINGS_SEAM)
  }
  if (
    hasFunction(settingsForms, 'describe')
    && hasFunction(configEditor, 'configuration')
    && hasFunction(configEditor, 'edit')
  ) {
    seams.push(CONFIG_EDITOR_SETTINGS_SEAM)
  }
  return seams
}

export function resolveSettingsModes(requested, seams) {
  if (requested === undefined || requested === '' || requested === 'auto') {
    if (seams.length === 0) {
      throw new Error(
        'Host provides none of the reviewed settings seams: '
        + 'SettingsProvider.register(), or SettingsForms.describe() with '
        + 'ConfigEditor configuration()/edit()',
      )
    }
    return seams
  }
  if (requested === NATIVE_SETTINGS_SEAM || requested === CONFIG_EDITOR_SETTINGS_SEAM) {
    return [requested]
  }
  throw new Error(`unknown EXPECT_SETTINGS_MODE ${JSON.stringify(requested)}`)
}

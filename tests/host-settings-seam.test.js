// The contract gate must assert the settings seam a Host actually provides, not the
// one a workflow hardcoded. These cases pin the seam enumeration and the mode
// resolution, including the negative control: a Host with neither reviewed seam must
// fail loudly instead of being reported as supported.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_EDITOR_SETTINGS_SEAM,
  NATIVE_SETTINGS_SEAM,
  resolveSettingsModes,
  settingsSeamsOf,
} from '../scripts/host-settings-seam.mjs'

const fn = () => {}

test('a Host whose mounted provider exposes register() has the native seam', () => {
  assert.deepEqual(
    settingsSeamsOf({ nativeLiveNamespace: true, settingsForms: {}, configEditor: undefined }),
    [NATIVE_SETTINGS_SEAM],
  )
})

test('a Host whose SettingsForms carries register() has the native seam', () => {
  assert.deepEqual(
    settingsSeamsOf({ settingsForms: { register: fn }, configEditor: undefined }),
    [NATIVE_SETTINGS_SEAM],
  )
})

test('a Host with SettingsForms.describe() plus ConfigEditor exposes the reviewed seam', () => {
  assert.deepEqual(
    settingsSeamsOf({
      settingsForms: { describe: fn },
      configEditor: { configuration: fn, edit: fn },
    }),
    [CONFIG_EDITOR_SETTINGS_SEAM],
  )
})

test('a Host that drops register() but keeps ConfigEditor reports only the reviewed seam', () => {
  // This is the whole 0.2.x shape, rc.2 and the 0.2.1 alpha line alike: dsh-settings
  // carries the same SettingsForms, but the live namespace no longer comes from
  // register().
  assert.deepEqual(
    settingsSeamsOf({
      settingsForms: { describe: fn },
      configEditor: { configuration: fn, edit: fn },
    }),
    [CONFIG_EDITOR_SETTINGS_SEAM],
  )
})

test('a partial ConfigEditor surface is not a seam', () => {
  assert.deepEqual(
    settingsSeamsOf({
      settingsForms: { describe: fn },
      configEditor: { configuration: fn },
    }),
    [],
  )
})

test('auto asserts every seam the Host provides', () => {
  const seams = [NATIVE_SETTINGS_SEAM, CONFIG_EDITOR_SETTINGS_SEAM]
  assert.deepEqual(resolveSettingsModes('auto', seams), seams)
  assert.deepEqual(resolveSettingsModes(undefined, seams), seams)
  assert.deepEqual(resolveSettingsModes('', seams), seams)
})

test('auto fails loudly when the Host provides no reviewed seam', () => {
  assert.throws(
    () => resolveSettingsModes('auto', []),
    /Host provides none of the reviewed settings seams/,
  )
})

test('an explicit mode still pins exactly one seam, and unknown modes are rejected', () => {
  assert.deepEqual(resolveSettingsModes(NATIVE_SETTINGS_SEAM, []), [NATIVE_SETTINGS_SEAM])
  assert.deepEqual(
    resolveSettingsModes(CONFIG_EDITOR_SETTINGS_SEAM, []),
    [CONFIG_EDITOR_SETTINGS_SEAM],
  )
  assert.throws(() => resolveSettingsModes('something-else', []), /unknown EXPECT_SETTINGS_MODE/)
})

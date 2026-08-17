import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('settings card exposes a one-click logs-folder action', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("openLogFolder: '打开日志文件夹'"), true)
  assert.equal(source.includes("openLogFolder: 'Open logs folder'"), true)
  assert.equal(source.includes("fetch('/_dsh/vision-router/logs'"), true)
  assert.equal(source.includes("method: 'POST'"), true)
})

test('settings UX keeps beginner guidance while using user-facing labels', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("quickStartTitle: '聊天和看图分别设置'"), true)
  assert.equal(source.includes("quickStartGuide: '重新查看新手引导'"), true)
  assert.equal(source.includes("onboardingStep1Title: '1 · 选择聊天模型'"), true)
  assert.equal(source.includes("onboardingStep2Title: '2 · 选择识图模型'"), true)
  assert.equal(source.includes("onboardingStep3Title: '3 · 设置备用模型'"), true)
  assert.equal(source.includes("chainLabel: '识图模型'"), true)
  assert.equal(source.includes("toggleRouting: '整轮交给视觉模型'"), true)
  assert.equal(source.includes("toggleStructuredVisionBootstrap: '结构化预识别（1+x，实验）'"), true)
  assert.equal(source.includes("toggleRewriteImages: '保护纯文字模型'"), true)
})

test('settings UX keeps engineering controls behind advanced groups', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("groupPerformance: '性能'"), true)
  assert.equal(source.includes("groupCompatibility: '兼容性'"), true)
  assert.equal(source.includes("groupNetwork: '网络'"), true)
  assert.equal(source.includes("groupDeveloper: '开发者设置'"), true)
  assert.equal(source.includes("className: 'vr-savebar'"), true)
  assert.equal(source.includes('width:max-content;max-width:100%'), true)
  assert.equal(source.includes('margin:0 -8px'), false)
  assert.equal(source.includes('backdrop-filter:blur(10px)'), false)
  assert.equal(source.includes("const TOGGLE_KEYS = ['autoWrapProviders', 'tool', 'structuredVisionBootstrap', 'routing']"), true)
  assert.equal(source.includes("const PERFORMANCE_TOGGLE_KEYS = ['downscale', 'cache']"), true)
  assert.equal(source.includes("const COMPATIBILITY_TOGGLE_KEYS = ['reverseRouting', 'rewriteImages', 'freeFallback']"), true)
  assert.equal(source.includes("const DEVELOPER_TOGGLE_KEYS = ['stealth']"), true)
})

test('settings UX puts model setup before advanced and diagnostics', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const renderStart = source.indexOf("return h('li', { className: 'vr-card'")
  assert.notEqual(renderStart, -1)
  const render = source.slice(renderStart)
  const quickStart = render.indexOf("t('quickStartTitle')")
  const primaryToggles = render.indexOf('TOGGLE_KEYS.map((key) => toggleField(key))')
  const visionChain = render.indexOf('chainEditor()')
  const testConnection = render.indexOf("t('testConnection')")
  const advanced = render.indexOf("t('advanced')")
  const developerControls = render.indexOf('DEVELOPER_TOGGLE_KEYS.map((key) => toggleField(key))')
  const diagnostics = render.indexOf("t('groupDiagnostics')")
  assert.equal(
    [quickStart, primaryToggles, visionChain, testConnection, advanced, developerControls, diagnostics].every((index) => index >= 0),
    true,
  )
  assert.equal(quickStart < primaryToggles, true)
  assert.equal(primaryToggles < visionChain, true)
  assert.equal(visionChain < testConnection, true)
  assert.equal(testConnection < advanced, true)
  assert.equal(advanced < developerControls, true)
  assert.equal(developerControls < diagnostics, true)
})

test('log-folder failures include a machine-readable error code', () => {
  const serverSource = readFileSync(new URL('../lib/file-logger.js', import.meta.url), 'utf8')
  assert.equal(serverSource.includes("code: error && error.code !== undefined ? String(error.code) : undefined"), true)
})

test('settings save failures are forwarded to the bounded server diagnostic route', () => {
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const serverSource = readFileSync(new URL('../lib/file-logger.js', import.meta.url), 'utf8')
  assert.equal(clientSource.includes("fetch('/_dsh/vision-router/settings-save-diagnostics'"), true)
  assert.equal(serverSource.includes("const SETTINGS_SAVE_DIAGNOSTICS_PATH = '/_dsh/vision-router/settings-save-diagnostics'"), true)
  assert.equal(serverSource.includes("'vision-router: settings save failed field=%s operation=%s reason=%s detail=%s'"), true)
})

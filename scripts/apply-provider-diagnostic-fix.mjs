import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`)
  return source.replace(from, to)
}

const clientPath = 'lib/client.js'
let client = readFileSync(clientPath, 'utf8')

client = replaceOnce(
  client,
  "      visionCapsFiltered: '视觉后端下拉只显示明确声明 image 输入的模型。',\n      chainInvalidCurrent:",
  "      visionCapsFiltered: '视觉后端下拉只显示明确声明 image 输入的模型。',\n      visionCapsEmptyTitle: '没有可选的用户视觉模型',\n      visionCapsEmptyBody: '检测到 {count} 个用户模型，但它们都没有被 DSH 明确标记为支持图片，因此已被安全隐藏。',\n      visionCapsHiddenPrefix: '被隐藏的模型：',\n      visionCapsReasonMissingImage: '未声明 image',\n      visionCapsReasonUnverified: '无法验证图片能力',\n      visionCapsHiddenMore: '另有 {count} 个模型未显示',\n      visionCapsMissingImageHint: '如果这里有你刚在「设置 → 模型 → 添加自定义提供方」中添加的视觉模型，请在 $DSH_HOME/settings.yaml 为该模型补上 input: [text, image]，或为整个提供方补上 defaultInput: [text, image]。DSH 当前 Web 表单不会写入这个字段。',\n      visionCapsRetry: '重新检测模型',\n      chainInvalidCurrent:",
  'zh diagnostics copy',
)

client = replaceOnce(
  client,
  "      visionCapsFiltered: 'The vision-backend dropdown only shows models that explicitly declare image input.',\n      chainInvalidCurrent:",
  "      visionCapsFiltered: 'The vision-backend dropdown only shows models that explicitly declare image input.',\n      visionCapsEmptyTitle: 'No selectable user vision models',\n      visionCapsEmptyBody: 'DSH reported {count} user models, but none are explicitly marked as accepting images, so Vision Router hid them safely.',\n      visionCapsHiddenPrefix: 'Hidden models:',\n      visionCapsReasonMissingImage: 'image input not declared',\n      visionCapsReasonUnverified: 'image capability could not be verified',\n      visionCapsHiddenMore: '{count} more models not shown',\n      visionCapsMissingImageHint: 'If one of these is a vision model you just added through Settings → Models → Add custom provider, add input: [text, image] to that model in $DSH_HOME/settings.yaml, or defaultInput: [text, image] to the provider. The current DSH Web form does not write this field.',\n      visionCapsRetry: 'Re-detect models',\n      chainInvalidCurrent:",
  'en diagnostics copy',
)

client = replaceOnce(
  client,
  "    function filterVisionBackendGroups(groups, capabilities) {\n      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}\n      return (Array.isArray(groups) ? groups : [])\n        .map((group) => {\n          const models = (group && Array.isArray(group.models) ? group.models : []).filter((model) => {\n            if (!model || typeof model.id !== 'string') return false\n            // The built-in backend is defined by this plugin and always\n            // declares image input. Keeping it visible while the capability\n            // request is still loading avoids a blank default editor.\n            if (group.id === 'vision-http') return false\n            return !!(caps[group.id] && caps[group.id][model.id] && caps[group.id][model.id].image === true)\n          })\n          return { ...group, models }\n        })\n        .filter((group) => group && group.models.length > 0)\n    }\n",
  "    function filterVisionBackendGroups(groups, capabilities) {\n      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}\n      return (Array.isArray(groups) ? groups : [])\n        .map((group) => {\n          const models = (group && Array.isArray(group.models) ? group.models : []).filter((model) => {\n            if (!model || typeof model.id !== 'string') return false\n            if (group.id === 'vision-http') return false\n            return !!(caps[group.id] && caps[group.id][model.id] && caps[group.id][model.id].image === true)\n          })\n          return { ...group, models }\n        })\n        .filter((group) => group && group.models.length > 0)\n    }\n\n    function collectFilteredVisionBackends(groups, capabilities) {\n      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}\n      const hidden = []\n      for (const group of Array.isArray(groups) ? groups : []) {\n        if (!group || typeof group.id !== 'string' || group.id === 'vision-http') continue\n        for (const model of Array.isArray(group.models) ? group.models : []) {\n          if (!model || typeof model.id !== 'string' || model.id === '') continue\n          const capability = caps[group.id] && caps[group.id][model.id]\n          if (capability && capability.image === true) continue\n          hidden.push({\n            provider: group.id,\n            model: model.id,\n            reason: capability && typeof capability.reason === 'string' ? capability.reason : undefined,\n            missingImageDeclaration:\n              !!capability && capability.reason === 'model metadata does not declare image input',\n          })\n        }\n      }\n      return hidden\n    }\n",
  'filtered-backend diagnostics helper',
)

client = replaceOnce(
  client,
  "      '.vr-catalog-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +\n      '.vr-subheader",
  "      '.vr-catalog-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +\n      '.vr-vision-empty{margin:8px 0 2px;padding:11px 12px;border:1px solid var(--dsw-alias-label-warning,var(--dsw-alias-border-l2));border-radius:9px;background:var(--dsw-alias-bg-module-platform);display:flex;flex-direction:column;gap:7px}' +\n      '.vr-vision-empty-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary);margin:0}' +\n      '.vr-vision-empty-list{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;word-break:break-word}' +\n      '.vr-vision-empty-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +\n      '.vr-subheader",
  'diagnostics css',
)

client = replaceOnce(
  client,
  "      const visionGroups = filterVisionBackendGroups(catalog.groups, visionCaps.capabilities)\n      const visionModelsFor",
  "      const visionGroups = filterVisionBackendGroups(catalog.groups, visionCaps.capabilities)\n      const hiddenVisionBackends =\n        visionCaps.status === 'ready' ? collectFilteredVisionBackends(catalog.groups, visionCaps.capabilities) : []\n      const visionModelsFor",
  'hidden model state',
)

client = replaceOnce(
  client,
  "      const loadCatalog = () => {\n        if (catalog.status === 'loading' || catalog.status === 'ready') return",
  "      const loadCatalog = (force = false) => {\n        if (!force && (catalog.status === 'loading' || catalog.status === 'ready')) return",
  'forced catalog refresh',
)

client = replaceOnce(
  client,
  "      const loadVisionCapabilities = () => {\n        if (visionCaps.status === 'loading' || visionCaps.status === 'ready') return",
  "      const loadVisionCapabilities = (force = false) => {\n        if (!force && (visionCaps.status === 'loading' || visionCaps.status === 'ready')) return",
  'forced capability refresh',
)

client = replaceOnce(
  client,
  "      let snapshot\n      let renderError",
  "      const retryVisionModels = () => {\n        setCatalog({ status: 'idle', groups: [], error: undefined })\n        setVisionCaps({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })\n        loadCatalog(true)\n        loadVisionCapabilities(true)\n      }\n      let snapshot\n      let renderError",
  'retry action',
)

client = replaceOnce(
  client,
  "      const builtinFallbackPanel = () => {",
  "      const emptyVisionModelsPanel = () => {\n        if (!(catalogReady && visionCaps.status === 'ready' && visionGroups.length === 0 && hiddenVisionBackends.length > 0)) {\n          return null\n        }\n        const preview = hiddenVisionBackends.slice(0, 8)\n        const remaining = hiddenVisionBackends.length - preview.length\n        const hasMissingDeclaration = hiddenVisionBackends.some((entry) => entry.missingImageDeclaration)\n        return h('div', { className: 'vr-vision-empty' },\n          h('p', { className: 'vr-vision-empty-title' }, t('visionCapsEmptyTitle')),\n          h('p', { className: 'vr-hint' }, t('visionCapsEmptyBody', { count: hiddenVisionBackends.length })),\n          h('p', { className: 'vr-hint' }, t('visionCapsHiddenPrefix')),\n          h('ul', { className: 'vr-vision-empty-list' },\n            preview.map((entry) =>\n              h('li', { key: entry.provider + '/' + entry.model },\n                entry.provider + '/' + entry.model + ' — ' +\n                  t(entry.missingImageDeclaration ? 'visionCapsReasonMissingImage' : 'visionCapsReasonUnverified')),\n            ),\n            remaining > 0 ? h('li', { key: 'more' }, t('visionCapsHiddenMore', { count: remaining })) : null,\n          ),\n          hasMissingDeclaration\n            ? h('p', { className: 'vr-hint vr-stealth-notice' }, t('visionCapsMissingImageHint'))\n            : null,\n          h('div', { className: 'vr-vision-empty-actions' },\n            h('button', {\n              type: 'button', className: 'vr-btn',\n              disabled: catalog.status === 'loading' || visionCaps.status === 'loading',\n              onClick: retryVisionModels,\n            }, t('visionCapsRetry')),\n          ),\n        )\n      }\n      const builtinFallbackPanel = () => {",
  'empty dropdown diagnostics panel',
)

client = replaceOnce(
  client,
  "              catalogReady\n                ? chainEditor()",
  "              emptyVisionModelsPanel(),\n              catalogReady\n                ? chainEditor()",
  'render diagnostics panel',
)

client = replaceOnce(
  client,
  "    exports.filterVisionBackendGroups = filterVisionBackendGroups\n    return module.exports",
  "    exports.filterVisionBackendGroups = filterVisionBackendGroups\n    exports.collectFilteredVisionBackends = collectFilteredVisionBackends\n    return module.exports",
  'export diagnostics helper',
)

writeFileSync(clientPath, client)

const testPath = 'tests/client.test.js'
let tests = readFileSync(testPath, 'utf8')
const marker = "test('empty vision dropdown diagnostics identify undeclared image models and support re-detection'"
if (!tests.includes(marker)) {
  tests += `\n\ntest('empty vision dropdown diagnostics identify undeclared image models and support re-detection', () => {\n  const bundle = loadClientBundle()\n  const groups = [\n    { id: 'zhipu', name: '智谱', models: [\n      { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash' },\n      { id: 'glm-4.5v', name: 'GLM-4.5V' },\n    ] },\n    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen-vl', name: 'Qwen VL' }] },\n  ]\n  const hidden = bundle.collectFilteredVisionBackends(groups, {\n    zhipu: {\n      'glm-4.6v-flash': { image: false, reason: 'model metadata does not declare image input' },\n      'glm-4.5v': { image: false, reason: 'model metadata does not declare image input' },\n    },\n    openrouter: { 'qwen-vl': { image: true } },\n  })\n  assert.deepEqual(hidden.map((entry) => [entry.provider, entry.model, entry.missingImageDeclaration]), [\n    ['zhipu', 'glm-4.6v-flash', true],\n    ['zhipu', 'glm-4.5v', true],\n  ])\n\n  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')\n  assert.equal(source.includes(\"visionCapsRetry: '重新检测模型'\"), true)\n  assert.equal(source.includes('input: [text, image]'), true)\n  assert.equal(source.includes('defaultInput: [text, image]'), true)\n  assert.equal(source.includes('loadCatalog(true)'), true)\n  assert.equal(source.includes('loadVisionCapabilities(true)'), true)\n  assert.equal(source.includes('emptyVisionModelsPanel()'), true)\n})\n`
  writeFileSync(testPath, tests)
}

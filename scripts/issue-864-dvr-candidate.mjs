// Diagnostic-only DVR candidate in a disposable runner checkout.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
function patch(path, before, after) {
  const source = readFileSync(path, 'utf8')
  assert.equal(source.split(before).length, 2, path + ': ' + before)
  writeFileSync(path, source.replace(before, () => after))
}
patch('src/index.js',
  "return { id: provider, name: 'DeepSeek + 自动识图' }",
  "return { id: provider, name: 'DeepSeek + 自动识图', presentationAliasOf: wrapperDelegateRoute() }")
patch('src/index.js',
  'return { id: twinRoute, name: \`\${state.sourceName} + 自动识图\` }'.replaceAll('\\', ''),
  'return { id: twinRoute, name: \`\${state.sourceName} + 自动识图\`, presentationAliasOf: provider }'.replaceAll('\\', ''))
patch('src/lib/vision-model-visibility-boundary-main.js',
  "    var cache = typeof WeakMap === 'function' ? new WeakMap() : undefined;\n    return new Proxy(models, {",
  "    // A Host-owned shared presentation is authoritative; avoid a second projection.\n    if (typeof models.rawDirectoryFor === 'function') return models;\n    var cache = typeof WeakMap === 'function' ? new WeakMap() : undefined;\n    return new Proxy(models, {")

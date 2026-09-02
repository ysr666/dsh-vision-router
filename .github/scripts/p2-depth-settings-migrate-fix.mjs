import { readFileSync, writeFileSync } from 'node:fs'

const file = '.github/scripts/p2-depth-settings-migrate.mjs'
let source = readFileSync(file, 'utf8')

// The rendered settings group is indented inside the card body; keep the
// migration exact rather than weakening its match globally.
{
  const startNeedle = "replaceOnce(\n  'lib/client.js',\n  `            SELECT_KEYS.map"
  const start = source.indexOf(startNeedle)
  if (start === -1) throw new Error('deep-dive migration block start not found')
  const endMarker = "\n)\n\n// 2. The live-model compatibility layer"
  const end = source.indexOf(endMarker, start)
  if (end === -1) throw new Error('deep-dive migration block end not found')
  const replacement = `replaceOnce(\n  'lib/client.js',\n  \`                    SELECT_KEYS.map((key) => selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), [\\n                      { value: 'fast', label: t('visionDepthFast') },\\n                      { value: 'standard', label: t('visionDepthStandard') },\\n                      { value: 'deep', label: t('visionDepthDeep') },\\n                      { value: 'custom', label: t('visionDepthCustom') },\\n                    ])),\\n                    format('visionDepth') === 'custom'\\n                      ? DEPTH_NUMBER_KEYS.map((key) => textField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), false))\\n                      : null,\\n                    guidanceOverridesEditor(),\`,\n  \`                    SELECT_KEYS.map((key) => selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), [\\n                      { value: 'fast', label: t('visionDepthFast') },\\n                      { value: 'standard', label: t('visionDepthStandard') },\\n                      { value: 'deep', label: t('visionDepthDeep') },\\n                    ])),\\n                    depthCapField(),\\n                    guidanceOverridesEditor(),\`,\n  'first-class deep-dive group composition',\n)`
  source = source.slice(0, start) + replacement + source.slice(end + 2)
}

// The old inner quota guard has nested JSON braces, so don't guess its exact
// textual shape with a broad regex. Use its unique runtime anchor and the
// surrounding indentation boundary instead.
{
  const startNeedle = "replaceRegexOnce(\n  'index.js',\n  /                  if \\("
  const start = source.indexOf(startNeedle)
  if (start === -1) throw new Error('index quota migration block start not found')
  const endMarker = "\n)\nreplaceOnce(\n  'index.js',\n  '                      state.deepCalls = (state.deepCalls || 0) + 1\\n'"
  const end = source.indexOf(endMarker, start)
  if (end === -1) throw new Error('index quota migration block end not found')
  const replacement = `{\n  const indexFile = 'index.js'\n  let indexSource = read(indexFile)\n  const anchor = indexSource.indexOf('const limit = depthLimitFor(visionDepth())')\n  if (anchor === -1) throw new Error('remove dead inner VISION_DEPTH_LIMIT guard: anchor not found')\n  const ifStart = indexSource.lastIndexOf('                  if (', anchor)\n  if (ifStart === -1) throw new Error('remove dead inner VISION_DEPTH_LIMIT guard: owner if not found')\n  const closing = '\\n                  }\\n'\n  const ifEnd = indexSource.indexOf(closing, anchor)\n  if (ifEnd === -1) throw new Error('remove dead inner VISION_DEPTH_LIMIT guard: owner end not found')\n  indexSource = indexSource.slice(0, ifStart) + indexSource.slice(ifEnd + closing.length)\n  write(indexFile, indexSource)\n}`
  source = source.slice(0, start) + replacement + source.slice(end + 2)
}

// Retire only the depth-specific shim state. The turn-budget card still owns
// its numeric bounds and context-wrapper cache, so preserve those declarations.
{
  const label = source.indexOf("'remove depth constants from budget prelude'")
  if (label === -1) throw new Error('budget prelude migration label not found')
  const emptyReplacement = "\n  '',\n"
  const replacementStart = source.lastIndexOf(emptyReplacement, label)
  if (replacementStart === -1) throw new Error('budget prelude empty replacement not found')
  const constants = "\n  `  var DEFAULT_TURN_BUDGET_MS = 0;\\n  var MIN_TURN_BUDGET_MS = 10000;\\n  var MAX_TURN_BUDGET_MS = 600000;\\n  var contexts = typeof WeakMap === 'function' ? new WeakMap() : undefined;\\n`,\n"
  source = source.slice(0, replacementStart) + constants + source.slice(replacementStart + emptyReplacement.length)
}

// Preserve index.js's historical re-export without keeping a dead local import.
// This maintains compatibility for direct index.js consumers while leaving the
// structured hardening layer as the sole runtime owner of explicit call caps.
{
  const marker = '\n// Guard the migration result before tests run.\n'
  const at = source.indexOf(marker)
  if (at === -1) throw new Error('migration guard marker not found')
  const additions = `\nreplaceOnce(\n  'index.js',\n  'export { depthLimitFor }',\n  "export { depthLimitFor } from './lib/depth-guidance.js'",\n  'preserve depthLimitFor compatibility re-export without local shadow import',\n)\n\nreplaceOnce(\n  'tests/settings-ia-client-prelude.test.js',\n  "test('strategy page groups tool usage, 1+x depth, and custom guidance together', () => {",\n  "test('strategy page groups tool usage, 1+x depth, independent call cap, and custom guidance together', () => {",\n  'settings IA strategy test title',\n)\nreplaceOnce(\n  'tests/settings-ia-client-prelude.test.js',\n  '  assert.match(text, /最多追加识图调用/)\\n',\n  '  assert.match(text, /限制深挖次数/)\\n  assert.match(text, /最多深挖次数/)\\n',\n  'settings IA independent depth-cap expectations',\n)\n`
  source = source.slice(0, at) + additions + source.slice(at)
}

writeFileSync(file, source)

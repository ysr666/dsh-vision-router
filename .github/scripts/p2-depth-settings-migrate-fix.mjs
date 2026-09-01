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

writeFileSync(file, source)

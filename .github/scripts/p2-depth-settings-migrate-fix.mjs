import { readFileSync, writeFileSync } from 'node:fs'

const file = '.github/scripts/p2-depth-settings-migrate.mjs'
let source = readFileSync(file, 'utf8')
const startNeedle = "replaceOnce(\n  'lib/client.js',\n  `            SELECT_KEYS.map"
const start = source.indexOf(startNeedle)
if (start === -1) throw new Error('deep-dive migration block start not found')
const endMarker = "\n)\n\n// 2. The live-model compatibility layer"
const end = source.indexOf(endMarker, start)
if (end === -1) throw new Error('deep-dive migration block end not found')
const replacement = `replaceOnce(\n  'lib/client.js',\n  \`                    SELECT_KEYS.map((key) => selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), [\\n                      { value: 'fast', label: t('visionDepthFast') },\\n                      { value: 'standard', label: t('visionDepthStandard') },\\n                      { value: 'deep', label: t('visionDepthDeep') },\\n                      { value: 'custom', label: t('visionDepthCustom') },\\n                    ])),\\n                    format('visionDepth') === 'custom'\\n                      ? DEPTH_NUMBER_KEYS.map((key) => textField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), false))\\n                      : null,\\n                    guidanceOverridesEditor(),\`,\n  \`                    SELECT_KEYS.map((key) => selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), [\\n                      { value: 'fast', label: t('visionDepthFast') },\\n                      { value: 'standard', label: t('visionDepthStandard') },\\n                      { value: 'deep', label: t('visionDepthDeep') },\\n                    ])),\\n                    depthCapField(),\\n                    guidanceOverridesEditor(),\`,\n  'first-class deep-dive group composition',\n)`
source = source.slice(0, start) + replacement + source.slice(end + 2)
writeFileSync(file, source)

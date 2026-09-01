import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

function read(file) {
  return readFileSync(file, 'utf8')
}

function write(file, value) {
  writeFileSync(file, value)
}

function replaceOnce(file, search, replacement, label) {
  const source = read(file)
  const first = source.indexOf(search)
  if (first === -1) throw new Error(`${label}: source pattern not found in ${file}`)
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`${label}: source pattern matched more than once in ${file}`)
  }
  write(file, source.slice(0, first) + replacement + source.slice(first + search.length))
}

function replaceRegexOnce(file, pattern, replacement, label) {
  const source = read(file)
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
  if (matches.length !== 1) throw new Error(`${label}: expected one match in ${file}, got ${matches.length}`)
  write(file, source.replace(pattern, replacement))
}

// 1. Make the first-class client bundle own depth strategy + optional call-cap UI.
replaceOnce(
  'lib/client.js',
  `      visionDepthFast: '快速（最多再细看 1 次）',\n      visionDepthStandard: '标准（细看 1-2 次，默认）',\n      visionDepthDeep: '细致（细看 2-4 次）',\n      visionDepthCustom: '自定义（自己填次数上限）',\n      hintVisionDepth: '选择看图时的精细度：快速最省（最多再细看 1 次）、标准为默认（细看 1-2 次）、细致看得最细（细看 2-4 次）。档位只限制「再细看几次」，具体看什么由模型按你的问题决定。',\n      labelVisionDepthMaxCalls: '自定义深挖次数上限',\n      hintVisionDepthMaxCalls: '选择「自定义」后填写次数上限（1-100）；留空或填 0 = 不限制深挖次数（视同标准档）。bootstrap 预识别那遍不计入，失败的调用也不占次数。',`,
  `      visionDepthFast: '快速（优先整体判断）',\n      visionDepthStandard: '标准（按需查证，默认）',\n      visionDepthDeep: '细致（主动交叉验证）',\n      hintVisionDepth: '看图深度只决定识图策略，不限制调用次数：快速优先整体判断，标准按问题需要查证，细致会主动做更多局部检查与交叉验证。如需限制调用次数，请启用下方「限制深挖次数」。',\n      depthCapTitle: '限制深挖次数',\n      depthCapHint: '默认关闭，不限制视觉证据调用次数。启用后可设置本轮最多允许多少次成功的深挖证据调用；bootstrap 预识别不计入，失败或空证据调用不占次数。',\n      depthCapValueLabel: '最多深挖次数',\n      depthCapInvalid: '请输入 1–100 之间的整数。',`,
  'zh depth settings copy',
)
replaceOnce(
  'lib/client.js',
  `      visionDepthFast: 'Quick (at most 1 more look)',\n      visionDepthStandard: 'Standard (1-2 looks, default)',\n      visionDepthDeep: 'Thorough (2-4 looks)',\n      visionDepthCustom: 'Custom (set your own cap)',\n      hintVisionDepth: 'How thoroughly to look after the structured pre-scan: Quick is cheapest (at most 1 more look), Standard is the default (1-2 looks), Thorough looks the closest (2-4 looks). The tier only caps how many extra looks are allowed; what the model looks for is driven by your question.',\n      labelVisionDepthMaxCalls: 'Custom deep-dive call cap',\n      hintVisionDepthMaxCalls: 'Pick "Custom" first, then enter a cap (1-100). Empty or 0 = no cap (same as Standard). The bootstrap pre-scan does not count, and failed calls do not consume the quota.',`,
  `      visionDepthFast: 'Quick (overall-first)',\n      visionDepthStandard: 'Standard (evidence as needed, default)',\n      visionDepthDeep: 'Thorough (proactive cross-checking)',\n      hintVisionDepth: 'Vision depth chooses the inspection strategy, not a call-count limit: Quick stays overall-first, Standard verifies evidence as needed, and Thorough proactively inspects details and cross-checks important claims. To cap calls, enable “Limit deep-dive calls” below.',\n      depthCapTitle: 'Limit deep-dive calls',\n      depthCapHint: 'Off by default, so visual evidence calls are unlimited. Enable this to cap successful deep-evidence calls for the turn. The bootstrap pre-scan does not count, and failed or empty-evidence calls do not consume the cap.',\n      depthCapValueLabel: 'Maximum deep-dive calls',\n      depthCapInvalid: 'Enter an integer from 1 to 100.',`,
  'en depth settings copy',
)
replaceOnce(
  'lib/client.js',
  `    function parseNumber(text, min) {\n      const trimmed = String(text ?? '').trim()\n      if (trimmed === '') return { clear: true }\n      const parsed = Number(trimmed)\n      return Number.isInteger(parsed) && parsed >= min ? { value: parsed } : undefined\n    }`,
  `    function parseNumber(text, min, max) {\n      const trimmed = String(text ?? '').trim()\n      if (trimmed === '') return { clear: true }\n      const parsed = Number(trimmed)\n      return Number.isInteger(parsed) && parsed >= min && (max === undefined || parsed <= max)\n        ? { value: parsed }\n        : undefined\n    }`,
  'bounded number parser',
)
replaceOnce(
  'lib/client.js',
  `        if (NUMBER_KEYS.includes(key) || DEPTH_NUMBER_KEYS.includes(key)) return parseNumber(text, NUMBER_META[key].min)`,
  `        if (NUMBER_KEYS.includes(key) || DEPTH_NUMBER_KEYS.includes(key)) {\n          return parseNumber(text, NUMBER_META[key].min, NUMBER_META[key].max)\n        }`,
  'numeric metadata max enforcement',
)
replaceOnce(
  'lib/client.js',
  `        if (SELECT_KEYS.includes(key)) {\n          return value === 'fast' || value === 'standard' || value === 'deep' || value === 'custom' ? value : 'standard'\n        }`,
  `        if (SELECT_KEYS.includes(key)) {\n          if (value === 'custom') return 'standard'\n          return value === 'fast' || value === 'standard' || value === 'deep' ? value : 'standard'\n        }`,
  'legacy custom snapshot projection',
)
replaceOnce(
  'lib/client.js',
  `        if (SELECT_KEYS.includes(key)) {\n          return text === 'fast' || text === 'standard' || text === 'deep' || text === 'custom' ? { value: text } : undefined\n        }`,
  `        if (SELECT_KEYS.includes(key)) {\n          return text === 'fast' || text === 'standard' || text === 'deep' ? { value: text } : undefined\n        }`,
  'strategy parser without visible custom mode',
)
replaceOnce(
  'lib/client.js',
  `            className: 'vr-input vr-select' + (invalidField ? ' vr-input-invalid' : ''),\n            value: format(key), disabled: editBlocked,`,
  `            className: 'vr-input vr-select' + (invalidField ? ' vr-input-invalid' : ''),\n            'data-vr-depth-strategy': key === 'visionDepth' ? '1' : undefined,\n            value: format(key), disabled: editBlocked,`,
  'stable depth strategy selector marker',
)
replaceOnce(
  'lib/client.js',
  `      // 自定义识图引导编辑器：每行 [图片类型 select] [引导语 input] [移除]，+ 添加。`,
  `      const depthCapField = () => {\n        const key = 'visionDepthMaxCalls'\n        const raw = format(key)\n        const parsed = Number(raw)\n        const enabled = Number.isInteger(parsed) && parsed > 0\n        const invalidField = key in drafts && parse(key, drafts[key]) === undefined\n        const savedRaw = Number(readValue(snapshot, key))\n        const savedCap = Number.isInteger(savedRaw) && savedRaw >= 1 && savedRaw <= 100 ? savedRaw : 4\n        return h('div', { className: 'vr-field', key, 'data-vr-depth-cap': '1' },\n          h('div', { className: 'vr-field-head' },\n            h('div', { className: 'vr-toggle' },\n              h('span', { className: 'vr-label' }, t('depthCapTitle')),\n              h('input', {\n                type: 'checkbox', className: 'vr-check', checked: enabled,\n                'data-vr-depth-cap-toggle': '1', disabled: editBlocked,\n                onChange: (event) => setDraft(key, event.target.checked ? String(savedCap) : '0'),\n              }),\n            ),\n            overriddenBadge(key),\n          ),\n          h('p', { className: 'vr-hint' }, t('depthCapHint')),\n          enabled\n            ? h('div', { className: 'vr-local-row' },\n                h('label', { className: 'vr-label vr-local-label' }, t('depthCapValueLabel')),\n                h('input', {\n                  className: 'vr-input' + (invalidField ? ' vr-input-invalid' : ''),\n                  type: 'number', min: 1, max: 100, step: 1, value: raw,\n                  'data-vr-depth-cap-value': '1', disabled: editBlocked,\n                  onChange: (event) => setDraft(key, event.target.value),\n                }),\n                invalidField\n                  ? h('p', { className: 'vr-invalid' }, t('depthCapInvalid'))\n                  : null,\n              )\n            : null,\n        )\n      }\n\n      // 自定义识图引导编辑器：每行 [图片类型 select] [引导语 input] [移除]，+ 添加。`,
  'first-class depth cap editor',
)
replaceOnce(
  'lib/client.js',
  `            SELECT_KEYS.map((key) => selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), [\n              { value: 'fast', label: t('visionDepthFast') },\n              { value: 'standard', label: t('visionDepthStandard') },\n              { value: 'deep', label: t('visionDepthDeep') },\n              { value: 'custom', label: t('visionDepthCustom') },\n            ])),\n            format('visionDepth') === 'custom'\n              ? DEPTH_NUMBER_KEYS.map((key) => textField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), false))\n              : null,\n            guidanceOverridesEditor(),`,
  `            SELECT_KEYS.map((key) => selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), [\n              { value: 'fast', label: t('visionDepthFast') },\n              { value: 'standard', label: t('visionDepthStandard') },\n              { value: 'deep', label: t('visionDepthDeep') },\n            ])),\n            depthCapField(),\n            guidanceOverridesEditor(),`,
  'first-class deep-dive group composition',
)

// 2. The live-model compatibility layer must not overwrite unrelated depth settings copy.
replaceRegexOnce(
  'lib/live-model-client-prelude.js',
  /\n        visionDepthStandard: '标准（最多再细看 2 次，默认）',[\s\S]*?hintVisionDepthMaxCalls: '选择「自定义」后填写 0-100：1-100 = 最多深挖对应次数；留空或填 0 = 不限制。bootstrap 预识别不计入，失败调用也不占次数。标准档仍固定最多 2 次。'/,
  '',
  'remove stale zh depth copy from live-model prelude',
)
replaceRegexOnce(
  'lib/live-model-client-prelude.js',
  /\n        visionDepthStandard: 'Standard \(at most 2 more looks, default\)',[\s\S]*?hintVisionDepthMaxCalls: 'With Custom selected, enter 0-100: 1-100 caps successful deep-dive evidence calls; blank or 0 = unlimited. The bootstrap pre-scan and failed calls do not consume the quota. Standard remains capped at 2.'/,
  '',
  'remove stale en depth copy from live-model prelude',
)

// 3. The turn-budget prelude should own only the turn-budget compatibility card.
replaceRegexOnce(
  'lib/vision-turn-budget-client-prelude.js',
  /  var DEPTH_CAP_FIELD = 'visionDepthMaxCalls';[\s\S]*?  var reactWrappers = typeof WeakMap === 'function' \? new WeakMap\(\) : undefined;\n/,
  '',
  'remove depth constants from budget prelude',
)
replaceRegexOnce(
  'lib/vision-turn-budget-client-prelude.js',
  /  function patchCopy\(namespace, dictionaries\) \{[\s\S]*?\n  \}\n\n  function wrapLocale/,
  `  function patchCopy(namespace, dictionaries) {\n    if (namespace !== SETTINGS_SECTION_ID || !dictionaries || typeof dictionaries !== 'object') return dictionaries;\n    var next = Object.assign({}, dictionaries);\n    if (next.zh && typeof next.zh === 'object') {\n      next.zh = Object.assign({}, next.zh, {\n        visionTurnBudgetTitle: '整轮视觉工具时间上限',\n        visionTurnBudgetHint: '可选的整轮 Vision Router 视觉工具总时间上限。默认不限制；填 0 表示不限制。单次视觉任务仍受独立超时保护。',\n        visionTurnBudgetInvalid: '请输入 0，或 10000–600000 之间的整数毫秒值。',\n        visionTurnBudgetSaved: '已保存',\n        visionTurnBudgetSaveFailed: '保存失败'\n      });\n    }\n    if (next.en && typeof next.en === 'object') {\n      next.en = Object.assign({}, next.en, {\n        visionTurnBudgetTitle: 'Whole-turn vision time limit',\n        visionTurnBudgetHint: 'Optional total time limit for Vision Router visual tools across the turn. Unlimited by default; enter 0 for unlimited. Individual visual tasks still have their own timeout.',\n        visionTurnBudgetInvalid: 'Enter 0, or an integer from 10000 to 600000 milliseconds.',\n        visionTurnBudgetSaved: 'Saved',\n        visionTurnBudgetSaveFailed: 'Save failed'\n      });\n    }\n    return next;\n  }\n\n  function wrapLocale`,
  'budget-only locale copy',
)
replaceRegexOnce(
  'lib/vision-turn-budget-client-prelude.js',
  /\n  function collectOptionValues[\s\S]*?\n  function makeBudgetCard/,
  `\n  function makeBudgetCard`,
  'remove React depth interception and cap card from budget prelude',
)
replaceRegexOnce(
  'lib/vision-turn-budget-client-prelude.js',
  /  function wrapSlots\(slots, React\) \{[\s\S]*?\n  \}\n\n  function wrapContext/,
  `  function wrapSlots(slots, React) {\n    if (!slots || (typeof slots !== 'object' && typeof slots !== 'function')) return slots;\n    var BudgetCard = makeBudgetCard(React);\n    return new Proxy(slots, {\n      get: function(target, property) {\n        if (property === 'register') {\n          var register = Reflect.get(target, property, target);\n          if (typeof register !== 'function') return register;\n          return function(options, component) {\n            var args = Array.prototype.slice.call(arguments);\n            if (options && options.name === 'settings.section' && options.id === SETTINGS_SECTION_ID && component) {\n              var Original = component;\n              args[1] = function VisionRouterSectionWithTurnBudget(props) {\n                return React.createElement(\n                  React.Fragment,\n                  null,\n                  React.createElement(Original, props),\n                  React.createElement(BudgetCard, props)\n                );\n              };\n            }\n            return register.apply(target, args);\n          };\n        }\n        var value = Reflect.get(target, property, target);\n        return typeof value === 'function' ? value.bind(target) : value;\n      }\n    });\n  }\n\n  function wrapContext`,
  'budget-only slot wrapper',
)
replaceRegexOnce(
  'lib/vision-turn-budget-client-prelude.js',
  /          var factory = spec\.factory;[\s\S]*?              return exports;\n            \}/,
  `          var factory = spec.factory;\n          spec = Object.assign({}, spec, {\n            factory: function(require) {\n              var exports = factory(require);\n              var React;\n              try { React = require('react'); } catch (_) { React = undefined; }\n              if (React && exports && typeof exports.apply === 'function' && !exports.apply.__visionRouterTurnBudget) {\n                var apply = exports.apply;\n                var wrappedApply = function(ctx) {\n                  var rest = Array.prototype.slice.call(arguments, 1);\n                  return apply.apply(exports, [wrapContext(ctx, React)].concat(rest));\n                };\n                Object.defineProperty(wrappedApply, '__visionRouterTurnBudget', { value: true });\n                exports.apply = wrappedApply;\n              }\n              return exports;\n            }`,
  'budget prelude loader without React interception',
)

// 4. Runtime prompt text must keep scene/strategy/cap sentences delimited.
replaceOnce(
  'lib/depth-guidance.js',
  '  return `${strategyCopy}${capCopy}`',
  '  return `${strategyCopy}\\n${capCopy}`',
  'depth strategy/cap prompt separator',
)
replaceOnce(
  'lib/depth-guidance.js',
  "  return parts.join('')",
  "  return parts.join('\\n')",
  'scene/strategy prompt separator',
)

// 5. Remove the obsolete inner quota shadow from index.js; structured hardening owns explicit caps.
replaceOnce(
  'index.js',
  "import { depthLimitFor, renderDepthGuidance } from './lib/depth-guidance.js'",
  "import { renderDepthGuidance } from './lib/depth-guidance.js'",
  'remove dead depthLimitFor import',
)
replaceOnce(
  'index.js',
  `  // 看图深度档位（移植自 dsh-vision 的 PRECISION 档位概念）：\n  // fast = 本轮视觉调用上限 1 次（快速）；standard = 上限 2 次（bootstrap+1，\n  // 与现状等价）；deep = 上限 3-4 次（完整证据链）。档位只定「深度上限」，\n  // 模型在档位内按用户问题自选工具与轮次（保留 x 的自由度）。默认 standard\n  // = 现状行为逐字节不变。与场景路由正交：场景管出口、档位管深度。`,
  `  // 看图深度档位只决定查证策略，不隐式限制调用次数：fast 整体优先，\n  // standard 围绕问题按需查证，deep 主动检查局部并交叉验证。独立的\n  // visionDepthMaxCalls 安全阀由 structured-flow hardening 统一执行。`,
  'current depth strategy comment',
)
replaceRegexOnce(
  'index.js',
  /                  if \(\n                    state &&\n                    state\.bootstrapDone &&\n                    def\.name !== 'vision_bootstrap' &&\n                    structuredFollowupEvidenceTools\.has\(def\.name\)\n                  \) \{\n                    const limit = depthLimitFor\(visionDepth\(\)\)[\s\S]*?\n                  \}\n/,
  '',
  'remove dead inner VISION_DEPTH_LIMIT guard',
)
replaceOnce(
  'index.js',
  '                      state.deepCalls = (state.deepCalls || 0) + 1\n',
  '',
  'remove obsolete inner deepCalls counter',
)

// 6. Regression tests: ownership, stale-copy protection, separators, and real browser lifecycle.
replaceOnce(
  'tests/depth-tier.test.js',
  `test('index.js integration: legacy inner guard remains but receives the independent cap policy', () => {\n  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')\n  assert.equal(index.includes("visionDepth: z.union(['fast', 'standard', 'deep']).default('standard')"), true)\n  assert.equal(index.includes('depthLimitFor(visionDepth())'), true)\n  assert.equal(index.includes('renderDepthGuidance({'), true)\n  assert.equal(index.includes("code: 'VISION_DEPTH_LIMIT'"), true)\n})\n\ntest('index.js integration: evidence calls are counted only after evidence is produced', () => {\n  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')\n  assert.equal(index.includes('state.deepCalls = used + 1'), false)\n  assert.equal(index.includes('state.deepCalls = (state.deepCalls || 0) + 1'), true)\n  assert.equal(index.includes('evidenceFailure'), true)\n  assert.equal(index.includes('state.followupCompleted = true'), true)\n})`,
  `test('index.js integration: explicit call caps have one runtime owner', () => {\n  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')\n  assert.equal(index.includes("visionDepth: z.union(['fast', 'standard', 'deep']).default('standard')"), true)\n  assert.equal(index.includes('depthLimitFor(visionDepth())'), false)\n  assert.equal(index.includes('state.deepCalls'), false)\n  assert.equal(index.includes("code: 'VISION_DEPTH_LIMIT'"), false)\n  assert.equal(index.includes('renderDepthGuidance({'), true)\n  assert.equal(index.includes('state.followupCompleted = true'), true)\n})`,
  'depth-tier index ownership test',
)
replaceOnce(
  'tests/depth-tier.test.js',
  `test('client presentation: depth strategy and optional cap are separate bilingual controls', () => {\n  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')\n  const prelude = readFileSync(new URL('../lib/vision-turn-budget-client-prelude.js', import.meta.url), 'utf8')\n  assert.equal(client.includes("const SELECT_KEYS = ['visionDepth']"), true)\n  assert.match(prelude, /快速（优先整体判断）/)\n  assert.match(prelude, /标准（按需查证，默认）/)\n  assert.match(prelude, /细致（主动交叉验证）/)\n  assert.match(prelude, /Quick \\(overall-first\\)/)\n  assert.match(prelude, /Standard \\(evidence as needed, default\\)/)\n  assert.match(prelude, /Thorough \\(proactive cross-checking\\)/)\n  assert.match(prelude, /限制深挖次数/)\n  assert.match(prelude, /Limit deep-dive calls/)\n  assert.match(prelude, /DEPTH_CAP_FIELD = 'visionDepthMaxCalls'/)\n  assert.match(prelude, /values\\.has\\('fast'\\).*values\\.has\\('standard'\\).*values\\.has\\('deep'\\).*values\\.has\\('custom'\\)/s)\n  assert.match(prelude, /node\\.props\\.value === 'custom'/)\n  assert.doesNotMatch(prelude, /Standard remains capped at 2|标准档仍固定最多 2 次/)\n})`,
  `test('client presentation: depth strategy and optional cap are first-class bilingual controls', () => {\n  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')\n  const prelude = readFileSync(new URL('../lib/vision-turn-budget-client-prelude.js', import.meta.url), 'utf8')\n  assert.equal(client.includes("const SELECT_KEYS = ['visionDepth']"), true)\n  assert.match(client, /快速（优先整体判断）/)\n  assert.match(client, /标准（按需查证，默认）/)\n  assert.match(client, /细致（主动交叉验证）/)\n  assert.match(client, /Quick \\(overall-first\\)/)\n  assert.match(client, /Standard \\(evidence as needed, default\\)/)\n  assert.match(client, /Thorough \\(proactive cross-checking\\)/)\n  assert.match(client, /限制深挖次数/)\n  assert.match(client, /Limit deep-dive calls/)\n  assert.match(client, /data-vr-depth-cap-toggle/)\n  assert.match(client, /data-vr-depth-cap-value/)\n  assert.match(client, /if \\(value === 'custom'\\) return 'standard'/)\n  assert.doesNotMatch(client, /\\{ value: 'custom', label: t\\('visionDepthCustom'\\) \\}/)\n  assert.doesNotMatch(prelude, /DEPTH_CAP_FIELD|makeDepthCapCard|stripLegacyCustomOption|projectStrategySnapshot|visionDepthFast/)\n})\n\ntest('depth guidance separates scene, strategy, and optional cap sentences', () => {\n  const cap = depthCopyFor('standard', 6, 'en-US')\n  assert.ok(cap.includes('\\nA separate deep-dive call cap'))\n  const rendered = renderDepthGuidance({ visualKind: 'ui', depth: 'standard', locale: 'en-US' })\n  assert.ok(rendered.includes('(ground).\\nVision strategy is Standard'))\n})`,
  'depth-tier client ownership + separator tests',
)

replaceRegexOnce(
  'tests/vision-turn-budget-client-prelude.test.js',
  /test\('depth strategy copy is bilingual and contains no built-in count promise',[\s\S]*?\n\}\)\n\ntest\('depth call cap is a separate opt-in checkbox backed by maxCalls=0\/positive',[\s\S]*?\n\}\)\n\ntest\('legacy custom strategy is projected to standard and hidden by stable option values',[\s\S]*?\n\}\)\n/,
  `test('turn-budget prelude does not own depth strategy or call-cap UI', () => {\n  assert.doesNotMatch(VISION_TURN_BUDGET_CLIENT_PRELUDE, /DEPTH_CAP_FIELD|DEPTH_FIELD|makeDepthCapCard/)\n  assert.doesNotMatch(VISION_TURN_BUDGET_CLIENT_PRELUDE, /stripLegacyCustomOption|projectStrategySnapshot|visionDepthFast/)\n  assert.doesNotMatch(VISION_TURN_BUDGET_CLIENT_PRELUDE, /限制深挖次数|Limit deep-dive calls/)\n})\n\n`,
  'budget prelude ownership tests',
)

replaceRegexOnce(
  'tests/settings-section-order.test.js',
  /test\('client copy keeps standard capped at 2 while custom zero remains unlimited after live transition',[\s\S]*?\n\}\)\n/,
  `test('live-model prelude leaves depth settings copy to the client bundle', () => {\n  const { registeredDictionaries } = runPreludeRegistration()\n\n  assert.equal(registeredDictionaries.zh.hintVisionDepthMaxCalls, 'old zh')\n  assert.equal(registeredDictionaries.zh.hintVisionDepth, 'old zh depth')\n  assert.equal(registeredDictionaries.zh.visionDepthStandard, 'old zh standard')\n  assert.equal(registeredDictionaries.zh.visionDepthDeep, 'old zh deep')\n  assert.equal(registeredDictionaries.en.hintVisionDepthMaxCalls, 'old en')\n  assert.equal(registeredDictionaries.en.hintVisionDepth, 'old en depth')\n  assert.equal(registeredDictionaries.en.visionDepthStandard, 'old en standard')\n  assert.equal(registeredDictionaries.en.visionDepthDeep, 'old en deep')\n})\n`,
  'live-model depth ownership test',
)

replaceOnce(
  'tests/alpha1-browser-lifecycle-integration.test.js',
  `import { V2_SETTINGS_IA_CLIENT } from '../lib/v2-settings-ia-integration.js'`,
  `import { V2_SETTINGS_IA_CLIENT } from '../lib/v2-settings-ia-integration.js'\nimport { VISION_TURN_BUDGET_CLIENT_PRELUDE } from '../lib/vision-turn-budget-client-prelude.js'`,
  'alpha lifecycle turn-budget prelude import',
)
replaceOnce(
  'tests/alpha1-browser-lifecycle-integration.test.js',
  `    VISION_MODEL_VISIBILITY_PRELUDE,\n    SETTINGS_FACTORY_LIFECYCLE_PRELUDE,`,
  `    VISION_MODEL_VISIBILITY_PRELUDE,\n    SETTINGS_FACTORY_LIFECYCLE_PRELUDE,\n    VISION_TURN_BUDGET_CLIENT_PRELUDE,`,
  'alpha lifecycle composed prelude list',
)
replaceOnce(
  'tests/alpha1-browser-lifecycle-integration.test.js',
  `      visionTaskTimeoutMs: 45000,\n      visionTurnBudgetMs: 0,`,
  `      visionTaskTimeoutMs: 45000,\n      visionTurnBudgetMs: 0,\n      structuredVisionBootstrap: true,\n      visionDepth: 'standard',\n      visionDepthMaxCalls: 0,`,
  'alpha lifecycle depth snapshot',
)
replaceOnce(
  'tests/alpha1-browser-lifecycle-integration.test.js',
  `  assert.ok(findNode(generalTree, (node) => node.props?.id === 'vr-vision-backend-chain'))\n  assert.match(V2_SETTINGS_IA_CLIENT, /var ROOT='\\.vr-settings-ia-root'/)`,
  `  assert.ok(findNode(generalTree, (node) => node.props?.id === 'vr-vision-backend-chain'))\n  const depthSelect = findNode(generalTree, (node) => node.props?.['data-vr-depth-strategy'] === '1')\n  assert.ok(depthSelect, 'real client bundle must own the depth strategy selector')\n  assert.equal(depthSelect.props.value, 'standard')\n  assert.deepEqual(\n    childrenOf(depthSelect.props.children).map((option) => option.props?.value),\n    ['fast', 'standard', 'deep'],\n  )\n  const depthCap = findNode(generalTree, (node) => node.props?.['data-vr-depth-cap'] === '1')\n  assert.ok(depthCap, 'real client bundle must own the independent depth-call cap')\n  const depthCapToggle = findNode(depthCap, (node) => node.props?.['data-vr-depth-cap-toggle'] === '1')\n  assert.ok(depthCapToggle)\n  assert.equal(depthCapToggle.props.checked, false)\n  assert.equal(findNode(depthCap, (node) => node.props?.['data-vr-depth-cap-value'] === '1'), undefined)\n  assert.match(V2_SETTINGS_IA_CLIENT, /var ROOT='\\.vr-settings-ia-root'/)`,
  'alpha lifecycle depth ownership assertions',
)

// Ensure the composed browser lifecycle gate is part of normal Node 22/24 and web test lanes too.
{
  const pkg = JSON.parse(read('package.json'))
  const lifecycle = 'tests/alpha1-browser-lifecycle-integration.test.js'
  if (!pkg.scripts.test.includes(lifecycle)) {
    pkg.scripts.test = pkg.scripts.test.replace('tests/client.test.js', `${lifecycle} tests/client.test.js`)
  }
  if (!pkg.scripts['test:web'].includes(lifecycle)) {
    pkg.scripts['test:web'] = pkg.scripts['test:web'].replace('tests/client.test.js', `${lifecycle} tests/client.test.js`)
  }
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
}

// Guard the migration result before tests run.
for (const [file, forbidden] of [
  ['lib/client.js', ['最多再细看 1 次', 'Standard (1-2 looks, default)', "value: 'custom', label: t('visionDepthCustom')"]],
  ['lib/live-model-client-prelude.js', ['Standard remains capped at 2', '标准档仍固定最多 2 次']],
  ['lib/vision-turn-budget-client-prelude.js', ['DEPTH_CAP_FIELD', 'makeDepthCapCard', 'stripLegacyCustomOption']],
  ['index.js', ['depthLimitFor(visionDepth())', 'state.deepCalls']],
]) {
  const source = read(file)
  for (const token of forbidden) {
    if (source.includes(token)) throw new Error(`forbidden stale P2 token remains in ${file}: ${token}`)
  }
}

unlinkSync('.github/scripts/p2-depth-settings-migrate.mjs')
unlinkSync('.github/workflows/p2-depth-settings-migrate.yml')

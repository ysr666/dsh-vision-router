import { readFile, writeFile } from 'node:fs/promises'

const read = (p) => readFile(p, 'utf8')
const write = (p, s) => writeFile(p, s)

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`patch target not found: ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`patch target not unique: ${label}`)
  return source.slice(0, first) + after + source.slice(first + before.length)
}

let index = await read('index.js')
index = replaceOnce(
  index,
  `import {\n  normalizeStructuredBootstrapResult,\n  structuredBootstrapMemory,\n  structuredBootstrapQuestion,\n} from './lib/structured-bootstrap.js'`,
  `import {\n  normalizeStructuredBootstrapResult,\n  structuredBootstrapMemory,\n  structuredBootstrapQuestion,\n} from './lib/structured-bootstrap.js'\nimport {\n  VISION_STRATEGIES,\n  inferToolVisionIntent,\n  rankVisionCandidates,\n  explainVisionRoute,\n} from './lib/vision-capability-router.js'`,
  'capability router import',
)
index = replaceOnce(
  index,
  `  structuredVisionBootstrap: z.boolean().default(false),\n  progressiveTools: z.boolean().default(true),`,
  `  structuredVisionBootstrap: z.boolean().default(false),\n  // v2 prototype: compute an intent-aware model order and log it, but keep\n  // executing the existing v1 fallback order. Safe for real-world comparison.\n  capabilityRoutingShadow: z.boolean().default(false),\n  capabilityRoutingStrategy: z.string().default('balanced'),\n  progressiveTools: z.boolean().default(true),`,
  'shadow config',
)
index = replaceOnce(
  index,
  `  const toolEnabled = () => current().tool !== false\n  const structuredBootstrapEnabled = () => current().structuredVisionBootstrap === true`,
  `  const toolEnabled = () => current().tool !== false\n  const structuredBootstrapEnabled = () => current().structuredVisionBootstrap === true\n  const capabilityRoutingShadowEnabled = () => current().capabilityRoutingShadow === true\n  const capabilityRoutingStrategy = () => {\n    const value = current().capabilityRoutingStrategy\n    return VISION_STRATEGIES.includes(value) ? value : 'balanced'\n  }`,
  'shadow live config helpers',
)

const chainMarker = `\n  // ── vision chain route: fallback under our own control ─────────────────────`
const shadowHelper = `\n\n  // Phase-2 v2 shadow router. It sees the exact candidate pool and current\n  // breaker state, produces an intent-aware suggested order, and logs the\n  // comparison. Crucially, callers continue iterating usablePairs/httpFallbacks\n  // in their original v1 order; this helper never mutates execution order.\n  const shadowVisionRouting = async ({ toolName, args = {}, intent, usablePairs = [], httpFallbacks = [], scope = 'anon:0' }) => {\n    if (!capabilityRoutingShadowEnabled()) return undefined\n    const candidates = []\n    const health = {}\n    for (const pair of usablePairs) {\n      const key = \`\${pair.provider}/\${pair.model}\`\n      const fingerprint = await credentialFingerprintFor({ provider: pair.provider })\n      const gate = visionBreaker.inspect(key, fingerprint, scope)\n      health[key] = { circuitOpen: gate.blocked === true }\n      const local = isLocalBackendPair(pair)\n      candidates.push({ provider: pair.provider, model: pair.model, key, local, cost: local ? 0 : 0.5 })\n    }\n    for (const provider of httpFallbacks) {\n      const key = \`http:\${provider.name}/\${provider.model}\`\n      const fingerprint = await credentialFingerprintFor({ kind: 'http', apiKeyEnv: provider.apiKeyEnv })\n      const gate = visionBreaker.inspect(key, fingerprint, scope)\n      health[key] = { circuitOpen: gate.blocked === true }\n      candidates.push({\n        provider: \`http:\${provider.name}\`,\n        model: provider.model,\n        key,\n        local: false,\n        cost: typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv !== '' ? 0.5 : 0,\n      })\n    }\n    if (candidates.length === 0) return undefined\n    const resolvedIntent = intent ?? inferToolVisionIntent(toolName, args)\n    const ranked = rankVisionCandidates({\n      intent: resolvedIntent,\n      candidates,\n      strategy: capabilityRoutingStrategy(),\n      health,\n    })\n    const v1 = candidates.map((candidate) => candidate.key)\n    const v2 = ranked.map((candidate) => candidate.key)\n    const changed = v1.join('\\u0000') !== v2.join('\\u0000')\n    const scored = ranked.map((candidate) => \`\${candidate.key}(\${candidate.score.toFixed(3)})\`)\n    ctx.logger?.info(\n      'vision-router: capability-shadow tool=%s intent=%s strategy=%s changed=%s v1=[%s] v2=[%s]',\n      toolName,\n      resolvedIntent,\n      capabilityRoutingStrategy(),\n      changed ? 'yes' : 'no',\n      v1.join(' > '),\n      scored.join(' > '),\n    )\n    return {\n      toolName,\n      intent: resolvedIntent,\n      strategy: capabilityRoutingStrategy(),\n      changed,\n      v1,\n      v2,\n      explanation: explainVisionRoute(ranked),\n    }\n  }\n`
if (!index.includes('const shadowVisionRouting = async')) {
  if (!index.includes(chainMarker)) throw new Error('patch target not found: vision chain marker')
  index = index.replace(chainMarker, shadowHelper + chainMarker)
}

index = replaceOnce(
  index,
  `        const question = String(args.question ?? '')\n        const wantJson = args.json === true`,
  `        const question = String(args.question ?? '')\n        const wantJson = args.json === true\n        const shadowToolName = typeof args.__visionToolName === 'string' ? args.__visionToolName : 'vision_describe'\n        const shadowIntent = typeof args.__visionIntent === 'string' ? args.__visionIntent : undefined`,
  'vision_describe shadow metadata',
)
index = replaceOnce(
  index,
  `        const session = exec && exec.agent && exec.agent.session\n        const scope = visionScopeOf(session)\n        if (visionTurnMemory.allFailed(scope)) {`,
  `        const session = exec && exec.agent && exec.agent.session\n        const scope = visionScopeOf(session)\n        await shadowVisionRouting({\n          toolName: shadowToolName,\n          args,\n          intent: shadowIntent,\n          usablePairs,\n          httpFallbacks,\n          scope,\n        })\n        if (visionTurnMemory.allFailed(scope)) {`,
  'vision_describe shadow call',
)
index = replaceOnce(
  index,
  `            question: structuredBootstrapQuestion(),\n            // IMPORTANT: do not use vision_describe's generic json:true schema`,
  `            question: structuredBootstrapQuestion(),\n            __visionToolName: 'vision_bootstrap',\n            __visionIntent: 'structured',\n            // IMPORTANT: do not use vision_describe's generic json:true schema`,
  'bootstrap shadow intent',
)
index = replaceOnce(
  index,
  `      const httpFallbacks = httpProviders()\n      const primaryWeight = DEFAULT_HTTP_PROVIDERS.length`,
  `      const httpFallbacks = httpProviders()\n      const shadowIntent = options.intent ?? inferToolVisionIntent(\n        options.toolName ?? 'vision_describe',\n        options.toolArgs ?? { question: instruction },\n      )\n      await shadowVisionRouting({\n        toolName: options.toolName ?? 'vision_internal',\n        args: options.toolArgs ?? { question: instruction },\n        intent: shadowIntent,\n        usablePairs,\n        httpFallbacks,\n        scope,\n      })\n      const primaryWeight = DEFAULT_HTTP_PROVIDERS.length`,
  'answerVision shadow call',
)
await write('index.js', index)

let router = await read('lib/vision-capability-router.js')
router = replaceOnce(
  router,
  `      const q = String(args.question ?? context.question ?? '').toLowerCase()\n      if (/\\b(terminal|traceback|stack trace|compiler|source code|code screenshot|ide|console|log)\\b/.test(q)) {`,
  `      const q = String(args.question ?? context.question ?? '').toLowerCase()\n      if (/\\b(ocr|transcribe|transcription|read all text|exact text|visible text)\\b/.test(q) || /原样转述|所有文字|逐字|识别文字/.test(q)) {\n        return 'ocr'\n      }\n      if (/\\b(locate|bounding box|where is|coordinates?|position of|tight box)\\b/.test(q)) {\n        return 'grounding'\n      }\n      if (/\\b(detect|find every|list all|enumerate|all buttons|all inputs|all elements|numbered inventory)\\b/.test(q)) {\n        return 'detection'\n      }\n      if (/\\b(terminal|traceback|stack trace|compiler|source code|code screenshot|ide|console|log)\\b/.test(q)) {`,
  'instruction intent refinement',
)
await write('lib/vision-capability-router.js', router)

let client = await read('lib/client.js')
client = replaceOnce(
  client,
  `      toggleStructuredVisionBootstrap: '结构化预识别（1+x，实验）',`,
  `      toggleStructuredVisionBootstrap: '结构化预识别（1+x，实验）',\n      toggleCapabilityRoutingShadow: '能力路由影子模式（v2 实验）',\n      hintCapabilityRoutingShadow: '只计算并记录 v2 建议的视觉模型顺序，不改变实际调用顺序。用于对比当前固定链和能力感知路由，安全测试真实任务。',\n      capabilityRoutingStrategyLabel: 'v2 路由策略',\n      capabilityRoutingStrategyHint: '影子模式的打分策略：balanced / quality / speed / privacy。当前仅影响建议顺序，不影响实际执行。',`,
  'zh shadow strings',
)
client = replaceOnce(
  client,
  `      toggleStructuredVisionBootstrap: 'Structured pre-scan (1+x, experimental)',`,
  `      toggleStructuredVisionBootstrap: 'Structured pre-scan (1+x, experimental)',\n      toggleCapabilityRoutingShadow: 'Capability routing shadow mode (v2 experimental)',\n      hintCapabilityRoutingShadow: 'Computes and logs the v2 suggested vision-model order without changing actual execution. Use it to compare the fixed chain with capability-aware routing on real tasks safely.',\n      capabilityRoutingStrategyLabel: 'v2 routing policy',\n      capabilityRoutingStrategyHint: 'Shadow scoring policy: balanced / quality / speed / privacy. It changes only the suggested order for now.',`,
  'en shadow strings',
)
client = replaceOnce(
  client,
  `    const DEVELOPER_TOGGLE_KEYS = ['stealth']`,
  `    const DEVELOPER_TOGGLE_KEYS = ['stealth', 'capabilityRoutingShadow']`,
  'developer toggle list',
)
client = replaceOnce(
  client,
  `      structuredVisionBootstrap: 'toggleStructuredVisionBootstrap',`,
  `      structuredVisionBootstrap: 'toggleStructuredVisionBootstrap',\n      capabilityRoutingShadow: 'toggleCapabilityRoutingShadow',`,
  'shadow label map',
)
client = replaceOnce(
  client,
  `      structuredVisionBootstrap: 'hintStructuredVisionBootstrap',`,
  `      structuredVisionBootstrap: 'hintStructuredVisionBootstrap',\n      capabilityRoutingShadow: 'hintCapabilityRoutingShadow',`,
  'shadow hint map',
)
client = replaceOnce(
  client,
  `            DEVELOPER_TOGGLE_KEYS.map((key) => toggleField(key)),\n            stealthNotice(),`,
  `            DEVELOPER_TOGGLE_KEYS.map((key) => toggleField(key)),\n            textField('capabilityRoutingStrategy', t('capabilityRoutingStrategyLabel'), t('capabilityRoutingStrategyHint')),\n            stealthNotice(),`,
  'developer strategy field',
)
await write('lib/client.js', client)

let pkg = JSON.parse(await read('package.json'))
if (!pkg.scripts.test.includes('tests/capability-shadow.test.js')) {
  pkg.scripts.test += ' tests/capability-shadow.test.js'
}
await write('package.json', JSON.stringify(pkg, null, 2) + '\n')

let doc = await read('docs/v2-capability-routing.md')
doc = doc.replace(
  '### Phase 2 — shadow routing\n\nWire the scorer into `resolveToolVisionPairs(intent)` in shadow mode. Log `current order` vs `v2 suggested order`, but continue executing the v1 order. This gives real-world evidence without risking users.',
  '### Phase 2 — shadow routing (implemented on this branch)\n\nThe scorer is now wired into both `vision_describe` and the shared model-backed tool executor. Enable `capabilityRoutingShadow` to log `current order` vs `v2 suggested order`; actual execution still iterates the original v1 candidate order. The shadow plan includes the current circuit-breaker state, local/privacy traits and direct HTTP fallbacks. `vision_bootstrap` is explicitly tagged as `structured`, while internal OCR/grounding/detection prompts are classified into their specialist intents. This gives real-world evidence without risking users.'
)
await write('docs/v2-capability-routing.md', doc)

const test = `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { readFile } from 'node:fs/promises'\nimport { inferToolVisionIntent } from '../lib/vision-capability-router.js'\n\ntest('shadow-only config is opt-in and does not replace the v1 execution loops', async () => {\n  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')\n  assert.match(source, /capabilityRoutingShadow: z\\.boolean\\(\\)\\.default\\(false\\)/)\n  assert.match(source, /capabilityRoutingStrategy: z\\.string\\(\\)\\.default\\('balanced'\\)/)\n  assert.match(source, /const shadowVisionRouting = async/)\n  assert.match(source, /capability-shadow tool=%s intent=%s strategy=%s changed=%s/)\n  assert.match(source, /for \\(const pair of usablePairs\\)/)\n  assert.match(source, /for \\(const provider of httpFallbacks\\)/)\n  assert.doesNotMatch(source, /usablePairs\\s*=\\s*rankVisionCandidates/)\n})\n\ntest('bootstrap and shared model-backed tools feed specialist intent into shadow routing', async () => {\n  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')\n  assert.match(source, /__visionToolName: 'vision_bootstrap'/)\n  assert.match(source, /__visionIntent: 'structured'/)\n  assert.ok((source.match(/await shadowVisionRouting\\(/g) ?? []).length >= 2)\n})\n\ntest('instruction inference catches OCR, grounding and detection helpers', () => {\n  assert.equal(inferToolVisionIntent('vision_describe', { question: '请原样转述图中的所有文字' }), 'ocr')\n  assert.equal(inferToolVisionIntent('vision_describe', { question: 'Target to locate: send button; return tight bounding box' }), 'grounding')\n  assert.equal(inferToolVisionIntent('vision_describe', { question: 'Find every button and return a numbered inventory' }), 'detection')\n})\n\ntest('settings UI keeps shadow routing in developer settings', async () => {\n  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')\n  assert.match(source, /toggleCapabilityRoutingShadow/)\n  assert.match(source, /DEVELOPER_TOGGLE_KEYS = \\['stealth', 'capabilityRoutingShadow'\\]/)\n  assert.match(source, /capabilityRoutingStrategyLabel/)\n})\n`
await write('tests/capability-shadow.test.js', test)

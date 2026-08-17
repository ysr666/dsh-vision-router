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
  `import {\n  VISION_STRATEGIES,\n  inferToolVisionIntent,\n  rankVisionCandidates,\n  explainVisionRoute,\n} from './lib/vision-capability-router.js'`,
  `import {\n  VISION_STRATEGIES,\n  inferToolVisionIntent,\n  rankVisionCandidates,\n  explainVisionRoute,\n} from './lib/vision-capability-router.js'\nimport { buildAgentVisionModelReference } from './lib/vision-capability-reference.js'`,
  'agent reference import',
)

const shadowMarker = `  // Phase-2 v2 shadow router. It sees the exact candidate pool and current\n`
const referenceHelper = `  // Build a compact evidence-aware model reference for the text agent. This is\n  // intentionally shadow-only: it lets us compare an agent recommendation\n  // against the scorer without changing which backend actually executes.\n  const capabilityReferenceForAgent = async () => {\n    if (!capabilityRoutingShadowEnabled()) return undefined\n    const usablePairs = await resolveToolVisionPairs()\n    const httpFallbacks = httpProviders()\n    const candidates = []\n    for (const pair of usablePairs) {\n      const local = isLocalBackendPair(pair)\n      candidates.push({\n        provider: pair.provider,\n        model: pair.model,\n        key: \`\${pair.provider}/\${pair.model}\`,\n        local,\n        cost: local ? 0 : 0.5,\n      })\n    }\n    for (const provider of httpFallbacks) {\n      candidates.push({\n        provider: \`http:\${provider.name}\`,\n        model: provider.model,\n        key: \`http:\${provider.name}/\${provider.model}\`,\n        local: false,\n        cost: typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv !== '' ? 0.5 : 0,\n      })\n    }\n    const reference = buildAgentVisionModelReference(candidates)\n    return reference.text || undefined\n  }\n\n`
if (!index.includes('const capabilityReferenceForAgent = async')) {
  const pos = index.indexOf(shadowMarker)
  if (pos < 0) throw new Error('patch target not found: shadow router marker')
  index = index.slice(0, pos) + referenceHelper + index.slice(pos)
}

index = replaceOnce(
  index,
  `    const resolvedIntent = intent ?? inferToolVisionIntent(toolName, args)\n    const ranked = rankVisionCandidates({`,
  `    const resolvedIntent = intent ?? inferToolVisionIntent(toolName, args)\n    const agentPreferredBackend =\n      typeof args.__agentPreferredBackend === 'string' && args.__agentPreferredBackend.trim() !== ''\n        ? args.__agentPreferredBackend.trim()\n        : undefined\n    const ranked = rankVisionCandidates({`,
  'shadow agent preference capture',
)
index = replaceOnce(
  index,
  `    ctx.logger?.info(\n      'vision-router: capability-shadow tool=%s intent=%s strategy=%s changed=%s v1=[%s] v2=[%s]',\n      toolName,\n      resolvedIntent,\n      capabilityRoutingStrategy(),\n      changed ? 'yes' : 'no',\n      v1.join(' > '),\n      scored.join(' > '),\n    )`,
  `    const v2Top = ranked[0]?.key\n    const agentMatch = agentPreferredBackend === undefined\n      ? 'n/a'\n      : agentPreferredBackend === v2Top ? 'yes' : 'no'\n    ctx.logger?.info(\n      'vision-router: capability-shadow tool=%s intent=%s strategy=%s changed=%s agent=%s agentMatch=%s v1=[%s] v2=[%s]',\n      toolName,\n      resolvedIntent,\n      capabilityRoutingStrategy(),\n      changed ? 'yes' : 'no',\n      agentPreferredBackend ?? '-',\n      agentMatch,\n      v1.join(' > '),\n      scored.join(' > '),\n    )`,
  'shadow logger comparison',
)
index = replaceOnce(
  index,
  `      changed,\n      v1,\n      v2,`,
  `      changed,\n      agentPreferredBackend,\n      agentMatch,\n      v1,\n      v2,`,
  'shadow result agent fields',
)

index = replaceOnce(
  index,
  `    let bootstrapReminder\n    if (bootstrapState.required && bootstrapState.completed !== true && bootstrapState.failed !== true) {`,
  `    const capabilityReference =\n      bootstrapState.required &&\n      bootstrapState.completed !== true &&\n      bootstrapState.failed !== true &&\n      capabilityRoutingShadowEnabled()\n        ? await capabilityReferenceForAgent()\n        : undefined\n\n    let bootstrapReminder\n    if (bootstrapState.required && bootstrapState.completed !== true && bootstrapState.failed !== true) {`,
  'pre-step capability reference',
)

index = replaceOnce(
  index,
  `              '完成这次后续视觉调用之前不要直接回答用户；之后才可按任务需要继续调用更多工具或作答。' +`,
  `              '完成这次后续视觉调用之前不要直接回答用户；之后才可按任务需要继续调用更多工具或作答。' +\n              (capabilityReference\n                ? '\\n\\n【v2 能力参考影子实验】\\n' + capabilityReference +\n                  '\\n请只根据用户当前任务和以上证据，选出你认为最适合执行第一次结构化视觉识别的 backend key，并在 vision_bootstrap 的 preferredBackend 中填写。' +\n                  '这只是影子推荐：不会改变实际执行模型，用于和 Router scorer 做对照。不要因为模型名本身臆测未验证新模型的能力。'\n                : '') +`,
  'bootstrap capability reference text',
)

index = replaceOnce(
  index,
  `          attachmentIds: {\n            type: 'array',\n            items: { type: 'string' },\n            description: 'Attachment ids of images uploaded in this conversation',\n          },`,
  `          attachmentIds: {\n            type: 'array',\n            items: { type: 'string' },\n            description: 'Attachment ids of images uploaded in this conversation',\n          },\n          preferredBackend: {\n            type: 'string',\n            description: 'Shadow-mode only: backend key selected from the injected capability reference. Recorded for comparison; never changes execution order.',\n          },`,
  'bootstrap preferred backend schema',
)
index = replaceOnce(
  index,
  `            __visionToolName: 'vision_bootstrap',\n            __visionIntent: 'structured',`,
  `            __visionToolName: 'vision_bootstrap',\n            __visionIntent: 'structured',\n            __agentPreferredBackend:\n              typeof args.preferredBackend === 'string' ? args.preferredBackend.trim() : undefined,`,
  'bootstrap passes agent preference',
)

await write('index.js', index)

let test = await read('tests/capability-shadow.test.js')
test += `\n\ntest('shadow bootstrap can compare an agent backend hint against the scorer', async () => {\n  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')\n  assert.match(source, /buildAgentVisionModelReference/)\n  assert.match(source, /preferredBackend/)\n  assert.match(source, /__agentPreferredBackend/)\n  assert.match(source, /agentMatch=%s/)\n  assert.match(source, /这只是影子推荐/)\n})\n`
await write('tests/capability-shadow.test.js', test)

let doc = await read('docs/v2-capability-routing.md')
doc = doc.replace(
  'The scorer is now wired into both `vision_describe` and the shared model-backed tool executor. Enable `capabilityRoutingShadow` to log `current order` vs `v2 suggested order`; actual execution still iterates the original v1 candidate order. The shadow plan includes the current circuit-breaker state, local/privacy traits and direct HTTP fallbacks. `vision_bootstrap` is explicitly tagged as `structured`, while internal OCR/grounding/detection prompts are classified into their specialist intents. This gives real-world evidence without risking users.',
  'The scorer is now wired into both `vision_describe` and the shared model-backed tool executor. Enable `capabilityRoutingShadow` to log `current order` vs `v2 suggested order`; actual execution still iterates the original v1 candidate order. The shadow plan includes the current circuit-breaker state, local/privacy traits and direct HTTP fallbacks. `vision_bootstrap` is explicitly tagged as `structured`, while internal OCR/grounding/detection prompts are classified into their specialist intents. The first bootstrap prompt can also receive a compact evidence-aware model reference and submit a shadow-only `preferredBackend`; logs compare that agent recommendation with the scorer top choice while ignoring it for execution. This gives real-world evidence without risking users.'
)
doc += `\n\n## Capability knowledge and future models\n\nA permanent hard-coded leaderboard is intentionally not the source of truth. New or renamed models can appear faster than this plugin can ship releases, and the same model name can behave differently across providers, quantization and relays. The routing evidence hierarchy is therefore:\n\n1. exact-endpoint measured/self-benchmark evidence;\n2. explicit user override;\n3. provider/model official claims when available;\n4. conservative family prior;\n5. unknown generic prior.\n\nUnknown models are shown to the agent as **unverified** rather than being assigned invented specialist strengths. `lib/vision-capability-reference.js` also plans a small task-first probe set (`task intent -> structured -> OCR -> grounding -> general`) so a future self-benchmark runner can learn the exact configured endpoint without waiting for a model-name table update.\n`
await write('docs/v2-capability-routing.md', doc)

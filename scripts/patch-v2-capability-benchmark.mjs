import { readFile, writeFile } from 'node:fs/promises'

const read = (p) => readFile(p, 'utf8')
const write = (p, s) => writeFile(p, s)

function replaceOnce(source, before, after, label) {
  const pos = source.indexOf(before)
  if (pos < 0) throw new Error(`missing patch target: ${label}`)
  if (source.indexOf(before, pos + before.length) >= 0) throw new Error(`non-unique patch target: ${label}`)
  return source.slice(0, pos) + after + source.slice(pos + before.length)
}

let index = await read('index.js')

index = replaceOnce(
  index,
  "import { buildAgentVisionModelReference } from './lib/vision-capability-reference.js'",
  "import { buildAgentVisionModelReference } from './lib/vision-capability-reference.js'\nimport {\n  CORE_BENCHMARK_INTENTS,\n  aggregateCapabilityBenchmark,\n  capabilityBenchmarkFingerprint,\n  capabilityBenchmarkFixture,\n  scoreCapabilityBenchmarkResult,\n} from './lib/vision-capability-benchmark.js'",
  'benchmark imports',
)

const marker = `  // Build a compact evidence-aware model reference for the text agent. This is\n`
const helpers = `  // Exact-backend capability benchmark state. Unlike answerVision(), this\n  // runner never walks the fallback chain: a score is attached only to the\n  // provider/model pair that actually produced it.\n  const capabilityBenchmarkMemory = new Map()\n  const capabilityBenchmarkDir = () =>\n    path.resolve(process.cwd(), String(current().artifactsDir || '.dsh-vision-router/artifacts'), 'capability-benchmarks')\n\n  const capabilityBenchmarkIdentity = async (pair) => {\n    const credential = await credentialFingerprintFor({ provider: pair.provider })\n    return capabilityBenchmarkFingerprint({\n      provider: pair.provider,\n      model: pair.model,\n      config: { credentialFingerprint: credential },\n    })\n  }\n\n  const loadCapabilityBenchmarkForPair = async (pair) => {\n    const key = \`\${pair.provider}/\${pair.model}\`\n    const fingerprint = await capabilityBenchmarkIdentity(pair)\n    const cached = capabilityBenchmarkMemory.get(key)\n    if (cached && cached.fingerprint === fingerprint) return cached\n    const file = path.join(capabilityBenchmarkDir(), \`\${fingerprint}.json\`)\n    try {\n      const parsed = JSON.parse(await readFile(file, 'utf8'))\n      if (parsed && parsed.fingerprint === fingerprint && parsed.backend === key && parsed.aggregate?.scores) {\n        capabilityBenchmarkMemory.set(key, parsed)\n        return parsed\n      }\n    } catch {}\n    return undefined\n  }\n\n  const persistCapabilityBenchmark = async (record) => {\n    const dir = capabilityBenchmarkDir()\n    await mkdir(dir, { recursive: true })\n    const file = path.join(dir, \`\${record.fingerprint}.json\`)\n    await writeFile(file, JSON.stringify(record, null, 2))\n    capabilityBenchmarkMemory.set(record.backend, record)\n    return file\n  }\n\n  const runExactCapabilityBenchmark = async ({ backend, intents }) => {\n    const usablePairs = await resolveToolVisionPairs()\n    const pair = usablePairs.find((candidate) => \`\${candidate.provider}/\${candidate.model}\` === backend)\n    if (!pair) {\n      return {\n        ok: false,\n        code: 'CAPABILITY_BENCHMARK_BACKEND_NOT_FOUND',\n        backend,\n        available: usablePairs.map((candidate) => \`\${candidate.provider}/\${candidate.model}\`),\n      }\n    }\n    const selectedIntents = Array.isArray(intents) && intents.length > 0\n      ? [...new Set(intents.filter((intent) => CORE_BENCHMARK_INTENTS.includes(intent)))]\n      : [...CORE_BENCHMARK_INTENTS]\n    if (selectedIntents.length === 0) {\n      return { ok: false, code: 'CAPABILITY_BENCHMARK_NO_VALID_INTENTS', backend }\n    }\n\n    const sharp = await loadSharp()\n    const results = []\n    for (const intent of selectedIntents) {\n      const fixture = capabilityBenchmarkFixture(intent)\n      const imageBytes = await sharp(Buffer.from(fixture.svg)).png().toBuffer()\n      const block = await visionBlocksFromBytes(imageBytes, 'image/png')\n      const capability = await resolveVisionBackendCapability(pair.provider, pair.model)\n      const deadline = createDeadline(visionTaskTimeoutMs())\n      const attemptBudgetMs = Math.max(1, Math.min(timeoutMs(), deadline.remainingMs()))\n      const signal = combineSignals(deadline.signal(), AbortSignal.timeout(attemptBudgetMs))\n      const startedAt = Date.now()\n      try {\n        const output = await callVisionPairWithOptionalBridge(\n          pair,\n          [{ role: 'user', content: [block, { type: 'text', text: fixture.prompt }] }],\n          {\n            maxTokens: 2048,\n            signal,\n            capability,\n            bridgeBlocks: block,\n            bridgeInstruction: fixture.prompt,\n          },\n        )\n        results.push({\n          ...scoreCapabilityBenchmarkResult(fixture, output, Date.now() - startedAt),\n          ok: true,\n          output: String(output).slice(0, 4000),\n        })\n      } catch (error) {\n        const classification = classifyVisionFailure(error)\n        results.push({\n          fixture: fixture.id,\n          intent: fixture.intent,\n          score: 0,\n          latencyMs: Date.now() - startedAt,\n          ok: false,\n          failure: classification.kind ?? 'unknown',\n          error: error instanceof Error ? error.message : String(error),\n        })\n      }\n    }\n\n    const fingerprint = await capabilityBenchmarkIdentity(pair)\n    const record = {\n      version: 1,\n      backend: \`\${pair.provider}/\${pair.model}\`,\n      fingerprint,\n      measuredAt: new Date().toISOString(),\n      aggregate: aggregateCapabilityBenchmark(results),\n      results,\n    }\n    record.file = await persistCapabilityBenchmark(record)\n    ctx.logger?.info(\n      'vision-router: capability-benchmark backend=%s fingerprint=%s scores=%s file=%s',\n      record.backend,\n      fingerprint,\n      JSON.stringify(record.aggregate.scores),\n      record.file,\n    )\n    return { ok: true, ...record }\n  }\n\n`
if (!index.includes('const runExactCapabilityBenchmark = async')) {
  const pos = index.indexOf(marker)
  if (pos < 0) throw new Error('missing benchmark helper insertion marker')
  index = index.slice(0, pos) + helpers + index.slice(pos)
}

index = replaceOnce(
  index,
  `    const candidates = []\n    for (const pair of usablePairs) {`,
  `    const candidates = []\n    const measured = {}\n    for (const pair of usablePairs) {`,
  'reference measured map init',
)
index = replaceOnce(
  index,
  `      candidates.push({\n        provider: pair.provider,\n        model: pair.model,\n        key,\n        local,\n        cost: local ? 0 : 0.5,\n      })\n    }`,
  `      candidates.push({\n        provider: pair.provider,\n        model: pair.model,\n        key,\n        local,\n        cost: local ? 0 : 0.5,\n      })\n      const benchmark = await loadCapabilityBenchmarkForPair(pair)\n      if (benchmark?.aggregate?.scores) measured[key] = benchmark.aggregate.scores\n    }`,
  'reference benchmark loading',
)
index = replaceOnce(
  index,
  `    const reference = buildAgentVisionModelReference(candidates)`,
  `    const reference = buildAgentVisionModelReference(candidates, { measured })`,
  'reference measured input',
)

index = replaceOnce(
  index,
  `    const candidates = []\n    const health = {}\n    for (const pair of usablePairs) {`,
  `    const candidates = []\n    const health = {}\n    const measured = {}\n    for (const pair of usablePairs) {`,
  'shadow measured map init',
)
index = replaceOnce(
  index,
  `      candidates.push({ provider: pair.provider, model: pair.model, key, local, cost: local ? 0 : 0.5 })\n    }`,
  `      candidates.push({ provider: pair.provider, model: pair.model, key, local, cost: local ? 0 : 0.5 })\n      const benchmark = await loadCapabilityBenchmarkForPair(pair)\n      if (benchmark?.aggregate?.scores) measured[key] = benchmark.aggregate.scores\n    }`,
  'shadow benchmark loading',
)
index = replaceOnce(
  index,
  `      strategy: capabilityRoutingStrategy(),\n      health,\n    })`,
  `      strategy: capabilityRoutingStrategy(),\n      health,\n      measured,\n    })`,
  'shadow measured input',
)

index = replaceOnce(
  index,
  `    deepToolDefs.push(visionDescribeTool)\n\n    // Universal structured first pass`,
  `    deepToolDefs.push(visionDescribeTool)\n\n    deepToolDefs.push({\n      name: 'vision_capability_benchmark',\n      description:\n        'Developer v2 self-benchmark. Runs privacy-safe generated fixtures against ONE exact configured vision backend with NO fallback, then stores measured capability scores for shadow routing. Use only when the user explicitly asks to test model capabilities.',\n      parameters: {\n        type: 'object',\n        properties: {\n          backend: {\n            type: 'string',\n            description: 'Exact backend key in provider/model form, e.g. openrouter/qwen3-vl-235b.',\n          },\n          intents: {\n            type: 'array',\n            items: { type: 'string', enum: CORE_BENCHMARK_INTENTS },\n            description: 'Optional subset. Default: structured, ocr, grounding, document, general.',\n          },\n        },\n        required: ['backend'],\n        additionalProperties: false,\n      },\n      async execute(args) {\n        return JSON.stringify(await runExactCapabilityBenchmark({\n          backend: String(args.backend ?? '').trim(),\n          intents: args.intents,\n        }))\n      },\n    })\n\n    // Universal structured first pass`,
  'benchmark tool definition',
)

await write('index.js', index)

let test = await read('tests/capability-shadow.test.js')
if (!test.includes('exact-backend benchmark')) {
  test += `\n\ntest('exact-backend benchmark never uses answerVision fallback walking', async () => {\n  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')\n  assert.match(source, /name: 'vision_capability_benchmark'/)\n  assert.match(source, /const runExactCapabilityBenchmark = async/)\n  assert.match(source, /callVisionPairWithOptionalBridge/)\n  assert.match(source, /CAPABILITY_BENCHMARK_BACKEND_NOT_FOUND/)\n  assert.match(source, /capability-benchmarks/)\n  assert.match(source, /buildAgentVisionModelReference\(candidates, \{ measured \}\)/)\n})\n`
}
await write('tests/capability-shadow.test.js', test)

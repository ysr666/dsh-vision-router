import assert from 'node:assert/strict'
import {
  MAX_RUNTIME_FALLBACKS_PER_ROW,
  MAX_RUNTIME_MODEL_ID_CHARS,
  MAX_RUNTIME_PROVIDER_ROWS,
  normalizeRuntimeVisionConfig,
} from '../lib/runtime-config-normalizer.js'
import { normalizeDshHostCapabilities } from '../lib/dsh-host-capabilities.js'
import { redactDiagnosticText } from '../lib/diagnostic-redaction.js'
import { resolveVisionRoutingAuthority } from '../lib/vision-routing-authority.js'
import { isOfficialOpenCodeGoUrl, wireSessionAffinityId } from '../lib/session-affinity.js'

const DEFAULT_FUZZ_SEED = 0x5eedc0de
const cases = Math.max(100, Math.min(10_000, Number(process.env.DVR_FUZZ_CASES) || 500))
const rawSeed = process.env.DVR_FUZZ_SEED
const parsedSeed = rawSeed === undefined || rawSeed === '' ? DEFAULT_FUZZ_SEED : Number(rawSeed)
if (!Number.isFinite(parsedSeed)) throw new TypeError('DVR_FUZZ_SEED must be a finite number')
const seed = Math.trunc(parsedSeed) >>> 0
let state = seed
let fuzzCase = 'startup'

function random() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0
  return state / 0x100000000
}

function pick(values) { return values[Math.floor(random() * values.length)] }
function text(max = 128) {
  const size = Math.floor(random() * max)
  const alphabet = 'abcXYZ09:/._- <>\t\n\u0000世界'
  let out = ''
  for (let i = 0; i < size; i += 1) out += alphabet[Math.floor(random() * alphabet.length)]
  return out
}
function scalar() {
  return pick([undefined, null, true, false, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, text()])
}

function providerRow() {
  const fallbacks = Array.from({ length: Math.floor(random() * 48) }, () => pick([text(), scalar()]))
  return pick([
    scalar(),
    { provider: text(), model: text(), fallbacks },
    { provider: text(MAX_RUNTIME_MODEL_ID_CHARS + 300), model: text(), fallbacks },
    { provider: 'p', model: 'm', fallbacks, extra: scalar() },
  ])
}

function configValue() {
  return pick([
    scalar(),
    [],
    {
      providers: Array.from({ length: Math.floor(random() * 48) }, providerRow),
      fallbacks: Array.from({ length: Math.floor(random() * 48) }, () => pick([text(), scalar()])),
      routingMode: scalar(),
      routingPreference: scalar(),
      backgroundBenchmarking: scalar(),
      visionGuideStep: scalar(),
      instantDescribe: scalar(),
      localDescribeStyle: scalar(),
    },
  ])
}

function replayCommand() {
  return `DVR_FUZZ_CASES=${cases} DVR_FUZZ_SEED=${seed} node scripts/security-adversarial-fuzz.mjs`
}

try {
  for (let i = 0; i < cases; i += 1) {
    fuzzCase = `random-${i}`
    const normalized = normalizeRuntimeVisionConfig(configValue())
    assert.ok(normalized && typeof normalized === 'object')
    assert.ok(Array.isArray(normalized.providers) && normalized.providers.length <= MAX_RUNTIME_PROVIDER_ROWS)
    assert.ok(Array.isArray(normalized.fallbacks) && normalized.fallbacks.length <= MAX_RUNTIME_FALLBACKS_PER_ROW)
    for (const row of normalized.providers) {
      assert.ok(typeof row.provider === 'string' && row.provider.length <= MAX_RUNTIME_MODEL_ID_CHARS)
      assert.ok(typeof row.model === 'string' && row.model.length <= MAX_RUNTIME_MODEL_ID_CHARS)
      assert.ok(Array.isArray(row.fallbacks) && row.fallbacks.length <= MAX_RUNTIME_FALLBACKS_PER_ROW)
    }

    const caps = normalizeDshHostCapabilities(configValue())
    for (const value of Object.values(caps)) assert.ok(value === true || value === false || value === 'unknown')

    const authority = resolveVisionRoutingAuthority(configValue())
    assert.ok(['ordered', 'auto'].includes(authority.execution))
    assert.ok(['off', 'local-free', 'all'].includes(authority.backgroundMeasurement))

    const affinity = pick([scalar(), text(700), 'session-123', ' x ', 'line\nbreak', '世界'])
    const wire = wireSessionAffinityId(affinity)
    if (wire !== undefined) {
      assert.equal(wire, String(affinity))
      assert.ok(wire.length <= 512)
      assert.match(wire, /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/)
    }
  }

  // Exercise the exact bounded extremes once instead of rebuilding an enormous
  // random shape thousands of times. Random cases search shape combinations; this
  // deterministic case proves the provider/fallback caps themselves.
  fuzzCase = 'boundary-config'
  const boundaryConfig = normalizeRuntimeVisionConfig({
    providers: Array.from({ length: MAX_RUNTIME_PROVIDER_ROWS + 16 }, (_, index) => ({
      provider: `provider-${index}`,
      model: `model-${index}`,
      fallbacks: Array.from(
        { length: MAX_RUNTIME_FALLBACKS_PER_ROW + 16 },
        (_, fallback) => `fallback-${fallback}`,
      ),
    })),
    fallbacks: Array.from(
      { length: MAX_RUNTIME_FALLBACKS_PER_ROW + 16 },
      (_, index) => `root-${index}`,
    ),
  })
  assert.equal(boundaryConfig.providers.length, MAX_RUNTIME_PROVIDER_ROWS)
  assert.equal(boundaryConfig.fallbacks.length, MAX_RUNTIME_FALLBACKS_PER_ROW)
  for (const row of boundaryConfig.providers) {
    assert.equal(row.fallbacks.length, MAX_RUNTIME_FALLBACKS_PER_ROW)
  }

  fuzzCase = 'diagnostic-redaction'
  const bearer = `Bearer ${'A'.repeat(48)}`
  const apiKey = `sk-proj-${'B'.repeat(32)}`
  const diagnostic = redactDiagnosticText(
    `Authorization: ${bearer} https://example.invalid/x?token=${apiKey} api_key=${apiKey}`,
    400,
  )
  assert.equal(diagnostic.includes('A'.repeat(48)), false)
  assert.equal(diagnostic.includes('B'.repeat(32)), false)
  assert.ok(diagnostic.length <= 400)

  fuzzCase = 'official-url-allowlist'
  for (const url of [
    'https://opencode.ai/zen/go',
    'https://opencode.ai/zen/go/v1',
  ]) assert.equal(isOfficialOpenCodeGoUrl(url), true)

  fuzzCase = 'official-url-denylist'
  for (const url of [
    'http://opencode.ai/zen/go',
    'https://opencode.ai.evil.example/zen/go',
    'https://evil.example/?next=https://opencode.ai/zen/go',
    'https://opencode.ai/zen/gopher',
    'not a url',
  ]) assert.equal(isOfficialOpenCodeGoUrl(url), false)
} catch (error) {
  console.error(`security adversarial fuzz failed: case=${fuzzCase} seed=${seed}`)
  console.error(`replay: ${replayCommand()}`)
  throw error
}

console.log(`security adversarial fuzz passed: cases=${cases} seed=${seed}`)

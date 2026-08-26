import assert from 'node:assert/strict'
import test from 'node:test'
import { autoExecutionConfigFor } from '../lib/vision-capability-shadow.js'
import { configuredVisionPairs } from '../lib/vision-routing-evidence.js'
import { executionOrderForSuggestedKeys } from '../lib/vision-execution-order-plan.js'

function legacyOrder(config, suggestedOrder) {
  const executionConfig = autoExecutionConfigFor(config, suggestedOrder)
  return executionConfig ? configuredVisionPairs(executionConfig) : undefined
}

const cases = [
  {
    name: 'reorders two configured native routes',
    config: {
      providers: [
        { provider: 'a', model: 'm1', fallbacks: [] },
        { provider: 'b', model: 'm2', fallbacks: [] },
      ],
    },
    suggested: ['b/m2', 'a/m1'],
  },
  {
    name: 'preserves a configured route omitted by evidence',
    config: {
      providers: [
        { provider: 'a', model: 'm1', fallbacks: [] },
        { provider: 'temporarily-unavailable', model: 'm2', fallbacks: [] },
        { provider: 'b', model: 'm3', fallbacks: [] },
      ],
    },
    suggested: ['b/m3', 'a/m1'],
  },
  {
    name: 'allows an already-enabled local backend to move ahead',
    config: {
      providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
    },
    suggested: ['vision-http/local-ollama/qwen2.5vl', 'custom/m'],
  },
  {
    name: 'does not synthesize arbitrary unconfigured discovered adapters',
    config: {
      providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
    },
    suggested: ['discovered/not-configured', 'custom/m'],
  },
  {
    name: 'does not synthesize arbitrary unconfigured direct HTTP routes',
    config: {
      providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
    },
    suggested: ['http:unconfigured/model', 'custom/m'],
  },
  {
    name: 'expands legacy fallback models and can reorder them',
    config: {
      providers: [
        { provider: 'a', model: 'primary', fallbacks: ['f1', 'f2'] },
        { provider: 'b', model: 'm', fallbacks: [] },
      ],
    },
    suggested: ['a/f2', 'b/m', 'a/primary', 'a/f1'],
  },
  {
    name: 'deduplicates repeated planner keys',
    config: {
      providers: [
        { provider: 'a', model: 'm1', fallbacks: [] },
        { provider: 'b', model: 'm2', fallbacks: [] },
      ],
    },
    suggested: ['b/m2', 'b/m2', 'a/m1'],
  },
  {
    name: 'returns no scope for unchanged configured order',
    config: {
      providers: [
        { provider: 'a', model: 'm1', fallbacks: [] },
        { provider: 'b', model: 'm2', fallbacks: [] },
      ],
    },
    suggested: ['a/m1', 'b/m2'],
  },
  {
    name: 'preserves vision-http candidate key mapping',
    config: {
      providers: [
        { provider: 'vision-http', model: 'ovh/qwen-vl', fallbacks: [] },
        { provider: 'custom', model: 'm', fallbacks: [] },
      ],
    },
    suggested: ['custom/m', 'http:ovh/qwen-vl'],
  },
]

for (const fixture of cases) {
  test(`explicit order mapping matches fake-settings path: ${fixture.name}`, () => {
    assert.deepEqual(
      executionOrderForSuggestedKeys(fixture.config, fixture.suggested),
      legacyOrder(fixture.config, fixture.suggested),
    )
  })
}

test('invalid mapping inputs remain a no-op like the legacy path', () => {
  assert.equal(executionOrderForSuggestedKeys(undefined, []), undefined)
  assert.equal(executionOrderForSuggestedKeys([], []), undefined)
  assert.equal(executionOrderForSuggestedKeys({}, 'not-an-array'), undefined)
})

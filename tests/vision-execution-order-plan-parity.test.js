import assert from 'node:assert/strict'
import test from 'node:test'
import { executionOrderForSuggestedKeys } from '../lib/vision-execution-order-plan.js'

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
    expected: [
      { provider: 'b', model: 'm2' },
      { provider: 'a', model: 'm1' },
    ],
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
    expected: [
      { provider: 'b', model: 'm3' },
      { provider: 'a', model: 'm1' },
      { provider: 'temporarily-unavailable', model: 'm2' },
    ],
  },
  {
    name: 'allows an already-enabled local backend to move ahead',
    config: {
      providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
    },
    suggested: ['vision-http/local-ollama/qwen2.5vl', 'custom/m'],
    expected: [
      { provider: 'vision-http', model: 'local-ollama/qwen2.5vl' },
      { provider: 'custom', model: 'm' },
    ],
  },
  {
    name: 'does not synthesize arbitrary unconfigured discovered adapters',
    config: {
      providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
    },
    suggested: ['discovered/not-configured', 'custom/m'],
    expected: undefined,
  },
  {
    name: 'does not synthesize arbitrary unconfigured direct HTTP routes',
    config: {
      providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
    },
    suggested: ['http:unconfigured/model', 'custom/m'],
    expected: undefined,
  },
  {
    name: 'expands configured fallback models and can reorder them',
    config: {
      providers: [
        { provider: 'a', model: 'primary', fallbacks: ['f1', 'f2'] },
        { provider: 'b', model: 'm', fallbacks: [] },
      ],
    },
    suggested: ['a/f2', 'b/m', 'a/primary', 'a/f1'],
    expected: [
      { provider: 'a', model: 'f2' },
      { provider: 'b', model: 'm' },
      { provider: 'a', model: 'primary' },
      { provider: 'a', model: 'f1' },
    ],
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
    expected: [
      { provider: 'b', model: 'm2' },
      { provider: 'a', model: 'm1' },
    ],
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
    expected: undefined,
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
    expected: [
      { provider: 'custom', model: 'm' },
      { provider: 'vision-http', model: 'ovh/qwen-vl' },
    ],
  },
]

for (const fixture of cases) {
  test(`explicit order mapping contract: ${fixture.name}`, () => {
    assert.deepEqual(
      executionOrderForSuggestedKeys(fixture.config, fixture.suggested),
      fixture.expected,
    )
  })
}

test('invalid mapping inputs remain a no-op', () => {
  assert.equal(executionOrderForSuggestedKeys(undefined, []), undefined)
  assert.equal(executionOrderForSuggestedKeys([], []), undefined)
  assert.equal(executionOrderForSuggestedKeys({}, 'not-an-array'), undefined)
})

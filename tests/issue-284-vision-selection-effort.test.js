import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapVisionPresentationSelection } from '../lib/vision-model-visibility-boundary.js'

function group(id, name, models) {
  return {
    id,
    name,
    models: models.map((model) => ({ id: model, name: model })),
  }
}

const groups = [
  group('alpha', 'Alpha', ['alpha-1', 'alpha-2']),
  group('alpha-vision', 'Alpha + 自动识图', ['alpha-1', 'alpha-2']),
  group('beta', 'Beta', ['shared-model']),
  group('beta-vision', 'Beta + 自动识图', ['shared-model']),
  group('gamma', 'Gamma', ['shared-model']),
  group('gamma-vision', 'Gamma + 自动识图', ['shared-model']),
]

const config = {
  autoWrapProviders: true,
  wrapperRoute: 'deepseek-vision',
}

function activeState() {
  return {
    current: {
      provider: 'alpha-vision',
      model: 'alpha-1',
      reasoningEffort: 'high',
    },
    groups,
  }
}

test('issue #284 changing model while Vision is on does not inherit the previous reasoning effort', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'beta', model: 'shared-model' },
    config,
  )

  assert.deepEqual(mapped, {
    provider: 'beta-vision',
    model: 'shared-model',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'reasoningEffort'), false)
})

test('issue #284 Provider Default semantics clear an old explicit reasoning effort', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'alpha', model: 'alpha-2' },
    config,
  )

  assert.deepEqual(mapped, {
    provider: 'alpha-vision',
    model: 'alpha-2',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'reasoningEffort'), false)
})

test('issue #284 an explicitly selected reasoning effort is preserved exactly across the route rewrite', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'beta', model: 'shared-model', reasoningEffort: 'low' },
    config,
  )

  assert.deepEqual(mapped, {
    provider: 'beta-vision',
    model: 'shared-model',
    reasoningEffort: 'low',
  })
})

test('issue #284 provider plus model identity wins when model ids collide across providers', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'gamma', model: 'shared-model' },
    config,
  )

  assert.equal(mapped.provider, 'gamma-vision')
  assert.equal(mapped.model, 'shared-model')
})

test('issue #284 selecting an already verified wrapper is idempotent', () => {
  const incoming = {
    provider: 'beta-vision',
    model: 'shared-model',
    reasoningEffort: 'low',
  }
  const mapped = mapVisionPresentationSelection(activeState(), incoming, config)

  assert.deepEqual(mapped, incoming)
})

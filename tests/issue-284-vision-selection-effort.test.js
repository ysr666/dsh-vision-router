import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mapVisionPresentationSelection } from '../lib/vision-model-visibility-boundary.js'
import { resolveVisionModePair } from '../lib/client-presentation-boundary.js'

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

test('issue #284 choosing another provider while Vision is on leaves the wrapper instead of inheriting the previous effort', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'beta', model: 'shared-model' },
    config,
  )

  assert.deepEqual(mapped, {
    provider: 'beta',
    model: 'shared-model',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'reasoningEffort'), false)
})

test('issue #284 choosing another model in the same provider leaves Vision and preserves Provider Default semantics', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'alpha', model: 'alpha-2' },
    config,
  )

  assert.deepEqual(mapped, {
    provider: 'alpha',
    model: 'alpha-2',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'reasoningEffort'), false)
})

test('issue #284 an explicitly selected effort on a different model is preserved while leaving Vision', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'beta', model: 'shared-model', reasoningEffort: 'low' },
    config,
  )

  assert.deepEqual(mapped, {
    provider: 'beta',
    model: 'shared-model',
    reasoningEffort: 'low',
  })
})

test('issue #284 exact source provider plus model identity wins when model ids collide', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'gamma', model: 'shared-model' },
    config,
  )

  assert.equal(mapped.provider, 'gamma')
  assert.equal(mapped.model, 'shared-model')
})

test('issue #284 effort-only edits on the projected current model stay on the hidden wrapper', () => {
  const mapped = mapVisionPresentationSelection(
    activeState(),
    { provider: 'alpha', model: 'alpha-1', reasoningEffort: 'low' },
    config,
  )

  assert.deepEqual(mapped, {
    provider: 'alpha-vision',
    model: 'alpha-1',
    reasoningEffort: 'low',
  })
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

test('issue #284 an ordinary provider whose id ends in -vision can still enable its own twin', () => {
  const suffixGroups = [
    group('studio-vision', 'Studio Vision', ['m']),
    group('studio-vision-vision', 'Studio Vision + 自动识图', ['m']),
  ]

  assert.deepEqual(resolveVisionModePair(
    suffixGroups,
    { provider: 'studio-vision', model: 'm', reasoningEffort: 'low' },
    { autoWrapProviders: true },
  ), {
    mode: 'off',
    target: {
      provider: 'studio-vision-vision',
      model: 'm',
      reasoningEffort: 'low',
    },
  })
})

test('issue #284 the -vision suffix chain still resolves back from the verified twin', () => {
  const suffixGroups = [
    group('studio-vision', 'Studio Vision', ['m']),
    group('studio-vision-vision', 'Studio Vision + 自动识图', ['m']),
  ]

  assert.deepEqual(resolveVisionModePair(
    suffixGroups,
    { provider: 'studio-vision-vision', model: 'm' },
    { autoWrapProviders: true },
  ), {
    mode: 'on',
    target: { provider: 'studio-vision', model: 'm' },
  })
})

test('issue #284 guide copy says a manual ordinary-model change turns Vision off', () => {
  const source = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(source.includes('手动切回普通模型'), true)
  assert.equal(source.includes('manually switch back to a normal model'), true)
  assert.equal(source.includes('切换聊天模型时也会继续保持识图模式'), false)
  assert.equal(source.includes('Changing chat models keeps Vision mode on'), false)
})

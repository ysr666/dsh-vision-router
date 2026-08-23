import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  VISION_MODEL_VISIBILITY_PRELUDE,
  mapVisionPresentationSelection,
} from '../lib/vision-model-visibility-boundary.js'
import { resolveVisionModePair } from '../lib/client-presentation-boundary.js'

const MODEL_SELECTION_TARGET = '@deepseek-ai/dsh-client-ui-model-selection'

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

function visibleDirectoryHarness(input, settingsValue) {
  let registered
  let visibleDirectory
  const loader = {
    load(spec) {
      registered = spec
      return spec
    },
  }
  vm.runInNewContext(VISION_MODEL_VISIBILITY_PRELUDE, {
    window: { __ModuleLoader__: loader },
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Math,
    JSON,
  })

  loader.load({
    id: MODEL_SELECTION_TARGET,
    factory() {
      return {
        apply(ctx) {
          ctx.inject(['modelDirectories'], (scope) => {
            visibleDirectory = scope.modelDirectories.directoryFor('session-1')
          })
        },
      }
    },
  })

  const rawDirectory = {
    store: {
      subscribe() { return () => {} },
      getSnapshot() { return input },
    },
    async load() { return input },
    async select() {},
  }
  const models = { directoryFor() { return rawDirectory } }
  const settings = {
    subscribe() { return () => {} },
    getSnapshot() { return { value: settingsValue } },
  }
  const plugin = registered.factory(() => ({}))
  plugin.apply({
    settingsScope: { bind() { return settings } },
    inject(_deps, callback) {
      callback({ modelDirectories: models, get() { return models } })
    },
  })
  return visibleDirectory
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

test('issue #284 blocked sticky-Vision model changes expose an error through the projected directory store', async () => {
  const input = {
    current: { provider: 'alpha-vision', model: 'alpha-1' },
    groups: [
      group('alpha', 'Alpha', ['alpha-1']),
      group('alpha-vision', 'Alpha + 自动识图', ['alpha-1']),
      group('plain', 'Plain', ['plain-1']),
    ],
    status: 'ready',
    error: null,
    failures: [],
    routable: true,
  }
  const visibleDirectory = visibleDirectoryHarness(input, {
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'alpha', models: [] }],
    wrapperRoute: 'deepseek-vision',
  })

  await assert.rejects(
    visibleDirectory.select({ provider: 'plain', model: 'plain-1' }),
    /识图模式/,
  )
  const visible = visibleDirectory.store.getSnapshot()
  assert.equal(visible.status, 'error')
  assert.match(visible.error, /识图模式已开启/)
  assert.equal(visible.current.provider, 'alpha')
})

test('issue #284 guide copy no longer claims that choosing a normal model disables sticky Vision mode', () => {
  const source = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(source.includes('手动切回普通模型'), false)
  assert.equal(source.includes('manually switch back to a normal model'), false)
  assert.match(source, /切换聊天模型时也会继续保持识图模式/)
  assert.match(source, /Changing chat models keeps Vision mode on/)
})

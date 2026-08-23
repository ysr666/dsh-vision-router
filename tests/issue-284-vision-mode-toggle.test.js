import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadClientBundle() {
  let spec = null
  globalThis.window = { __ModuleLoader__: { load(s) { spec = s } } }
  const url = new URL('../lib/client.js', import.meta.url)
  // eslint-disable-next-line no-eval
  ;(0, eval)(readFileSync(url, 'utf8'))
  const ReactStub = {
    useState: (initial) => [initial, () => {}],
    useMemo: (fn) => fn(),
    useSyncExternalStore: () => ({ status: 'ready', writable: true, value: {}, user: {} }),
  }
  return spec.factory((name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-ui-attachment') return { ImageGallery: () => null }
    throw new Error('require(' + name + ')')
  })
}

const groups = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    models: [
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
    ],
  },
  {
    id: 'opencode-go-vision',
    name: 'OpenCode Go + 自动识图',
    models: [
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
    ],
  },
]

test('issue #284 maps a normal selection to the matching generated vision twin', () => {
  const bundle = loadClientBundle()
  assert.deepEqual(bundle.resolveVisionModePair(groups, {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
    reasoningEffort: 'high',
  }), {
    mode: 'off',
    target: {
      provider: 'opencode-go-vision',
      model: 'qwen3.6-plus',
      reasoningEffort: 'high',
    },
  })
})

test('issue #284 maps a generated vision twin back to its source route', () => {
  const bundle = loadClientBundle()
  assert.deepEqual(bundle.resolveVisionModePair(groups, {
    provider: 'opencode-go-vision',
    model: 'minimax-m2.7',
  }), {
    mode: 'on',
    target: {
      provider: 'opencode-go',
      model: 'minimax-m2.7',
    },
  })
})

test('issue #284 refuses lookalike -vision providers not owned by the generated twin naming contract', () => {
  const bundle = loadClientBundle()
  const lookalike = [
    { id: 'third-party', name: 'Third Party', models: [{ id: 'm', name: 'M' }] },
    { id: 'third-party-vision', name: 'Third Party Vision Native', models: [{ id: 'm', name: 'M' }] },
  ]
  assert.deepEqual(bundle.resolveVisionModePair(lookalike, {
    provider: 'third-party',
    model: 'm',
  }), { mode: 'unavailable' })
})

test('issue #284 refuses a twin when that exact model is not mirrored', () => {
  const bundle = loadClientBundle()
  assert.deepEqual(bundle.resolveVisionModePair([
    { id: 'provider', name: 'Provider', models: [{ id: 'a', name: 'A' }] },
    { id: 'provider-vision', name: 'Provider + 自动识图', models: [{ id: 'b', name: 'B' }] },
  ], {
    provider: 'provider',
    model: 'a',
  }), { mode: 'unavailable' })
})

test('issue #284 is an explicit persistent model toggle with no send/image auto-reset hook', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("ctx.inject(['slots', 'modelDirectories']"), true)
  assert.equal(source.includes("scope.slots.inject('conversation.input.right'"), true)
  assert.equal(source.includes("id: 'vision-router-mode-toggle'"), true)
  assert.equal(source.includes('directory.select(pair.target)'), true)
  assert.equal(source.includes('resolveVisionModePair(state.groups, state.current)'), true)
})

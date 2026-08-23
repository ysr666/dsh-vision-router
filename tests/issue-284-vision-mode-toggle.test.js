import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CLIENT_PRESENTATION_PRELUDE,
  resolveVisionModePair,
} from '../lib/client-presentation-boundary.js'

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
  assert.deepEqual(resolveVisionModePair(groups, {
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
  assert.deepEqual(resolveVisionModePair(groups, {
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
  const lookalike = [
    { id: 'third-party', name: 'Third Party', models: [{ id: 'm', name: 'M' }] },
    { id: 'third-party-vision', name: 'Third Party Vision Native', models: [{ id: 'm', name: 'M' }] },
  ]
  assert.deepEqual(resolveVisionModePair(lookalike, {
    provider: 'third-party',
    model: 'm',
  }), { mode: 'unavailable' })
})

test('issue #284 refuses a twin when that exact model is not mirrored', () => {
  assert.deepEqual(resolveVisionModePair([
    { id: 'provider', name: 'Provider', models: [{ id: 'a', name: 'A' }] },
    { id: 'provider-vision', name: 'Provider + 自动识图', models: [{ id: 'b', name: 'B' }] },
  ], {
    provider: 'provider',
    model: 'a',
  }), { mode: 'unavailable' })
})

test('issue #284 preserves a falsy or empty reasoning effort exactly by omission', () => {
  assert.deepEqual(resolveVisionModePair(groups, {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
  }), {
    mode: 'off',
    target: {
      provider: 'opencode-go-vision',
      model: 'qwen3.6-plus',
    },
  })
})

test('issue #284 is an explicit persistent model toggle with no send/image auto-reset hook', () => {
  const source = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("ctx.inject(['slots', 'modelDirectories']"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("scope.slots.inject('conversation.input.right'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("id: 'vision-router-mode-toggle'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('directory.select(pair.target)'), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('resolveVisionModePair(state.groups, state.current)'), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("'aria-pressed': active"), true)
  assert.equal(source.includes('send-committed'), false)
  assert.equal(source.includes('conversation.input.attachments'), false)
  assert.equal(source.includes('imageIds'), false)
})

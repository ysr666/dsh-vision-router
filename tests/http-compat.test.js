import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HTTP_PROVIDER_COMPAT_PRESETS,
  appendPromptToImageOnlyMessage,
  fetchWithOpenAICompatibility,
  parseMaxTokensLimit,
  prepareOpenAICompatibleBody,
  resolveHttpProviderCompatibility,
  shouldUseMaxCompletionTokens,
} from '../lib/http-compat.js'
import { callOpenAICompatible, visionDescribePrompt } from '../index.js'

test('GLM-4V-Flash family preset caps output tokens without overriding stricter user values', () => {
  assert.ok(HTTP_PROVIDER_COMPAT_PRESETS.some((preset) => preset.id === 'glm-4v-flash-max-output'))
  assert.deepEqual(
    resolveHttpProviderCompatibility({ model: 'glm-4v-flash' }),
    {
      presetIds: ['glm-4v-flash-max-output'],
      maxTokensCap: 1024,
      tokenParameter: undefined,
    },
  )
  assert.equal(
    resolveHttpProviderCompatibility({ model: 'glm-4v-flash-202608' }).maxTokensCap,
    1024,
  )

  const capped = prepareOpenAICompatibleBody({ model: 'glm-4v-flash', max_tokens: 4096 })
  assert.equal(capped.body.max_tokens, 1024)
  assert.equal(capped.changed, true)

  const userStricter = prepareOpenAICompatibleBody({ model: 'glm-4v-flash', max_tokens: 768 })
  assert.equal(userStricter.body.max_tokens, 768)

  const unknown = prepareOpenAICompatibleBody({ model: 'future-vl-9000', max_tokens: 4096 })
  assert.equal(unknown.body.max_tokens, 4096)
  assert.equal(unknown.changed, false)
})

test('image-only OpenAI content receives the vision_describe question', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
    },
  ]
  const result = appendPromptToImageOnlyMessage(messages, 'What is shown?')
  assert.equal(result.changed, true)
  assert.deepEqual(result.messages[0].content.at(-1), {
    type: 'text',
    text: 'What is shown?',
  })
  // Do not duplicate a prompt when the request already carries text.
  const alreadyText = appendPromptToImageOnlyMessage(
    [{ role: 'user', content: [...messages[0].content, { type: 'text', text: 'existing' }] }],
    'duplicate',
  )
  assert.equal(alreadyText.changed, false)
})

test('structured vision_describe HTTP prompt preserves the JSON evidence contract', () => {
  const prompt = visionDescribePrompt('Read this UI', true)
  assert.match(prompt, /^Read this UI\n\n/)
  assert.match(prompt, /Return ONE JSON object/)
  assert.match(prompt, /"summary"/)
  assert.match(prompt, /Read this UI/)
})

test('blank vision_describe questions fall back to a non-empty strict-endpoint-safe prompt', () => {
  const textPrompt = visionDescribePrompt('   ', false)
  assert.match(textPrompt, /Describe the image accurately/)
  assert.ok(textPrompt.trim().length > 0)

  const jsonPrompt = visionDescribePrompt('', true)
  assert.match(jsonPrompt, /^Describe the image accurately/)
  assert.match(jsonPrompt, /Return ONE JSON object/)
})

test('max-token limit parser recognizes Zhipu and common English errors', () => {
  assert.equal(
    parseMaxTokensLimit('max_tokens参数非法：限制数值范围[1,1024]'),
    1024,
  )
  assert.equal(
    parseMaxTokensLimit('max_tokens must be less than or equal to 2048'),
    2048,
  )
  assert.equal(parseMaxTokensLimit('temperature 参数非法：限制数值范围[0,2]'), undefined)
  assert.equal(parseMaxTokensLimit('unrelated HTTP 400 code 1210'), undefined)
})

test('compat fetch retries once at a server-advertised max_tokens ceiling', async () => {
  const bodies = []
  const fakeFetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: 'max_tokens invalid; range [1,1536]' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const response = await fetchWithOpenAICompatibility(
    fakeFetch,
    'https://example.test/v1/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: 'unknown-new-vl',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        max_tokens: 4096,
        stream: false,
      }),
    },
    { active: true },
  )

  assert.equal(response.status, 200)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].max_tokens, 4096)
  assert.equal(bodies[1].max_tokens, 1536)
})

test('compat fetch applies the GLM preset before the first network attempt', async () => {
  const bodies = []
  const fakeFetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response('{}', { status: 200 })
  }

  await fetchWithOpenAICompatibility(
    fakeFetch,
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: 'glm-4v-flash',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
          },
        ],
        max_tokens: 4096,
        stream: false,
      }),
    },
    { active: true, prompt: 'Describe this image' },
  )

  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].max_tokens, 1024)
  assert.deepEqual(bodies[0].messages[0].content.at(-1), {
    type: 'text',
    text: 'Describe this image',
  })
})

test('callOpenAICompatible routes every direct provider through the preset layer', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body)
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const text = await callOpenAICompatible(
      {
        name: 'glm',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4v-flash',
        apiKeyEnv: '',
      },
      [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
      { maxTokens: 4096 },
    )
    assert.equal(text, 'OK')
    assert.equal(captured.max_tokens, 1024)
  } finally {
    globalThis.fetch = original
  }
})

test('compat fetch can migrate max_tokens when a server explicitly asks for max_completion_tokens', async () => {
  assert.equal(
    shouldUseMaxCompletionTokens(
      "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
    ),
    true,
  )
  const bodies = []
  const fakeFetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200 })
  }

  const response = await fetchWithOpenAICompatibility(
    fakeFetch,
    'https://example.test/v1/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: 'future-reasoning-vision',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        max_tokens: 2048,
        stream: false,
      }),
    },
    { active: true },
  )

  assert.equal(response.status, 200)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1].max_tokens, undefined)
  assert.equal(bodies[1].max_completion_tokens, 2048)
})

test('compat fetch resolves sequential parameter migration and token-cap errors without looping', async () => {
  const bodies = []
  const fakeFetch = async (_input, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    if (bodies.length === 2) {
      return new Response(
        JSON.stringify({ error: { message: 'max_completion_tokens must be at most 1024 tokens' } }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200 })
  }

  const response = await fetchWithOpenAICompatibility(
    fakeFetch,
    'https://example.test/v1/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: 'future-combined-quirks-vl',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        max_tokens: 4096,
        stream: false,
      }),
    },
    { active: true },
  )

  assert.equal(response.status, 200)
  assert.equal(bodies.length, 3)
  assert.equal(bodies[1].max_tokens, undefined)
  assert.equal(bodies[1].max_completion_tokens, 4096)
  assert.equal(bodies[2].max_completion_tokens, 1024)
})

test('compat fetch is inert when explicitly disabled', async () => {
  let body
  const fakeFetch = async (_input, init) => {
    body = JSON.parse(init.body)
    return new Response('{}', { status: 200 })
  }
  await fetchWithOpenAICompatibility(
    fakeFetch,
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({ model: 'glm-4v-flash', messages: [], max_tokens: 4096 }),
    },
    { active: false },
  )
  assert.equal(body.max_tokens, 4096)
})

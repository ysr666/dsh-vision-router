import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HTTP_ERROR_DETAIL_MAX_BYTES,
  HTTP_PROVIDER_COMPAT_PRESETS,
  appendPromptToImageOnlyMessage,
  fetchWithOpenAICompatibility,
  parseMaxTokensLimit,
  prepareOpenAICompatibleBody,
  readResponseTextLimited,
  resolveHttpProviderCompatibility,
  shouldUseMaxCompletionTokens,
} from '../lib/http-compat.js'
import { callOpenAICompatible, visionDescribePrompt } from '../index.js'

test('GLM-4V-Flash proactive cap belongs to the evidence-backed official endpoint (#53)', () => {
  assert.ok(HTTP_PROVIDER_COMPAT_PRESETS.some((rule) => rule.id === 'glm-4v-flash-max-output'))
  const official = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  assert.deepEqual(
    resolveHttpProviderCompatibility({ model: 'glm-4v-flash', url: official }),
    {
      presetIds: ['glm-4v-flash-max-output'],
      maxTokensCap: 1024,
      tokenParameter: undefined,
    },
  )
  assert.equal(
    resolveHttpProviderCompatibility({ model: 'glm-4v-flash-202608', url: official }).maxTokensCap,
    1024,
  )
  const capped = prepareOpenAICompatibleBody(
    { model: 'glm-4v-flash', max_tokens: 4096 },
    { url: official },
  )
  assert.equal(capped.body.max_tokens, 1024)
  assert.equal(capped.changed, true)
  const stricter = prepareOpenAICompatibleBody(
    { model: 'glm-4v-flash', max_tokens: 768 },
    { url: official },
  )
  assert.equal(stricter.body.max_tokens, 768)

  // An unscoped model name alone cannot grant authority to rewrite a user's
  // arbitrary Host-configured endpoint; HTTP error evidence remains available.
  const arbitrary = [
    undefined,
    'https://custom.example/v1/chat/completions',
    'https://notopen.bigmodel.cn/api/paas/v4/chat/completions',
    'https://open.bigmodel.cn.evil.test/api/paas/v4/chat/completions',
    'http://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://open.bigmodel.cn:444/api/paas/v4/chat/completions',
    'https://open.bigmodel.cn/api/paas/v3/chat/completions',
    'https://open.bigmodel.cn/api/paas/v4/chat/completions?switch=on',
    'https://user@open.bigmodel.cn/api/paas/v4/chat/completions',
  ]
  for (const url of arbitrary) {
    const actual = prepareOpenAICompatibleBody(
      { model: 'glm-4v-flash', max_tokens: 4096 }, { url },
    )
    assert.equal(actual.body.max_tokens, 4096, `unexpected cap at ${String(url)}`)
    assert.equal(actual.changed, false)
    assert.deepEqual(actual.presetIds, [])
  }

  const unknown = prepareOpenAICompatibleBody(
    { model: 'future-vl-9000', max_tokens: 4096 }, { url: official },
  )
  assert.equal(unknown.body.max_tokens, 4096)
  assert.equal(unknown.changed, false)
})

test('custom GLM-named HTTP endpoint keeps its own token authority and can report a bounded cap', async () => {
  const requests = []
  const endpoint = 'https://relay.example/v1/chat/completions'
  const result = await fetchWithOpenAICompatibility(async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: { message: 'max_tokens must be at most 1536 tokens' },
      }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200 })
  }, endpoint, {
    method: 'POST',
    body: JSON.stringify({ model: 'glm-4v-flash', messages: [
      { role: 'user', content: [{ type: 'text', text: 'Describe' }] },
    ], max_tokens: 4096 }),
  }, { active: true })
  assert.equal(result.status, 200)
  assert.deepEqual(requests.map((body) => body.max_tokens), [4096, 1536])
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
  // Regression: the older fallback extracted the lower bound (1), not the cap.
  assert.equal(parseMaxTokensLimit('max_tokens must be between 1 and 1024'), 1024)
  assert.equal(parseMaxTokensLimit('max_tokens must be in [1, 2048]'), 2048)
  assert.equal(parseMaxTokensLimit('max_completion_tokens should be in the range [1, 3072]'), 3072)
  assert.equal(parseMaxTokensLimit('max_tokens must be from 1 to 512'), 512)
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

test('compat fetch retries at the upper end of a 400 two-sided token range', async () => {
  const bodies = []
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'max_tokens must be between 1 and 1024' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const response = await fetchWithOpenAICompatibility(
    fetchImpl,
    'https://example.test/v1/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: 'unknown-vl',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
        max_tokens: 4096,
        stream: false,
      }),
    },
    { active: true },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(bodies.map((body) => body.max_tokens), [4096, 1024])
})

test('max-token limit parser prefers the advertised ceiling over the request value it just rejected', () => {
  // A 400 body that names the field, echoes the rejected value, and then states
  // the real cap must resolve to the cap. The older `max` heuristic grabbed the
  // offending number (which sits right after `max_tokens`), leaving the retry
  // a no-op and the 400 uncorrected.
  assert.equal(
    parseMaxTokensLimit('max_tokens is too large: 4096. This model supports at most 1536 completion tokens.'),
    1536,
  )
  assert.equal(
    parseMaxTokensLimit('max_tokens=4096 is greater than the maximum 1024'),
    1024,
  )
  // A bare field-name mention with only one adjacent number keeps working.
  assert.equal(parseMaxTokensLimit('max_tokens must be at most 2048'), 2048)
  assert.equal(parseMaxTokensLimit('the maximum allowed value for max_tokens is 512'), 512)
})

test('compat fetch retries at the advertised ceiling when a 400 also echoes the rejected max_tokens', async () => {
  const bodies = []
  const fakeFetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              'max_tokens is too large: 4096. This model supports at most 1536 completion tokens.',
          },
        }),
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
        messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
        max_tokens: 4096,
        stream: false,
      }),
    },
    { active: true },
  )

  assert.equal(response.status, 200)
  assert.equal(bodies.length, 2, 'a corrective retry must actually fire')
  assert.deepEqual(bodies.map((body) => body.max_tokens), [4096, 1536])
})

test('max-token limit parser reads a Chinese stated ceiling, not the echoed rejected value', () => {
  // Synthetic representative Chinese wording (NOT the #716 reporter's body).
  // The Chinese upper-bound pattern only recognized 上限/最大, so 最多支持/至多
  // fell through to the generic field-name heuristic and returned the value the
  // request had already been told was too large.
  assert.equal(
    parseMaxTokensLimit('max_tokens=4096 超过限制；当前模型最多支持 1536 个输出 token'),
    1536,
  )
  assert.equal(
    parseMaxTokensLimit('max_completion_tokens 传入 4096，模型最多支持 1536 个输出 token'),
    1536,
  )
  assert.equal(parseMaxTokensLimit('max_tokens 当前 4096 超过限制，请设置至多 1024'), 1024)
  // Existing Chinese ceiling words keep working unchanged.
  assert.equal(parseMaxTokensLimit('max_tokens 上限 4096'), 4096)
  assert.equal(parseMaxTokensLimit('最大输出 token 为 2048'), 2048)
})

test('compat fetch retries at a Chinese advertised ceiling over the echoed rejected value', async () => {
  const bodies = []
  const fakeFetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({
          error: { message: 'max_tokens=4096 超过限制；当前模型最多支持 1536 个输出 token' },
        }),
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
        messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
        max_tokens: 4096,
        stream: false,
      }),
    },
    { active: true },
  )
  assert.equal(response.status, 200)
  assert.equal(bodies.length, 2, 'Chinese ceiling must trigger one corrective retry')
  assert.deepEqual(bodies.map((body) => body.max_tokens), [4096, 1536])
})

test('max-token limit parser ignores image-count and pixel-dimension numbers (synthetic, not #716 evidence)', () => {
  // These 400 bodies describe a limit on the *input images* (count or pixel
  // dimension), not the output-token ceiling. Reading that number as a token cap
  // would shrink max_tokens to a nonsense value. Every ceiling word here binds to
  // a non-token unit, so the parser must not return that unit's number.
  assert.notEqual(parseMaxTokensLimit('max_tokens=4096; request body contains at most 4 images'), 4)
  assert.notEqual(parseMaxTokensLimit('max_tokens=4096，最多支持 2 张图片'), 2)
  assert.notEqual(parseMaxTokensLimit('max_tokens=4096; invalid image dimensions, maximum 2048 pixels'), 2048)
  // The generic field-name fallback must also not grab an image count that sits
  // right after the field name with no other number in range.
  assert.notEqual(parseMaxTokensLimit('max_tokens with 5 images'), 5)
  // A genuine token ceiling stated alongside image-count wording must still win,
  // resolved to the token number rather than the image/pixel number.
  assert.equal(
    parseMaxTokensLimit('max_tokens too large; supports at most 1536 tokens; the model accepts at most 30 images'),
    1536,
  )
  assert.equal(
    parseMaxTokensLimit('max_tokens invalid; 请求最多包含 4 张图片；输出 token 上限为 2048'),
    2048,
  )
})

test('compat fetch must not downshift max_tokens to an image-count or pixel limit', async () => {
  const bodies = []
  const fakeFetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(
      JSON.stringify({ error: { message: 'max_tokens=4096; request body contains at most 4 images' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }

  const response = await fetchWithOpenAICompatibility(
    fakeFetch,
    'https://example.test/v1/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: 'unknown-new-vl',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
        max_tokens: 4096,
        stream: false,
      }),
    },
    { active: true },
  )

  // The advertised "4 images" is not a token cap, so no corrective downshift may
  // fire; the request must stay at 4096 and the 400 must be surfaced unchanged.
  assert.equal(response.status, 400)
  assert.equal(bodies.length, 1, 'a non-token image limit must not trigger a retry')
  assert.deepEqual(bodies.map((body) => body.max_tokens), [4096])
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

test('bounded compatibility detail reader refuses declared oversized bodies without consuming the original response', async () => {
  const body = 'x'.repeat(DEFAULT_HTTP_ERROR_DETAIL_MAX_BYTES + 2048)
  const response = new Response(body, {
    status: 400,
    headers: { 'content-length': String(Buffer.byteLength(body)) },
  })
  assert.equal(await readResponseTextLimited(response), '')
  assert.equal((await response.text()).length, body.length, 'original response must remain untouched')
})

test('oversized compatibility error cannot trigger a retry from text beyond the byte budget', async () => {
  const bodies = []
  const huge =
    'x'.repeat(DEFAULT_HTTP_ERROR_DETAIL_MAX_BYTES + 1024) +
    ' max_tokens must be less than or equal to 1024'
  const fakeFetch = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(huge, {
      status: 400,
      headers: { 'content-length': String(Buffer.byteLength(huge)) },
    })
  }

  const response = await fetchWithOpenAICompatibility(
    fakeFetch,
    'https://example.test/v1/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({ model: 'future-vl', messages: [], max_tokens: 4096 }),
    },
    { active: true },
  )
  assert.equal(response.status, 400)
  assert.equal(bodies.length, 1)
  assert.equal((await response.text()).length, huge.length)
})


test('batch3: bounded HTTP body reader counts streamed bytes and declared length', async () => {
  const {
    readResponseJsonBounded,
  } = await import('../lib/http-body-limit.js')

  const declared = new Response('{"ok":true}', {
    headers: { 'content-length': '999999' },
  })
  await assert.rejects(
    readResponseJsonBounded(declared, 1024, { label: 'declared test' }),
    (error) => error && error.code === 'HTTP_RESPONSE_TOO_LARGE',
  )

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(800))
      controller.enqueue(new Uint8Array(800))
      controller.close()
    },
  })
  const streamed = new Response(stream)
  await assert.rejects(
    readResponseJsonBounded(streamed, 1024, { label: 'stream test' }),
    (error) => error && error.code === 'HTTP_RESPONSE_TOO_LARGE',
  )
})

test('OVH VLM total JSON byte budget blocks oversized image bodies before provider egress (#716)', async () => {
  const ovh = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions'
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), size: Buffer.byteLength(init.body, 'utf8') })
    return new Response('{}', { status: 200 })
  }
  const request = (base64Images, text = 'Look') => ({
    method: 'POST',
    body: JSON.stringify({
      model: 'Qwen3.5-397B-A17B',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text },
          ...base64Images.map((base64) => ({
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,' + base64 },
          })),
        ],
      }],
    }),
  })
  const large = 'A'.repeat(10_000_000)
  const assertBlocked = async (images, text) => {
    const before = calls.length
    await assert.rejects(
      fetchWithOpenAICompatibility(fakeFetch, ovh, request(images, text), { active: true }),
      (error) => {
        assert.equal(error.code, 'INVALID_REQUEST')
        assert.match(error.message, /OVHcloud VLM request is \d+ bytes/)
        assert.match(error.message, /10 MB JSON payload limit/)
        assert.equal(error.message.includes('data:image/'), false, 'no private image bytes in diagnosis')
        return true
      },
    )
    assert.equal(calls.length, before, 'oversized request must never consume a network attempt')
  }
  await assertBlocked([large])
  await assertBlocked(['A'.repeat(6_000_000), 'A'.repeat(6_000_000)])
  // A small image is sent verbatim and no quality or metadata is rewritten.
  const small = request(['AA=='], '中文识别')
  const ok = await fetchWithOpenAICompatibility(fakeFetch, ovh, small, { active: true })
  assert.equal(ok.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].size, Buffer.byteLength(small.body, 'utf8'))
  // No accidental hostname-suffix match; unrelated providers retain their wire.
  await fetchWithOpenAICompatibility(fakeFetch, 'https://oai.endpoints.kepler.ai.cloud.ovh.net.evil.example/v1/chat/completions',
    request([large]), { active: true })
  await fetchWithOpenAICompatibility(fakeFetch, 'https://user-vision.example/v1/chat/completions',
    request([large]), { active: true })
  assert.equal(calls.length, 3)
})

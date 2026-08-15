import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  mediaTypeOf,
  sniffMediaType,
  boxesToSvg,
  annotateBoxesBuffer,
  visionDetectInstruction,
  describeStructuredInstruction,
  normalizeDetectResult,
  normalizeDescribeResult,
  posterizeSvgColor,
  basenameOf,
  blocksHaveImage,
  eventHasImage,
  classifyFailure,
  createChunkAssembler,
  providersOf,
  rewriteImageBlocks,
  rewriteImagesDeep,
  extractJson,
  createCache,
  downscaleImage,
  toOpenAIContent,
  toRealPath,
  callOpenAICompatible,
  cacheKeyFor,
  adapterAvailable,
  httpProvidersOf,
  DEFAULT_HTTP_PROVIDERS,
  reverseRouteTarget,
  stripImageBlocks,
  replaceImageBlocksWithMemory,
  rewriteHistoryImages,
  dedupeHttpProviders,
  collectImageBlocks,
  lastUserText,
  switchRoute,
  hostMatchesAny,
  DEFAULT_PROXY_HOSTS,
  launchEnvironmentLike,
  createNativeDeepSeekAdapter,
  createStealthAdapter,
  modelInfoAcceptsImages,
  estimateTokens,
  estimateMessages,
  trimMessagesToBudget,
  parseBox,
  longOcrWindows,
  computePixelDiff,
  renderDiffHeatmap,
  quantizeColors,
  boxToSvg,
  floodFillBackground,
  bitmapOfGray,
  posterizeSvg,
  apply,
  Config,
} from '../index.js'

test('sniffMediaType detects formats from magic bytes', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex')
  assert.equal(sniffMediaType(png), 'image/png')
  const jpeg = Buffer.from('ffd8ffe000104a464946000101000001', 'hex')
  assert.equal(sniffMediaType(jpeg), 'image/jpeg')
  const webp = Buffer.from('524946461200000057454250565038', 'hex')
  assert.equal(sniffMediaType(webp), 'image/webp')
  const gif = Buffer.from('474946383961000000000000000000', 'hex')
  assert.equal(sniffMediaType(gif), 'image/gif')
  assert.equal(sniffMediaType(Buffer.from('000102030405060708090a0b', 'hex')), undefined)
  assert.equal(sniffMediaType(Buffer.alloc(4)), undefined)
})

test('modelInfoAcceptsImages requires an explicit image modality', () => {
  assert.equal(modelInfoAcceptsImages({ inputModalities: ['text', 'image'] }), true)
  assert.equal(modelInfoAcceptsImages({ inputModalities: ['text'] }), false)
  assert.equal(modelInfoAcceptsImages({}), false)
  assert.equal(modelInfoAcceptsImages(undefined), false)
})

test('mediaTypeOf maps extensions', () => {
  assert.equal(mediaTypeOf('/a/b.PNG'), 'image/png')
  assert.equal(mediaTypeOf('x.jpeg'), 'image/jpeg')
  assert.equal(mediaTypeOf('x.jpg'), 'image/jpeg')
  assert.equal(mediaTypeOf('x.webp'), 'image/webp')
  assert.equal(mediaTypeOf('x.gif'), 'image/gif')
  assert.equal(mediaTypeOf('x.tiff'), undefined)
  assert.equal(mediaTypeOf('x.heic'), undefined)
  assert.equal(mediaTypeOf('noext'), undefined)
})

test('basenameOf returns the last path segment', () => {
  assert.equal(basenameOf('/a/b/c.png'), 'c.png')
  assert.equal(basenameOf('c.png'), 'c.png')
})

test('blocksHaveImage detects image blocks and nested tool results', () => {
  assert.equal(blocksHaveImage([]), false)
  assert.equal(blocksHaveImage([{ type: 'text', text: 'hi' }]), false)
  assert.equal(blocksHaveImage([{ type: 'image' }]), true)
  assert.equal(blocksHaveImage([{ type: 'tool-result', content: [{ type: 'image' }] }]), true)
  assert.equal(
    blocksHaveImage([{ type: 'tool-result', content: [{ type: 'text', text: 'nope' }] }]),
    false,
  )
  assert.equal(blocksHaveImage('not an array'), false)
  assert.equal(blocksHaveImage(undefined), false)
})

test('eventHasImage scans the three known event shapes', () => {
  assert.equal(eventHasImage({ data: { content: [{ type: 'image' }] } }), true)
  assert.equal(eventHasImage({ data: { message: { content: [{ type: 'image' }] } } }), true)
  assert.equal(
    eventHasImage({ data: { inserted: [{ content: [{ type: 'text', text: 'x' }] }] } }),
    false,
  )
  assert.equal(eventHasImage({ data: { inserted: [{ content: [{ type: 'image' }] }] } }), true)
  assert.equal(eventHasImage({ data: {} }), false)
  assert.equal(eventHasImage({}), false)
  assert.equal(eventHasImage(undefined), false)
})

test('classifyFailure recognizes the provider failure vocabulary', () => {
  assert.equal(classifyFailure('This model is not available in your region.'), 'region')
  assert.equal(
    classifyFailure('The request is prohibited due to a violation of provider Terms Of Service.'),
    'tos',
  )
  assert.equal(classifyFailure('Insufficient credits: balance 0'), 'quota')
  assert.equal(classifyFailure('402 Payment Required'), 'quota')
  assert.equal(classifyFailure('429 rate limited'), 'rate-limit')
  assert.equal(classifyFailure('fetch failed ECONNREFUSED'), 'network')
  assert.equal(classifyFailure('something entirely different'), 'other')
})

test('chunk assembler builds text from the raw chunk protocol', () => {
  const a = createChunkAssembler()
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'hel' })
  a.push({ type: 'text-delta', index: 0, text: 'lo' })
  a.push({ type: 'block-start', index: 1, blockType: 'reasoning' })
  a.push({ type: 'reasoning-delta', index: 1, text: 'ignored' })
  a.push({ type: 'usage', usage: {} })
  a.push({ type: 'finish', reason: { kind: 'stop' } })
  assert.equal(a.finish(), 'hello')
})

test('chunk assembler keeps partial text on max-tokens', () => {
  const a = createChunkAssembler()
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'partial' })
  a.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(a.finish(), 'partial')
})

test('chunk assembler throws the failure message carried by the finish chunk', () => {
  const a = createChunkAssembler()
  a.push({
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'Insufficient credits', code: 'QUOTA' } },
  })
  assert.throws(() => a.finish(), /Insufficient credits/)
})

test('chunk assembler throws on unexpected finish kinds', () => {
  const a = createChunkAssembler()
  a.push({ type: 'finish', reason: { kind: 'weird' } })
  assert.throws(() => a.finish(), /weird/)
})

test('chunk assembler ignores unknown chunk types and malformed chunks', () => {
  const a = createChunkAssembler()
  a.push(null)
  a.push({ type: 'mystery' })
  a.push({})
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'ok' })
  a.push({ type: 'finish', reason: undefined })
  assert.equal(a.finish(), 'ok')
})

test('providersOf flattens the single-provider shorthand', () => {
  assert.deepEqual(
    providersOf({ provider: 'openrouter', model: 'm1', fallbacks: ['m2'] }),
    [
      { provider: 'openrouter', model: 'm1' },
      { provider: 'openrouter', model: 'm2' },
    ],
  )
  assert.deepEqual(providersOf({}), [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B' }])
})

test('providersOf flattens the multi-provider form and prefers it', () => {
  assert.deepEqual(
    providersOf({
      provider: 'ignored',
      model: 'ignored',
      providers: [
        { provider: 'p1', model: 'a', fallbacks: ['b'] },
        { provider: 'p2', model: 'c' },
      ],
    }),
    [
      { provider: 'p1', model: 'a' },
      { provider: 'p1', model: 'b' },
      { provider: 'p2', model: 'c' },
    ],
  )
})

test('rewriteImageBlocks replaces image blocks with attachment markers', () => {
  const ref = { attachmentId: 'att-1', mediaType: 'image/png' }
  const { messages, attachments } = rewriteImageBlocks([
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }] },
  ])
  assert.equal(messages[0].content[0].type, 'text')
  assert.match(messages[0].content[1].text, /att-1/)
  assert.match(messages[0].content[1].text, /vision_describe/)
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0], ref)
})

test('rewriteImageBlocks leaves image-less messages untouched', () => {
  const input = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const { messages, attachments } = rewriteImageBlocks(input)
  assert.equal(messages, input)
  assert.equal(attachments.length, 0)
})

test('extractJson tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('here you go: [1,2,3] trailing'), [1, 2, 3])
  assert.equal(extractJson('no json here'), undefined)
  assert.equal(extractJson(''), undefined)
})

test('createCache applies TTL and LRU eviction', async () => {
  const cache = createCache(2, 50)
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('c'), undefined)
  assert.equal(cache.size, 0)
})

test('createCache with ttl 0 keeps entries forever', () => {
  const cache = createCache(10, 0)
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
})

test('downscaleImage shrinks oversized images and keeps small ones', async () => {
  const big = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  const shrunk = await downscaleImage(big, 8000000)
  assert.ok(shrunk.length > 0)
  assert.ok(shrunk.length < big.length)
  const meta = await sharp(shrunk).metadata()
  assert.ok(meta.width * meta.height <= 8000000)

  const small = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  assert.equal(await downscaleImage(small, 8000000), small)
})

test('downscaleImage returns original bytes for corrupt input', async () => {
  const bytes = Buffer.from('not an image')
  assert.equal(await downscaleImage(bytes, 8000000), bytes)
})

test('toOpenAIContent converts harness blocks to OpenAI wire content', () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png' }
  const blocks = [
    { type: 'image', attachment: ref },
    { type: 'text', text: 'describe' },
  ]
  const content = toOpenAIContent(blocks, () => Buffer.from('PNGBYTES'))
  assert.equal(content[0].type, 'image_url')
  assert.equal(
    content[0].image_url.url,
    `data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`,
  )
  assert.deepEqual(content[1], { type: 'text', text: 'describe' })
})

test('callOpenAICompatible posts keyless when apiKeyEnv is empty', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const text = await callOpenAICompatible(
      { name: 't', baseURL: 'https://example.com/v1/', model: 'm' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    )
    assert.equal(text, 'OK')
    assert.equal(captured.url, 'https://example.com/v1/chat/completions')
    assert.equal(captured.init.headers.authorization, undefined)
    assert.equal(JSON.parse(captured.init.body).stream, false)
  } finally {
    globalThis.fetch = original
  }
})

test('callOpenAICompatible surfaces non-ok responses as errors', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('{"message":"quota"}', { status: 402, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      () =>
        callOpenAICompatible(
          { name: 't', baseURL: 'https://example.com/v1', model: 'm' },
          [{ role: 'user', content: [] }],
        ),
      /402/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test('callOpenAICompatible retries once after a 429 rate limit', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const text = await callOpenAICompatible(
      { name: 't', baseURL: 'https://example.com/v1', model: 'm' },
      [{ role: 'user', content: [] }],
    )
    assert.equal(text, 'OK')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = original
  }
})

test('adapterAvailable reports registered adapters only', () => {
  const llm = {
    registration(provider) {
      if (provider === 'nope') throw new Error('NO_ADAPTER')
      return {}
    },
  }
  assert.equal(adapterAvailable(llm, 'openrouter'), true)
  assert.equal(adapterAvailable(llm, 'nope'), false)
})

test('cacheKeyFor covers chains, content, mode and question', () => {
  const base = {
    pairs: [{ provider: 'p', model: 'm' }],
    httpProviders: [{ name: 'ovh', model: 'qwen' }],
    contentIds: ['b', 'a'],
    wantJson: false,
    question: 'q',
  }
  const k1 = cacheKeyFor(base)
  assert.equal(k1, 'p:m,http:ovh/qwen|a,b|text|q')
  assert.equal(cacheKeyFor({ ...base, wantJson: true }), 'p:m,http:ovh/qwen|a,b|json|q')
  assert.equal(cacheKeyFor({ ...base, httpProviders: [] }), 'p:m|a,b|text|q')
  assert.equal(cacheKeyFor({ ...base, contentIds: ['b'] }), 'p:m,http:ovh/qwen|b|text|q')
})

test('httpProvidersOf falls back to the built-in default unless disabled', () => {
  assert.equal(httpProvidersOf({}), DEFAULT_HTTP_PROVIDERS)
  assert.deepEqual(httpProvidersOf({}, false), [])
  const custom = [{ name: 'x', baseURL: 'https://x/v1', model: 'm' }]
  assert.deepEqual(httpProvidersOf({ httpProviders: custom }), custom)
  assert.deepEqual(httpProvidersOf({ httpProviders: custom }, false), custom)
})

test('dedupeHttpProviders also drops entries duplicating a chain provider name', () => {
  const http = [{ name: 'zhipu', baseURL: 'https://x/v1', model: 'glm-4v-flash' }]
  // a pair already covers provider zhipu through the adapter
  assert.deepEqual(
    dedupeHttpProviders([{ provider: 'zhipu', model: 'glm-4.6v-flash' }], http),
    [],
  )
  // an unrelated provider name keeps the http entry
  assert.equal(
    dedupeHttpProviders([{ provider: 'openrouter', model: 'qwen' }], http).length,
    1,
  )
})

test('dedupeHttpProviders drops only entries the vision-http chain covers', () => {
  // The default chain pair names the default OVH entry: the tool fallback must
  // drop it (never ask the free endpoint twice), while the RAW list feeding
  // the vision-http route keeps it so the pair has an adapter at all.
  const pairs = [{ provider: 'vision-http', model: 'ovh/Qwen2.5-VL-72B-Instruct' }]
  const raw = httpProvidersOf({})
  const deduped = dedupeHttpProviders(pairs, raw)
  assert.ok(raw.length > 0)
  assert.equal(raw.some((p) => `${p.name}/${p.model}` === 'ovh/Qwen2.5-VL-72B-Instruct'), true)
  assert.equal(deduped.some((p) => `${p.name}/${p.model}` === 'ovh/Qwen2.5-VL-72B-Instruct'), false)
  const unrelated = [{ name: 'ovh', baseURL: 'x', model: 'Other-VL' }]
  assert.equal(dedupeHttpProviders(pairs, unrelated).length, 1)
})

test('reverseRouteTarget rewrites vision-entry text turns back to the text provider', () => {
  const opts = {
    pairs: [{ provider: 'openrouter', model: 'qwen-vl' }],
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    hasAdapter: (provider) => provider === 'deepseek-official',
  }
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, opts),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
  // already on the text provider — untouched
  assert.equal(
    reverseRouteTarget({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, opts),
    undefined,
  )
  // a non-vision provider must never be hijacked
  assert.equal(reverseRouteTarget({ provider: 'some-other', model: 'x' }, opts), undefined)
  // text provider without an adapter — fall through untouched
  assert.equal(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, {
      ...opts,
      hasAdapter: () => false,
    }),
    undefined,
  )
})

test('switchRoute drops reasoningEffort and keeps the rest', () => {
  assert.deepEqual(
    switchRoute({ provider: 'a', model: 'm', reasoningEffort: 'max', maxTokens: 4096 }, 'b', 'n'),
    { provider: 'b', model: 'n', maxTokens: 4096 },
  )
  assert.deepEqual(switchRoute({ provider: 'a', model: 'm' }, 'b', 'n'), { provider: 'b', model: 'n' })
})

test('reverseRouteTarget keeps wrapper entries native and routes vision entries through the wrapper', () => {
  const base = {
    pairs: [{ provider: 'openrouter', model: 'qwen-vl' }],
    wrapperRoute: 'deepseek-vision',
    wrapperRegistered: true,
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    hasAdapter: () => true,
  }
  // wrapper entry handles text natively (strips images) — no rewrite
  assert.equal(
    reverseRouteTarget({ provider: 'deepseek-vision', model: 'deepseek-v4-pro' }, base),
    undefined,
  )
  // openrouter entry -> text turns go through the wrapper (strips + delegates)
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, base),
    { provider: 'deepseek-vision', model: 'deepseek-v4-pro' },
  )
  // wrapper disabled -> fall back to the text provider directly
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, {
      ...base,
      wrapperRoute: undefined,
      wrapperRegistered: false,
    }),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
  // non-vision providers are never hijacked
  assert.equal(
    reverseRouteTarget({ provider: 'some-other', model: 'x' }, base),
    undefined,
  )
})

test('stripImageBlocks removes image blocks and leaves the rest', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: 'a' } }] },
    { role: 'user', content: [{ type: 'text', text: 'plain' }] },
  ]
  const out = stripImageBlocks(messages)
  assert.equal(out[0].content.length, 1)
  assert.equal(out[0].content[0].type, 'text')
  assert.equal(out[1], messages[1])
  assert.deepEqual(stripImageBlocks(undefined), [])
})

test('estimateTokens and trimMessagesToBudget fit long conversations', () => {
  const big = (n) => ({
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(n) }],
  })
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    big(3000),
    big(3000),
    big(3000),
    big(3000),
    { role: 'user', content: [{ type: 'text', text: 'last question' }, { type: 'image', attachment: { attachmentId: 'a' } }] },
  ]
  const trimmed = trimMessagesToBudget(messages, 5000)
  assert.equal(trimmed[0].role, 'system')
  assert.equal(trimmed[trimmed.length - 1].content[0].text, 'last question')
  const used = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0)
  assert.ok(used <= 5000, `used ${used} > budget`)
  assert.ok(trimmed.length < messages.length)
})

test('estimateTokens counts image blocks at a fixed cost', () => {
  const withImage = estimateTokens({ content: [{ type: 'image', attachment: {} }] })
  assert.ok(withImage >= 1445)
})

test('estimateMessages sums the array (the call-site bug guard)', () => {
  const messages = [
    { content: [{ type: 'text', text: 'x'.repeat(300) }] },
    { content: [{ type: 'text', text: 'y'.repeat(300) }] },
  ]
  assert.ok(estimateMessages(messages) > 0)
  assert.equal(estimateTokens(messages), 0) // an array alone must not be counted
})

test('replaceImageBlocksWithMemory substitutes cached descriptions and honest placeholders', () => {
  const memory = new Map([['img-1', '一只戴帽子的猫']])
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } },
        { type: 'image', attachment: { attachmentId: 'img-2', name: 'b.png' } },
        { type: 'text', text: '两张图' },
      ],
    },
  ]
  const out = replaceImageBlocksWithMemory(messages, memory)
  const blocks = out[0].content
  assert.equal(blocks.filter((b) => b.type === 'image').length, 0)
  assert.ok(blocks[0].text.includes('戴帽子的猫'))
  assert.ok(blocks[0].text.includes('a.png'))
  assert.ok(blocks[1].text.includes('b.png'))
  assert.ok(blocks[1].text.includes('未随本次文本请求发送'))
  assert.equal(blocks[2].text, '两张图')
})

test('replaceImageBlocksWithMemory accepts a plain object map', () => {
  const out = replaceImageBlocksWithMemory(
    [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }],
    { x: '内容' },
  )
  assert.ok(out[0].content[0].text.includes('内容'))
})

test('rewriteHistoryImages uses cached descriptions and markers for the rest', () => {
  const memory = new Map([['img-1', '一只戴帽子的猫']])
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } },
        { type: 'image', attachment: { attachmentId: 'img-2', name: 'b.png' } },
        { type: 'text', text: '两张图' },
      ],
    },
  ]
  const out = rewriteHistoryImages(messages, memory)
  const blocks = out.messages[0].content
  assert.equal(blocks.filter((b) => b.type === 'image').length, 0)
  assert.ok(blocks[0].text.includes('戴帽子的猫'))
  assert.ok(blocks[1].text.includes('vision_describe'))
  assert.ok(blocks[1].text.includes('img-2'))
  assert.equal(blocks[2].text, '两张图')
  assert.equal(out.attachments.length, 1)
  assert.equal(out.attachments[0].attachmentId, 'img-2')
})

test('rewriteHistoryImages returns the same messages array when nothing changed', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '纯文本' }] }]
  const out = rewriteHistoryImages(messages, new Map())
  assert.equal(out.messages, messages)
  assert.equal(out.attachments.length, 0)
  const empty = rewriteHistoryImages(undefined, new Map())
  assert.equal(empty.messages, undefined)
})

test('rewriteImagesDeep descends into tool-result content and preserves identity', () => {
  const ref = { attachmentId: 'img-n', name: 'n.png' }
  const input = [
    {
      type: 'tool-result',
      toolCallId: 'c1',
      content: [
        { type: 'text', text: 'Read image n.png' },
        { type: 'image', attachment: ref },
      ],
    },
    { type: 'text', text: 'tail' },
  ]
  const out = rewriteImagesDeep(input, (block) => ({
    type: 'text',
    text: `marker:${block.attachment.attachmentId}`,
  }))
  assert.equal(out.changed, true)
  assert.equal(out.content[0].type, 'tool-result')
  assert.equal(out.content[0].content[0].type, 'text')
  assert.equal(out.content[0].content[1].text, 'marker:img-n')
  assert.equal(out.content[1], input[1])
  // untouched input keeps the same array identity
  const untouched = rewriteImagesDeep([{ type: 'text', text: 'x' }], () => ({ type: 'text' }))
  assert.equal(untouched.changed, false)
  assert.equal(untouched.content[0].type, 'text')
})

test('rewriteImageBlocks rewrites images nested inside tool results', () => {
  const ref = { attachmentId: 'att-2', mediaType: 'image/png' }
  const { messages, attachments } = rewriteImageBlocks([
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [
            { type: 'text', text: 'Read image shot.png (1200x800)' },
            { type: 'image', attachment: ref },
          ],
        },
        { type: 'text', text: '继续' },
      ],
    },
  ])
  const blocks = messages[0].content
  const result = blocks[0]
  assert.equal(result.type, 'tool-result')
  assert.equal(result.content[0].type, 'text')
  assert.equal(result.content.filter((b) => b.type === 'image').length, 0)
  assert.match(result.content[1].text, /att-2/)
  assert.match(result.content[1].text, /vision_describe/)
  assert.equal(blocks[1].text, '继续')
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0], ref)
})

test('stripImageBlocks removes nested tool-result images too', () => {
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c',
          content: [
            { type: 'text', text: 't' },
            { type: 'image', attachment: { attachmentId: 'a' } },
          ],
        },
      ],
    },
  ]
  const out = stripImageBlocks(messages)
  assert.equal(out[0].content[0].type, 'tool-result')
  assert.deepEqual(out[0].content[0].content, [{ type: 'text', text: 't' }])
})

test('collectImageBlocks finds nested tool-result images and dedupes', () => {
  const ref = { attachmentId: 'img-x', name: 'x.png' }
  const blocks = collectImageBlocks([
    { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'image', attachment: ref }] }] },
    { role: 'user', content: [{ type: 'image', attachment: ref }] },
  ])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].id, 'img-x')
})

test('replaceImageBlocksWithMemory rewrites nested tool-result images', () => {
  const memory = new Map([['img-1', '一只戴帽子的猫']])
  const out = replaceImageBlocksWithMemory(
    [
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            content: [
              { type: 'text', text: 'ok' },
              { type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } },
            ],
          },
        ],
      },
    ],
    memory,
  )
  const nested = out[0].content[0].content
  assert.equal(nested.filter((b) => b.type === 'image').length, 0)
  assert.ok(nested[1].text.includes('戴帽子的猫'))
})

test('rewriteHistoryImages rewrites nested tool-result images (UNSUPPORTED_CONTENT guard)', () => {
  const memory = new Map()
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-read',
          content: [
            { type: 'text', text: 'Read image shot.png (1200x800)' },
            { type: 'image', attachment: { attachmentId: 'img-9', name: 'shot.png' } },
          ],
        },
      ],
    },
  ]
  const out = rewriteHistoryImages(messages, memory)
  const nested = out.messages[0].content[0].content
  assert.equal(nested.filter((b) => b.type === 'image').length, 0)
  assert.ok(nested[1].text.includes('img-9'))
  assert.ok(nested[1].text.includes('vision_describe'))
  assert.equal(out.attachments.length, 1)
  assert.equal(out.attachments[0].attachmentId, 'img-9')
})

test('stealth stream strips nested tool-result images before the text-only delegate', async () => {
  let delegateCall
  const ctx = {
    logger: { warn() {} },
    llm: {
      async *stream(options) {
        delegateCall = options
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const adapter = createStealthAdapter(ctx, {
    native: {
      providerInfo: () => ({ id: 'x', name: 'DeepSeek' }),
      providerRetryPolicy: () => undefined,
      listModels: async () => [],
      resolveModel: async (p, m) => ({ provider: p, id: m, name: m }),
    },
    imageMemory: new Map(),
    delegateProvider: 'deepseek-official-native',
  })
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [
            { type: 'text', text: 'Read image x.png' },
            { type: 'image', attachment: { attachmentId: 'img-7', name: 'x.png' } },
          ],
        },
        { type: 'text', text: '下一轮' },
      ],
    },
  ]
  for await (const _chunk of adapter.stream({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    messages,
  })) {
    /* drain */
  }
  const sent = delegateCall.messages[0]
  assert.equal(sent.content[0].type, 'tool-result')
  assert.equal(sent.content[0].content.filter((b) => b.type === 'image').length, 0)
  assert.ok(sent.content[0].content[1].text.includes('img-7'))
  assert.ok(sent.content[0].content[1].text.includes('vision_describe'))
  // the original log keeps the nested image so the Web UI can still show it
  assert.equal(messages[0].content[0].content[1].type, 'image')
})

test('lastUserText returns the current user question', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'i' } }, { type: 'text', text: '新问题' }] },
  ]
  assert.equal(lastUserText(messages), '新问题')
  assert.equal(lastUserText([{ role: 'assistant', content: [] }]), '')
})

test('longOcrWindows slices with overlap and covers the full height', () => {
  // 3000px tall, 1200px chunks, 120px overlap -> tops 0, 1080, 2160 (last clamps to 3000)
  const windows = longOcrWindows(3000, 1200, 120)
  assert.deepEqual(windows, [
    { top: 0, bottom: 1200 },
    { top: 1080, bottom: 2280 },
    { top: 2160, bottom: 3000 },
  ])
  // single short image -> one window
  assert.deepEqual(longOcrWindows(600, 1200, 120), [{ top: 0, bottom: 600 }])
  // exact multiple with overlap lands the last chunk clamped at height
  assert.deepEqual(longOcrWindows(2400, 1200, 0), [
    { top: 0, bottom: 1200 },
    { top: 1200, bottom: 2400 },
  ])
})

test('parseBox validates string and object forms', () => {
  assert.deepEqual(parseBox('10,20,110,120'), { x1: 10, y1: 20, x2: 110, y2: 120 })
  assert.deepEqual(parseBox({ x1: 1, y1: 2, x2: 3, y2: 4 }), { x1: 1, y1: 2, x2: 3, y2: 4 })
  assert.equal(parseBox('10,20,110'), undefined)
  assert.equal(parseBox('10,20,10,30'), undefined) // x2 <= x1
  assert.equal(parseBox('-1,0,10,10'), undefined)
  assert.equal(parseBox(undefined), undefined)
})

test('computePixelDiff counts differing pixels and worst grid cells', () => {
  // 4x4 image, left half identical, right half fully different
  const a = Buffer.alloc(4 * 4 * 4, 10)
  const b = Buffer.alloc(4 * 4 * 4, 10)
  for (let y = 0; y < 4; y++) {
    for (let x = 2; x < 4; x++) {
      b[(y * 4 + x) * 4] = 200
    }
  }
  const diff = computePixelDiff(a, b, 16, 4, 4)
  assert.equal(diff.total, 16)
  assert.equal(diff.differing, 8)
  assert.equal(diff.ratio, 0.5)
  assert.ok(diff.cells.length > 0)
  assert.ok(diff.mask[0] === 0 && diff.mask[2] === 1)
})

test('renderDiffHeatmap marks differing pixels red on a grayscale base', () => {
  const raw = Buffer.alloc(2 * 2 * 4, 255)
  const mask = new Uint8Array([0, 1, 0, 0])
  const out = renderDiffHeatmap(raw, mask, 2, 2)
  assert.deepEqual([out[0], out[1], out[2], out[3]], [255, 255, 255, 255]) // gray
  assert.deepEqual([out[4], out[5], out[6], out[7]], [255, 0, 0, 255]) // red
})

test('quantizeColors returns dominant hex colors with shares', () => {
  const raw = Buffer.alloc(100 * 4)
  for (let i = 0; i < 80; i++) {
    raw[i * 4] = 10
    raw[i * 4 + 1] = 20
    raw[i * 4 + 2] = 30
    raw[i * 4 + 3] = 255
  }
  for (let i = 80; i < 100; i++) {
    raw[i * 4] = 200
    raw[i * 4 + 1] = 210
    raw[i * 4 + 2] = 220
    raw[i * 4 + 3] = 255
  }
  const colors = quantizeColors(raw, 2)
  assert.equal(colors.length, 2)
  assert.equal(colors[0].count, 80)
  assert.ok(colors[0].hex.startsWith('#'))
})

test('boxToSvg draws a rect with pixel coordinates', () => {
  const svg = boxToSvg({ x1: 5, y1: 6, x2: 15, y2: 26 }, 100, 100).toString()
  assert.ok(svg.includes('x="5" y="6"'))
  assert.ok(svg.includes('width="10" height="20"'))
})

test('launchEnvironmentLike exposes get(name) -> { value }', () => {
  const env = launchEnvironmentLike({ DEEPSEEK_API_KEY: 'sk-x', EMPTY: '' })
  assert.equal(env.get('DEEPSEEK_API_KEY').value, 'sk-x')
  assert.deepEqual(env.get('EMPTY'), { value: '' })
  assert.equal(env.get('MISSING'), undefined)
})

test('createNativeDeepSeekAdapter builds the stock adapter from settings + credentials', async () => {
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => ({}) }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      return undefined
    },
  }
  const adapter = createNativeDeepSeekAdapter(ctx)
  assert.equal(adapter.providerInfo('deepseek-official-native').name, 'DeepSeek')
  const models = await adapter.listModels('deepseek-official-native')
  assert.ok(models.some((m) => m.id === 'deepseek-v4-pro'))
  assert.deepEqual(models[0].inputModalities, ['text'])
  const info = await adapter.resolveModel('deepseek-official-native', 'deepseek-v4-pro')
  assert.deepEqual(info.inputModalities, ['text'])
  assert.ok(info.context.contextWindow > 0)
  const key = await ctx._keyTest?.()
  assert.equal(key, undefined)
})

test('createStealthAdapter mirrors the stock catalog but declares image input', async () => {
  const native = {
    providerInfo: (p) => ({ id: p, name: 'DeepSeek' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: 'DeepSeek-V4-Pro' }),
  }
  const ctx = {
    logger: { warn() {} },
    llm: {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const imageMemory = new Map()
  const adapter = createStealthAdapter(ctx, {
    native,
    imageMemory,
    pairs: () => [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    chainRoute: () => 'vision-chain',
    delegateProvider: 'deepseek-official-native',
  })
  assert.equal(adapter.providerInfo('deepseek-official').name, 'DeepSeek')
  assert.equal(adapter.providerRetryPolicy('deepseek-official'), 'retry')
  const listed = await adapter.listModels('deepseek-official')
  assert.equal(listed[0].id, 'deepseek-v4-pro')
  assert.deepEqual(listed[0].inputModalities, ['text', 'image'])
  assert.deepEqual(await adapter.listModels('deepseek-vision'), [])
  const info = await adapter.resolveModel('deepseek-official', 'deepseek-v4-pro')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('stealth stream delegates text turns to the native route with memory substitution', async () => {
  let delegateCall
  const ctx = {
    logger: { warn() {} },
    llm: {
      async *stream(options) {
        delegateCall = options
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const imageMemory = new Map([['img-1', '一只猫']])
  const adapter = createStealthAdapter(ctx, {
    native: {
      providerInfo: () => ({ id: 'x', name: 'DeepSeek' }),
      providerRetryPolicy: () => undefined,
      listModels: async () => [],
      resolveModel: async (p, m) => ({ provider: p, id: m, name: m }),
    },
    imageMemory,
    pairs: () => [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    chainRoute: () => 'vision-chain',
    delegateProvider: 'deepseek-official-native',
  })
  const messages = [
    {
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } }, { type: 'text', text: '这张图是什么' }],
    },
  ]
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'deepseek-official', model: 'deepseek-v4-pro', messages })) {
    chunks.push(chunk)
  }
  assert.equal(delegateCall.provider, 'deepseek-official-native')
  assert.equal(delegateCall.model, 'deepseek-v4-pro')
  assert.ok(delegateCall.messages[0].content[0].text.includes('一只猫'))
  assert.equal(delegateCall.messages[0].content.filter((b) => b.type === 'image').length, 0)
  assert.equal(chunks[0].type, 'finish')
})

test('stealth stream keeps the log intact and hands the model a tool-hint marker', async () => {
  let streamCalls = 0
  let delegateCall
  const ctx = {
    logger: { warn() {} },
    llm: {
      async *stream(options) {
        streamCalls += 1
        delegateCall = options
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const adapter = createStealthAdapter(ctx, {
    native: {
      providerInfo: () => ({ id: 'x', name: 'DeepSeek' }),
      providerRetryPolicy: () => undefined,
      listModels: async () => [],
      resolveModel: async (p, m) => ({ provider: p, id: m, name: m }),
    },
    imageMemory: new Map(),
    delegateProvider: 'deepseek-official-native',
  })
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'img-9', name: 'b.png' } },
        { type: 'text', text: '看看这张图' },
      ],
    },
  ]
  for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'deepseek-v4-pro', messages })) {
    /* drain */
  }
  // exactly one llm call: the delegate. No automatic vision pass burns quota.
  assert.equal(streamCalls, 1)
  // the logged messages keep the image block (the Web UI still shows it)
  assert.equal(messages[0].content[0].type, 'image')
  // the model's input carries a compact marker pointing at the vision tools
  const head = delegateCall.messages[0].content[0]
  assert.equal(head.type, 'text')
  assert.ok(head.text.includes('img-9'))
  assert.ok(head.text.includes('vision_describe'))
  assert.equal(delegateCall.messages[0].content.filter((b) => b.type === 'image').length, 0)
})

// ── apply() end-to-end: the harness-shaped mock ────────────────────────────
//
// Regression guard: apply() once crashed with "Cannot access 'chainRoute'
// before initialization" because the stealth/wrapper blocks referenced the
// `chainRoute` const before its declaration (the TDZ bug that shipped a dead
// plugin). These tests apply the full plugin against a harness-shaped mock
// ctx, so ordering bugs inside apply() fail loudly here instead of at boot.

function mockHarnessCtx({ stockRoute = false, config0 = {}, skills = false } = {}) {
  const adapters = new Map() // provider -> adapter
  const registrations = new Map() // provider -> { adapter, retryPolicy }
  const captured = { skills: [], on: new Map() }
  if (stockRoute) {
    const stock = {
      providerInfo: (p) => ({ id: p, name: 'DeepSeek' }),
      providerRetryPolicy: () => 'retry',
      listModels: async (p) => [
        { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
        { provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
      ],
      resolveModel: async (p, m) => ({
        provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 1000000 },
      }),
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    adapters.set('deepseek-official', stock)
    registrations.set('deepseek-official', { adapter: stock, retryPolicy: 'retry' })
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => undefined }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'skills' && skills) {
        return {
          register: (skill) => {
            captured.skills.push(skill)
            return () => {}
          },
        }
      }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
    effect(fn) {
      if (typeof fn === 'function') fn()
      return () => {}
    },
    on(event, handler) {
      captured.on.set(event, handler)
    },
    inject(_deps, callback) {
      // settings seam: run synchronously against a mock settings service that
      // resolves the composition entry through the Config schema defaults.
      const scope = {
        get: () => ({ ...Config({}), ...config0 }),
        watch: () => {},
      }
      const sctx = {
        settings: { register: () => scope },
        effect: () => () => {},
      }
      callback(sctx)
    },
    tools: { register: () => () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) {
          if (adapters.has(provider)) {
            const error = new Error(`an adapter for provider "${provider}" is already registered`)
            error.code = 'DUPLICATE_ADAPTER'
            throw error
          }
        }
        for (const provider of providers) {
          adapters.set(provider, adapter)
          registrations.set(provider, { adapter, retryPolicy: adapter.providerRetryPolicy(provider) })
        }
        // mirror the real handle: callable disposer with a replace() sidecar
        const handle = () => {}
        handle.replace = () => {}
        return handle
      },
      registration(provider) {
        const hit = registrations.get(provider)
        if (hit === undefined) throw new Error(`no adapter registered for provider "${provider}"`)
        return hit
      },
      registerConfigurableProviders: () => ({ replace: () => {} }),
      listProviders() {
        return [...registrations.entries()].map(([provider, registration]) => {
          let info
          try {
            info = registration.adapter.providerInfo ? registration.adapter.providerInfo(provider) : undefined
          } catch {
            info = undefined
          }
          return { id: provider, name: info && info.name ? info.name : provider }
        })
      },
      async listModels(provider) {
        const hit = registrations.get(provider)
        if (hit === undefined || typeof hit.adapter.listModels !== 'function') return []
        return hit.adapter.listModels(provider)
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { ctx, adapters, captured }
}

test('apply registers the stealth deepseek-official route with the stock catalog', async () => {
  const { ctx, adapters } = mockHarnessCtx()
  // the harness loader normalizes the entry config through the Config schema;
  // routing: true keeps the legacy chain route mounted (the default is off —
  // image turns go through the vision tools instead)
  apply(ctx, Config({
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    routing: true,
    stealth: true,
  }))

  // all four routes came up: hidden native, public deepseek-official, the
  // hidden wrapper alias, and the vision chain
  for (const provider of ['deepseek-official-native', 'deepseek-official', 'deepseek-vision', 'vision-chain']) {
    assert.ok(adapters.has(provider), `expected route "${provider}" to be registered`)
  }

  // the public route serves the stock catalog (same ids/names) but declares
  // image input, so the picker looks exactly like the stock one
  const official = adapters.get('deepseek-official')
  const listed = await official.listModels('deepseek-official')
  assert.deepEqual(listed.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.deepEqual(listed.map((m) => m.name), ['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'])
  for (const model of listed) assert.deepEqual(model.inputModalities, ['text', 'image'])

  // the hidden routes advertise no models
  assert.deepEqual(await adapters.get('deepseek-official-native').listModels('deepseek-official-native'), [])
  assert.deepEqual(await adapters.get('deepseek-vision').listModels('deepseek-vision'), [])
})

test('apply skips the chain route by default: image turns go through the vision tools', () => {
  const { ctx, adapters } = mockHarnessCtx()
  apply(ctx, Config({}))
  // tools-first philosophy: no whole-turn chain routing by default, but the
  // vision-http backend for vision_describe stays mounted
  assert.equal(adapters.has('vision-chain'), false)
  assert.ok(adapters.has('vision-http'))
  // keep-alive: the stock route is dead in this mock (no stockRoute), so the
  // plugin still takes over deepseek-official via the hidden native route —
  // otherwise the DeepSeek models would vanish entirely
  assert.ok(adapters.has('deepseek-official-native'))
  assert.ok(adapters.has('deepseek-vision'))
})

test('stealth defaults to false (issue #34: explicit opt-in, no stealth takeover by default)', () => {
  assert.equal(Config({}).stealth, false)
  assert.equal(Config({ stealth: undefined }).stealth, false)
})

test('wrappedProviders pre-fills the stock deepseek-official row out of the box', () => {
  // like the vision chain pre-fills vision-http, the wrappers section ships
  // one visible default row so users see the built-in wrapper at first glance
  assert.deepEqual(Config({}).wrappedProviders, [{ provider: 'deepseek-official', models: [] }])
})


test('autoWrapProviders defaults to true', () => {
  assert.equal(Config({}).autoWrapProviders, true)
  assert.equal(Config({ autoWrapProviders: false }).autoWrapProviders, false)
})
test('the vision chain ships with the built-in free model as its first row', () => {
  assert.deepEqual(Config({}).providers, [
    { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
  ])
})

test('keep-alive fallback: stealth off + dead stock route still serves deepseek-official', async () => {
  // No stockRoute in the mock = the official llm-deepseek row is disabled at
  // the composition layer (adapterAvailable throws). With stealth off the
  // plugin must STILL take over, or the DeepSeek models vanish entirely.
  const { ctx, adapters } = mockHarnessCtx()
  apply(ctx, Config({ stealth: false }))
  assert.ok(adapters.has('deepseek-official'), 'expected the keep-alive deepseek-official route')
  assert.ok(adapters.has('deepseek-official-native'), 'expected the hidden native route')
  const official = adapters.get('deepseek-official')
  const listed = await official.listModels('deepseek-official')
  assert.deepEqual(listed.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
})

test('stealth off + alive stock route performs no takeover at all', async () => {
  const { ctx, adapters } = mockHarnessCtx({ stockRoute: true })
  apply(ctx, Config({ stealth: false }))
  // the stock adapter keeps owning deepseek-official; the plugin registers no
  // hidden native route and no public takeover — only the visible wrapper
  assert.equal(adapters.has('deepseek-official-native'), false)
  const stock = adapters.get('deepseek-official')
  const listed = await stock.listModels('deepseek-official')
  assert.deepEqual(listed[0].inputModalities, ['text'])
  assert.ok(adapters.has('deepseek-vision'), 'expected the visible wrapper route')
})

// ── legacy routing fallback (routing: true, chainRoute: '') ────────────────
//
// Regression guard: the agent/request fallback used to read current.provider /
// current.model, but `current` is a function — so every image turn in legacy
// routing mode was switched to provider/model undefined. It must route to the
// first chain pair instead, and leave the config alone when it is already on
// that pair.

function legacyRoutingHarness(configOverrides = {}) {
  const config = {
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    routing: true,
    chainRoute: '',
    autoActivateOnImage: false,
    ...configOverrides,
  }
  const { ctx, captured } = mockHarnessCtx({ config0: config })
  apply(ctx, Config(config))
  const session = { events: [] }
  const payload = {
    agent: { session },
    turn: 7,
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } }],
      },
    ],
  }
  return {
    ctx,
    captured,
    session,
    payload,
    preStep: captured.on.get('agent/pre-step'),
    request: captured.on.get('agent/request'),
  }
}

test('agent/request legacy routing sends image turns to the first chain pair', async () => {
  const { payload, preStep, request } = legacyRoutingHarness()
  assert.equal(typeof preStep, 'function')
  assert.equal(typeof request, 'function')
  await preStep(payload, async () => ({ messages: payload.messages }))
  const routed = await request(payload, async () => ({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }))
  assert.equal(routed.provider, 'openrouter')
  assert.equal(routed.model, 'qwen/qwen3-vl-235b-a22b-instruct')
  // the effort belongs to the previous provider and must be dropped on switch
  assert.equal(routed.reasoningEffort, undefined)
})

test('agent/request legacy routing keeps the config when already on the first pair', async () => {
  const { payload, preStep, request } = legacyRoutingHarness()
  await preStep(payload, async () => ({ messages: payload.messages }))
  const config0 = {
    provider: 'openrouter',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }
  const routed = await request(payload, async () => ({ ...config0 }))
  assert.deepEqual(routed, config0)
})

test('vision-http resolveModel returns exact id metadata (llm service contract)', async () => {
  const { ctx, adapters } = mockHarnessCtx()
  apply(ctx, Config({}))
  const http = adapters.get('vision-http')
  assert.ok(http)
  const resolved = await http.resolveModel('vision-http', 'ovh/Qwen2.5-VL-72B-Instruct')
  assert.equal(resolved.provider, 'vision-http')
  assert.equal(resolved.id, 'ovh/Qwen2.5-VL-72B-Instruct')
  assert.equal(typeof resolved.name, 'string')
  assert.ok(resolved.name.length > 0)
  // the llm service would reject string reasoning efforts (INVALID_MODEL_REASONING)
  assert.equal(resolved.reasoning, undefined)
  await assert.rejects(
    () => http.resolveModel('vision-http', 'nope/missing'),
    /unknown model/,
  )
})

test('vision-http stream emits the indexed block protocol the assemblers need', async () => {
  const { ctx, adapters } = mockHarnessCtx()
  apply(ctx, Config({}))
  const http = adapters.get('vision-http')
  assert.ok(http)
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  try {
    const chunks = []
    for await (const chunk of http.stream({
      provider: 'vision-http',
      model: 'ovh/Qwen2.5-VL-72B-Instruct',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })) chunks.push(chunk)
    const kinds = chunks.map((c) => c.type)
    assert.ok(kinds.includes('block-start'))
    const delta = chunks.find((c) => c.type === 'text-delta')
    assert.equal(delta.index, 0)
    assert.equal(delta.text, 'hi')
    const finish = chunks.find((c) => c.type === 'finish')
    assert.equal(finish.reason.kind, 'stop')
    // the tool's chunk assembler must recover the full text
    const assembler = createChunkAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    assert.equal(assembler.finish(), 'hi')
  } finally {
    globalThis.fetch = original
  }
})

test('apply registers the vision-tools skill with source and content', () => {
  const { ctx, captured } = mockHarnessCtx({ skills: true })
  apply(ctx, Config({}))
  const skill = captured.skills.find((s) => s.name === 'vision-tools')
  assert.ok(skill, 'expected the vision-tools skill registration')
  // the skill registry validates the LOADED definition against these fields
  assert.equal(typeof skill.source, 'string')
  assert.ok(skill.source.length > 0)
  assert.equal(typeof skill.content, 'string')
  assert.ok(skill.content.includes('vision_describe') || skill.content.includes('vision_ground'))
})

test('auto-wrap discovers existing providers including native vision models', async () => {
  const { ctx, adapters } = mockHarnessCtx()
  const mixed = {
    providerInfo: (p) => ({ id: p, name: 'MiniMax' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'minimax-m2.7', name: 'MiniMax M2.7', inputModalities: ['text'] },
      { provider: p, id: 'minimax-vision-native', name: 'MiniMax Vision', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p,
      id: m,
      name: m,
      inputModalities: m === 'minimax-vision-native' ? ['text', 'image'] : ['text'],
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['minimax'], mixed)
  apply(ctx, Config({}))
  const twin = adapters.get('minimax-vision')
  assert.ok(twin, 'expected an automatically discovered minimax-vision twin')
  const listed = await twin.listModels('minimax-vision')
  assert.deepEqual(listed.map((m) => m.id), ['minimax-m2.7', 'minimax-vision-native'])
  for (const model of listed) assert.deepEqual(model.inputModalities, ['text', 'image'])
})

test('auto-wrap follows providers that become live after plugin apply', async () => {
  const { ctx, adapters, captured } = mockHarnessCtx()
  apply(ctx, Config({}))
  assert.equal(adapters.has('opencode-go-vision'), false)
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire)
  fire()
  assert.ok(adapters.has('opencode-go-vision'), 'expected the live provider to be auto-wrapped')
  const listed = await adapters.get('opencode-go-vision').listModels('opencode-go-vision')
  assert.deepEqual(listed.map((m) => m.id), ['deepseek-v4-flash'])
})

test('auto-wrap can be disabled while explicit wrappedProviders still work', async () => {
  const { ctx, adapters } = mockHarnessCtx()
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: p }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [{ provider: p, id: 'm1', name: 'm1', inputModalities: ['text'] }],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['minimax'], thirdParty)
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  apply(ctx, Config({
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'opencode-go', models: [] }],
  }))
  assert.equal(adapters.has('minimax-vision'), false)
  assert.ok(adapters.has('opencode-go-vision'))
})

test('apply registers an image-capable twin route for wrappedProviders', async () => {
  const { ctx, adapters } = mockHarnessCtx()
  // register a third-party text-only provider in the mock before apply
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  apply(ctx, Config({
    wrappedProviders: [{ provider: 'opencode-go', models: ['deepseek-v4-flash'] }],
  }))
  const twin = adapters.get('opencode-go-vision')
  assert.ok(twin, 'expected the opencode-go-vision twin route')
  const listed = await twin.listModels('opencode-go-vision')
  assert.deepEqual(listed.map((m) => m.id), ['deepseek-v4-flash'])
  assert.deepEqual(listed[0].inputModalities, ['text', 'image'])
  const resolved = await twin.resolveModel('opencode-go-vision', 'deepseek-v4-flash')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  // text turns delegate to the original provider with image-free messages
  let delegateCall
  ctx.llm.stream = async function* (options) {
    delegateCall = options
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const messages = [
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } }, { type: 'text', text: '看这张图' }] },
  ]
  for await (const _c of twin.stream({ provider: 'opencode-go-vision', model: 'deepseek-v4-flash', messages })) {
    /* drain */
  }
  assert.equal(delegateCall.provider, 'opencode-go')
  assert.equal(delegateCall.messages[0].content.filter((b) => b.type === 'image').length, 0)
  assert.ok(delegateCall.messages[0].content[0].text.includes('img-1'))
})

test('twin route registers before its source adapter appears (live provider registration)', async () => {
  // llm-pi-ai mounts dormant: its routes (openrouter/deepseek) register LIVE
  // once the settings document loads, i.e. AFTER other plugins' apply().
  // wrappedProviders must therefore register the twin up front and resolve
  // the source adapter lazily per call.
  const { ctx, adapters } = mockHarnessCtx()
  apply(ctx, Config({
    wrappedProviders: [{ provider: 'opencode-go', models: [] }],
  }))
  assert.ok(adapters.has('opencode-go-vision'), 'expected the twin route before the source adapter exists')
  const twin = adapters.get('opencode-go-vision')
  // before the source appears: empty catalog, no crash
  assert.deepEqual(await twin.listModels('opencode-go-vision'), [])
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
      { provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  // after the source appears: mirrored catalog with image input declared
  const listed = await twin.listModels('opencode-go-vision')
  assert.deepEqual(listed.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
  for (const model of listed) assert.deepEqual(model.inputModalities, ['text', 'image'])
  const resolved = await twin.resolveModel('opencode-go-vision', 'deepseek-v4-flash')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
})

test('auto-wrap also exposes a twin for an already image-capable GLM model', async () => {
  const { ctx, adapters } = mockHarnessCtx()
  const glm = {
    providerInfo: (p) => ({ id: p, name: 'Zhipu GLM' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash', inputModalities: ['text', 'image'] },
      { provider: p, id: 'glm-4v-flash', name: 'GLM-4V-Flash', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text', 'image'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['zhipu'], glm)
  apply(ctx, Config({ autoWrapProviders: true }))
  assert.ok(adapters.has('zhipu-vision'), 'expected Zhipu GLM + auto-vision twin')
  const listed = await adapters.get('zhipu-vision').listModels('zhipu-vision')
  assert.deepEqual(listed.map((m) => m.id), ['glm-4.6v-flash', 'glm-4v-flash'])
  for (const model of listed) assert.deepEqual(model.inputModalities, ['text', 'image'])
})

test('native multimodal twin preserves original image blocks instead of forcing tool conversion', async () => {
  const { ctx, adapters } = mockHarnessCtx()
  const glm = {
    providerInfo: (p) => ({ id: p, name: 'Zhipu GLM' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text', 'image'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['zhipu'], glm)
  apply(ctx, Config({ autoWrapProviders: true }))
  const twin = adapters.get('zhipu-vision')
  assert.ok(twin)

  let delegateCall
  ctx.llm.stream = async function* (options) {
    delegateCall = options
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'glm-img', name: 'glm.png' } },
        { type: 'text', text: '直接看看这张图' },
      ],
    },
  ]
  for await (const _c of twin.stream({ provider: 'zhipu-vision', model: 'glm-4.6v-flash', messages })) {
    /* drain */
  }
  assert.equal(delegateCall.provider, 'zhipu')
  assert.strictEqual(delegateCall.messages, messages)
  assert.equal(delegateCall.messages[0].content.filter((b) => b.type === 'image').length, 1)
  assert.equal(delegateCall.messages[0].content[0].attachment.attachmentId, 'glm-img')
})

test('twin sync is idempotent across llm/adapters-updated events', async () => {
  const { ctx, adapters, captured } = mockHarnessCtx()
  apply(ctx, Config({ wrappedProviders: [{ provider: 'opencode-go', models: [] }] }))
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire, 'expected the adapters-updated listener to be registered')
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
      { provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  // every adapter change re-runs the sync; repeated runs must neither
  // duplicate the route nor throw DUPLICATE_ADAPTER
  fire()
  fire()
  fire()
  assert.ok(adapters.has('opencode-go-vision'))
  const listed = await adapters.get('opencode-go-vision').listModels('opencode-go-vision')
  assert.deepEqual(listed.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
})

test('apply falls back to the visible wrapper when the stock route is still active', async () => {
  const { ctx, adapters } = mockHarnessCtx({ stockRoute: true })
  apply(ctx, Config({
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
  }))

  // the stock adapter still owns deepseek-official (stealth gave up cleanly)
  const listed = await adapters.get('deepseek-official').listModels('deepseek-official')
  assert.deepEqual(listed.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.deepEqual(listed[0].inputModalities, ['text'])

  // the wrapper route mirrors the stock models; in the default tools-first
  // mode (routing off) the vision-chain pairs stay out of this group — they
  // are legacy whole-turn routing markers, not DeepSeek entries
  const wrapper = adapters.get('deepseek-vision')
  const wrapped = await wrapper.listModels('deepseek-vision')
  assert.deepEqual(wrapped.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.deepEqual(wrapped[0].inputModalities, ['text', 'image'])
})

test('wrapper lists the vision-chain pairs only when whole-turn routing is on', async () => {
  const { ctx, adapters } = mockHarnessCtx({ stockRoute: true, config0: { routing: true } })
  apply(ctx, Config({
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    routing: true,
  }))
  const wrapper = adapters.get('deepseek-vision')
  const wrapped = await wrapper.listModels('deepseek-vision')
  assert.deepEqual(wrapped.map((m) => m.id), [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'vision-http/ovh/Qwen3.5-397B-A17B',
  ])
  const visionEntry = wrapped.find((m) => m.id === 'vision-http/ovh/Qwen3.5-397B-A17B')
  assert.ok(visionEntry)
  assert.deepEqual(visionEntry.inputModalities, ['text', 'image'])
  assert.ok(String(visionEntry.name).includes('视觉'))
  // resolving a vision-pair entry still returns image-capable metadata
  const resolved = await wrapper.resolveModel('deepseek-vision', 'vision-http/ovh/Qwen3.5-397B-A17B')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  assert.equal(resolved.id, 'vision-http/ovh/Qwen3.5-397B-A17B')
})
test('floodFillBackground clears border-connected background pixels', () => {
  // 4x4: white background, black 2x2 square in the middle
  const raw = Buffer.alloc(4 * 4 * 4)
  for (let i = 0; i < 16; i++) {
    raw[i * 4] = 255
    raw[i * 4 + 1] = 255
    raw[i * 4 + 2] = 255
    raw[i * 4 + 3] = 255
  }
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
    const o = (y * 4 + x) * 4
    raw[o] = 0
    raw[o + 1] = 0
    raw[o + 2] = 0
  }
  const out = floodFillBackground(raw, 4, 4, 40)
  assert.equal(out[3], 0) // corner cleared
  const center = (1 * 4 + 1) * 4
  assert.equal(out[center + 3], 255) // foreground kept opaque
})

test('bitmapOfGray marks dark pixels as foreground', () => {
  const raw = Buffer.alloc(2 * 2 * 3, 255)
  raw[3] = 0; raw[4] = 0; raw[5] = 0
  const bitmap = bitmapOfGray(raw, 2, 2)
  assert.deepEqual([...bitmap], [0, 1, 0, 0])
})

test('posterizeSvg vectorizes a tiny PNG into SVG', async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: Buffer.from('<svg width="8" height="8"><rect x="2" y="2" width="4" height="4" fill="black"/></svg>') }])
    .png()
    .toBuffer()
  const svg = await posterizeSvg(png, 2)
  assert.ok(svg.includes('<svg'))
  assert.ok(svg.length > 100)
})


test('dedupeHttpProviders drops endpoints already covered by vision-http pairs', () => {
  const http = [{ name: 'ovh', model: 'Qwen2.5-VL-72B-Instruct', baseURL: 'https://x/v1' }]
  assert.deepEqual(
    dedupeHttpProviders([{ provider: 'vision-http', model: 'ovh/Qwen2.5-VL-72B-Instruct' }], http),
    [],
  )
  assert.deepEqual(
    dedupeHttpProviders([{ provider: 'openrouter', model: 'qwen' }], http),
    http,
  )
})


test('hostMatchesAny matches exact hosts and subdomains only', () => {
  const hosts = ['api.openrouter.ai', 'openrouter.ai']
  assert.equal(hostMatchesAny('api.openrouter.ai', hosts), true)
  assert.equal(hostMatchesAny('openrouter.ai', hosts), true)
  assert.equal(hostMatchesAny('api.openrouter.ai.evil.com', hosts), false)
  assert.equal(hostMatchesAny('api.deepseek.com', hosts), false)
  assert.equal(hostMatchesAny('openrouter.ai', []), false)
  assert.equal(hostMatchesAny('openrouter.ai', undefined), false)
})

test('DEFAULT_PROXY_HOSTS covers the common foreign AI API domains', () => {
  for (const host of ['api.openrouter.ai', 'openrouter.ai', 'api.openai.com', 'api.anthropic.com', 'api.mistral.ai', 'api.together.xyz']) {
    assert.ok(DEFAULT_PROXY_HOSTS.includes(host), `missing ${host}`)
  }
  assert.ok(!DEFAULT_PROXY_HOSTS.includes('api.deepseek.com'), 'DeepSeek stays direct')
})

// ── batch 1: vision_detect + structured describe ────────────────────────────

test('boxesToSvg draws a numbered box per inventory element', () => {
  const svg = boxesToSvg(
    [{ x1: 10, y1: 20, x2: 60, y2: 80 }, { x1: 100, y1: 100, x2: 200, y2: 180 }],
    640,
    480,
  ).toString()
  assert.ok(svg.includes('<svg'))
  assert.equal((svg.match(/<rect /g) || []).length, 2)
  assert.equal((svg.match(/<circle /g) || []).length, 2)
  assert.ok(svg.includes('>1</text>'))
  assert.ok(svg.includes('>2</text>'))
})

test('annotateBoxesBuffer composites numbered boxes onto the image', async () => {
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer()
  const annotated = await annotateBoxesBuffer(png, [{ x1: 2, y1: 2, x2: 30, y2: 30 }])
  assert.ok(annotated.length > 0)
  const meta = await sharp(annotated).metadata()
  assert.equal(meta.width, 64)
  assert.equal(meta.height, 48)
  const passthrough = await annotateBoxesBuffer(png, [])
  assert.deepEqual(passthrough, png)
})

test('visionDetectInstruction demands the fixed inventory schema', () => {
  const text = visionDetectInstruction('buttons', 640, 480)
  assert.ok(text.includes('640x480'))
  assert.ok(text.includes('buttons'))
  assert.ok(text.includes('{"elements":'))
  assert.ok(text.includes('x1'))
  assert.ok(text.includes('ORIGINAL image pixels'))
})

test('describeStructuredInstruction demands the evidence contract', () => {
  const text = describeStructuredInstruction('what is wrong')
  assert.ok(text.includes('what is wrong'))
  assert.ok(text.includes('summary'))
  assert.ok(text.includes('layout'))
  assert.ok(text.includes('entities'))
  assert.ok(text.includes('text'))
})

test('normalizeDetectResult clamps boxes and numbers elements', () => {
  const parsed = {
    elements: [
      { label: '发送按钮', box: { x1: -5, y1: 2, x2: 30, y2: 40 } },
      { label: 'bad box', box: { x1: 50, y1: 50, x2: 10, y2: 10 } },
      { label: '', box: { x1: 100, y1: 100, x2: 300, y2: 200 } },
    ],
  }
  const out = normalizeDetectResult(parsed, 640, 480)
  assert.equal(out.elements.length, 2)
  assert.equal(out.elements[0].number, 1)
  assert.deepEqual(out.elements[0].box, { x1: 0, y1: 2, x2: 30, y2: 40 })
  assert.equal(out.elements[1].label, 'element 2')
  assert.equal(normalizeDetectResult({}, 640, 480), undefined)
  assert.equal(normalizeDetectResult({ elements: 'nope' }, 640, 480), undefined)
})

test('normalizeDescribeResult fills the documented keys', () => {
  const out = normalizeDescribeResult({
    summary: 'a lake',
    layout: [{ region: 'top', content: 'title' }, { bad: true }],
    entities: [{ type: 'button', label: 'Go' }, { type: 'nope' }],
  })
  assert.equal(out.summary, 'a lake')
  assert.equal(out.layout.length, 1)
  assert.equal(out.entities.length, 1)
  assert.equal(out.text, '')
  assert.equal(normalizeDescribeResult('nope'), undefined)
  assert.equal(normalizeDescribeResult([1, 2]), undefined)
})

test('posterizeSvg rejects on timeout instead of hanging forever', async () => {
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer()
  await assert.rejects(() => posterizeSvg(png, 4, 'dominant', 0), /timed out/)
})

test('posterizeSvg resolves normally when potrace finishes in time', async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: Buffer.from('<svg width="8" height="8"><rect x="2" y="2" width="4" height="4" fill="black"/></svg>') }])
    .png()
    .toBuffer()
  const svg = await posterizeSvg(png, 2, 'dominant', 30000)
  assert.ok(svg.includes('<svg'))
})

test('posterizeSvg keeps the main thread responsive while potrace computes', async () => {
  const noise = Buffer.alloc(1024 * 1024 * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + 17) % 256
  const png = await sharp(noise, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer()
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 50)
  await assert.rejects(
    () => posterizeSvg(png, 16, 'dominant', 1000),
    /timed out/,
  )
  clearInterval(timer)
  // the main loop must keep ticking while the worker computes
  assert.ok(ticks > 5, `expected main-thread ticks during the compute, got ${ticks}`)
})

// ── color-preserving trace ──────────────────────────────────────────────────

test('posterizeSvgColor emits one colored path per dominant color', async () => {
  // 64x48: white background with a red square
  const raw = Buffer.alloc(64 * 48 * 4)
  for (let i = 0; i < 64 * 48; i++) {
    const o = i * 4
    raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255
  }
  for (let y = 10; y < 30; y++) {
    for (let x = 20; x < 40; x++) {
      const o = (y * 64 + x) * 4
      raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30
    }
  }
  const palette = quantizeColors(raw, 2)
  assert.ok(palette.length >= 2)
  const svg = await posterizeSvgColor(raw, { width: 64, height: 48 }, palette, 30000)
  assert.ok(svg.includes('<svg'))
  assert.ok(svg.includes('fill="#'))
  assert.ok(svg.includes('<path '))
  // the red square color is in the palette and must appear as a fill
  const red = palette.find((p) => p.hex !== '#ffffff')
  assert.ok(red, 'expected a non-white palette entry')
  assert.ok(svg.includes(red.hex))
})

test('posterizeSvgColor rejects on timeout', async () => {
  const raw = Buffer.alloc(64 * 64 * 4, 255)
  await assert.rejects(
    () => posterizeSvgColor(raw, { width: 64, height: 64 }, [{ hex: '#ffffff', count: 1, share: 1 }], 0),
    /timed out/,
  )
})

test('toRealPath converts fs resolve results to real paths', () => {
  assert.equal(toRealPath(null, '/abs/page.html'), '/abs/page.html')
  assert.equal(toRealPath(null, 'rel/page.html'), 'rel/page.html')
  assert.equal(
    toRealPath({ processPath: (t) => String(t.targetKey) }, { targetKey: '/abs/page.html', displayPath: '/abs/page.html' }),
    '/abs/page.html',
  )
  assert.equal(toRealPath({}, { targetKey: '/abs/page.html' }), '/abs/page.html')
  assert.equal(toRealPath(null, { targetKey: '/abs/page.html' }), '/abs/page.html')
  assert.equal(toRealPath({}, { targetKey: '' }), '[object Object]')
})


test('built-in OVH anonymous fallback is largest-first across independent model buckets', () => {
  assert.deepEqual(DEFAULT_HTTP_PROVIDERS.map((provider) => provider.model), [
    'Qwen3.5-397B-A17B',
    'Qwen2.5-VL-72B-Instruct',
    'Qwen3.6-27B',
    'Mistral-Small-3.2-24B-Instruct-2506',
    'Qwen3.5-9B',
  ])
  assert.ok(DEFAULT_HTTP_PROVIDERS.every((provider) => provider.apiKeyEnv === ''))
})

test('anonymous OVH 429 surfaces immediately so the next model can run', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{"message":"API rate limit exceeded"}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    })
  }
  const started = Date.now()
  try {
    await assert.rejects(
      () => callOpenAICompatible(
        {
          name: 'ovh',
          baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
          model: 'Qwen3.5-397B-A17B',
          apiKeyEnv: '',
        },
        [{ role: 'user', content: [] }],
      ),
      /429/,
    )
    assert.equal(calls, 1)
    assert.ok(Date.now() - started < 1000)
  } finally {
    globalThis.fetch = original
  }
})

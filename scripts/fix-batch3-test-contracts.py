from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


# Cache keys are intentionally opaque hashes now. Test the semantic contract,
# not the old plaintext serialization format.
path = Path('tests/core.test.js')
text = path.read_text(encoding='utf-8')
old = '''test('cacheKeyFor covers chains, content, mode and question', () => {
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
'''
new = '''test('cacheKeyFor covers chains, content, mode and question without retaining plaintext', () => {
  const base = {
    pairs: [{ provider: 'p', model: 'm' }],
    httpProviders: [{ name: 'ovh', model: 'qwen' }],
    contentIds: ['b', 'a'],
    wantJson: false,
    question: 'plain-question-marker',
  }
  const k1 = cacheKeyFor(base)
  assert.match(k1, /^v2:[a-f0-9]{64}$/)
  assert.equal(k1, cacheKeyFor({ ...base, contentIds: ['a', 'b'] }))
  assert.notEqual(k1, cacheKeyFor({ ...base, wantJson: true }))
  assert.notEqual(k1, cacheKeyFor({ ...base, httpProviders: [] }))
  assert.notEqual(k1, cacheKeyFor({ ...base, contentIds: ['b'] }))
  assert.notEqual(k1, cacheKeyFor({ ...base, question: 'different-question' }))
  assert.equal(k1.includes('plain-question-marker'), false)
})
'''
text = replace_once(text, old, new, 'cacheKeyFor contract')
path.write_text(text, encoding='utf-8')


# Production bounded readers consume the actual response stream. Old tests used
# ad-hoc objects with only .json(), which cannot exercise or prove byte admission.
path = Path('tests/update-check.test.js')
text = path.read_text(encoding='utf-8')
anchor = "} from '../lib/update-check.js'\n\n"
helper = """} from '../lib/update-check.js'\n\nfunction jsonResponse(value, status = 200) {\n  return new Response(JSON.stringify(value), {\n    status,\n    headers: { 'content-type': 'application/json' },\n  })\n}\n\n"""
text = replace_once(text, anchor, helper, 'update-check jsonResponse helper')

text = replace_once(
    text,
    '''      return {
        ok: true,
        status: 200,
        async json() {
          return { version: '1.2.0' }
        },
      }
''',
    "      return jsonResponse({ version: '1.2.0' })\n",
    'primary registry response',
)
text = replace_once(
    text,
    '''      return {
        ok: true,
        status: 200,
        async json() {
          return { version: '1.2.0' }
        },
      }
''',
    "      return jsonResponse({ version: '1.2.0' })\n",
    'fallback registry response',
)
text = replace_once(
    text,
    '''        return {
          ok: true,
          status: 200,
          async json() {
            return { tag_name: 'v1.5.0' }
          },
        }
''',
    "        return jsonResponse({ tag_name: 'v1.5.0' })\n",
    'GitHub release response',
)
text = replace_once(
    text,
    '''    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { version: '1.2.9' }
      },
    }),
''',
    "    fetchImpl: async () => jsonResponse({ version: '1.2.9' }),\n",
    'ahead-of-registry response',
)
text = replace_once(
    text,
    "        fetchImpl: async () => ({ ok: true, status: 200, async json() { return { version: 'latest' } } }),\n",
    "        fetchImpl: async () => jsonResponse({ version: 'latest' }),\n",
    'malformed version response',
)
text = replace_once(
    text,
    "      return { ok: true, status: 200, async json() { return { version: '1.2.0' } } }\n",
    "      return jsonResponse({ version: '1.2.0' })\n",
    'cached checker response',
)
path.write_text(text, encoding='utf-8')

print('batch3 test contracts migrated successfully')

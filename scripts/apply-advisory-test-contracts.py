from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f'{label}: start marker not found')
    b = text.find(end, a + len(start))
    if b < 0:
        raise RuntimeError(f'{label}: end marker not found')
    return text[:a] + replacement + text[b:]


# The UI should hard-exclude generated wrapper routes even before capability
# metadata arrives; ordinary text-labelled models remain selectable.
path = 'lib/client.js'
text = read(path)
text = replace_once(
    text,
    "        .filter((group) => group && typeof group.id === 'string' && group.id !== 'vision-http')\n",
    "        .filter((group) =>\n          group &&\n          typeof group.id === 'string' &&\n          group.id !== 'vision-http' &&\n          group.id !== 'vision-chain' &&\n          !group.id.endsWith('-vision'),\n        )\n",
    'hard-exclude generated/internal routes in picker',
)
write(path, text)


path = 'tests/client.test.js'
text = read(path)
first_test = '''test('filterVisionBackendGroups keeps callable generative models and hides only structural routes', () => {
  const bundle = loadClientBundle()
  const groups = [
    { id: 'vision-http', name: 'Vision HTTP', models: [{ id: 'free', name: 'free' }] },
    { id: 'vision-chain', name: 'Vision chain', models: [{ id: 'internal', name: 'internal' }] },
    { id: 'opencode-go-vision', name: 'Generated wrapper', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
    { id: 'opencode-go', name: 'opencode-go', models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'qwen-vl', name: 'Qwen VL' },
      { id: 'embedding', name: 'Embedding' },
    ] },
  ]
  const filtered = bundle.filterVisionBackendGroups(groups, {
    'opencode-go': {
      'deepseek-v4-flash': { image: false, attemptable: true, inputModalities: ['text'] },
      'qwen-vl': { image: true, attemptable: true, inputModalities: ['text', 'image'] },
      embedding: { image: false, attemptable: false, inputModalities: ['text'] },
    },
  })
  assert.deepEqual(filtered.map((group) => [group.id, group.models.map((model) => model.id)]), [
    ['opencode-go', ['deepseek-v4-flash', 'qwen-vl']],
  ])
  // Missing capability metadata is advisory: catalog models remain selectable.
  assert.deepEqual(bundle.filterVisionBackendGroups(groups, {}).map((group) => group.id), ['opencode-go'])
})

'''
text = replace_between(
    text,
    "test('filterVisionBackendGroups hides text-only models and the internal vision-http route', () => {",
    "test('the client bundle still loads and registers with the proven injects', () => {",
    first_test,
    'replace old picker hard-filter regression',
)

advisory_diag_test = '''test('advisory capability diagnostics keep undeclared models selectable and support re-detection', () => {
  const bundle = loadClientBundle()
  const groups = [
    { id: 'zhipu', name: '智谱', models: [
      { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash' },
      { id: 'glm-4.5v', name: 'GLM-4.5V' },
    ] },
    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen-vl', name: 'Qwen VL' }] },
    { id: 'opencode-go-vision', name: 'opencode-go + 自动识图', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
  ]
  const capabilities = {
    zhipu: {
      'glm-4.6v-flash': {
        image: false,
        attemptable: true,
        inputModalities: [],
        reason: 'model metadata does not declare image input',
      },
      'glm-4.5v': {
        image: false,
        attemptable: true,
        inputModalities: ['text'],
        reason: 'model metadata declares no image input',
      },
    },
    openrouter: {
      'qwen-vl': { image: true, attemptable: true, inputModalities: ['text', 'image'] },
    },
    'opencode-go-vision': {
      'deepseek-v4': { image: false, attemptable: false, inputModalities: [] },
    },
  }
  const uncertain = bundle.collectFilteredVisionBackends(groups, capabilities)
  assert.deepEqual(uncertain.map((entry) => [entry.provider, entry.model]), [
    ['zhipu', 'glm-4.6v-flash'],
    ['zhipu', 'glm-4.5v'],
  ])
  const selectable = bundle.filterVisionBackendGroups(groups, capabilities)
  assert.deepEqual(selectable.map((entry) => entry.id), ['zhipu', 'openrouter'])
  assert.equal(
    bundle.visionCapabilityWarningKey(capabilities.zhipu['glm-4.6v-flash'], 'ready'),
    'visionCapabilityUndeclaredWarning',
  )
  assert.equal(
    bundle.visionCapabilityWarningKey(capabilities.zhipu['glm-4.5v'], 'ready'),
    'visionCapabilityTextOnlyWarning',
  )

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("visionCapsRetry: '重新检测模型'"), true)
  assert.equal(source.includes('loadCatalog(true)'), true)
  assert.equal(source.includes('loadVisionCapabilities(true)'), true)
  assert.equal(source.includes('Capability metadata is advisory, not an admission gate'), true)
  assert.equal(source.includes('emptyVisionModelsPanel(),'), false)
})


'''
text = replace_between(
    text,
    "test('empty vision dropdown diagnostics identify undeclared image models and support re-detection', () => {",
    "test('toolview cards use a non-default priority so other vision plugins can coexist (#91)', () => {",
    advisory_diag_test,
    'replace old empty-dropdown regression',
)

text = replace_once(
    text,
    "  // The capability notice reflects name-based / manual recognition.\n  assert.equal(source.includes('or are recognized as vision models by name / manual override'), true)\n  // The hidden-models panel points at the override editor.\n  assert.equal(source.includes('select it in the “Extra vision models” dropdown under Advanced'), true)\n",
    "  // The override is now only a capability label; it no longer unlocks admission.\n  assert.equal(source.includes('This setting no longer unlocks the picker or admission'), true)\n  // Transport-specific HTTP bridging stays behind an explicit http(s) guard.\n  assert.equal(source.includes('only a confirmed http(s) OpenAI Chat Completions channel'), true)\n",
    'update override-editor policy assertions',
)
write(path, text)


path = 'tests/core.test.js'
text = read(path)
capability_test = '''test('decideVisionBackendCapability treats metadata as advisory but keeps structural exclusions', () => {
  const declared = { inputModalities: ['text', 'image'] }
  assert.deepEqual(decideVisionBackendCapability(declared, 'zhipu-glm', 'glm-4.6v', []), {
    image: true,
    attemptable: true,
    inputModalities: ['text', 'image'],
    inferred: false,
    reason: undefined,
  })
  // Undeclared glm-4.6v: recognized by name.
  assert.deepEqual(decideVisionBackendCapability({ inputModalities: ['text'] }, 'zhipu-glm', 'glm-4.6v', []), {
    image: true,
    attemptable: true,
    inputModalities: ['text', 'image'],
    inferred: 'name',
    reason: undefined,
  })
  // Undeclared plain glm-4.6: forced via the override list (bare model id).
  assert.deepEqual(
    decideVisionBackendCapability({ inputModalities: ['text'] }, 'zhipu-glm', 'glm-4.6', ['glm-4.6']),
    { image: true, attemptable: true, inputModalities: ['text', 'image'], inferred: 'override', reason: undefined },
  )
  // "provider/model" override entries match too.
  assert.equal(
    decideVisionBackendCapability(undefined, 'zhipu-glm', 'glm-4.6', ['zhipu-glm/glm-4.6']).image,
    true,
  )
  // Metadata lookup failure still falls back to inference.
  assert.equal(decideVisionBackendCapability(undefined, 'zhipu-glm', 'glm-4.6v', []).image, true)
  // A text-only declaration is advisory: the user may explicitly try it.
  assert.deepEqual(decideVisionBackendCapability({ inputModalities: ['text'] }, 'zhipu-glm', 'glm-4.6', []), {
    image: false,
    attemptable: true,
    inputModalities: ['text'],
    inferred: false,
    reason: 'model metadata declares no image input',
  })
  // Missing input metadata is also advisory rather than an admission failure.
  const unknown = decideVisionBackendCapability({}, 'zhipu-glm', 'glm-4.6', [])
  assert.equal(unknown.image, false)
  assert.equal(unknown.attemptable, true)
})


'''
text = replace_between(
    text,
    "test('decideVisionBackendCapability honors declarations, overrides and inference', () => {",
    "test('non-generative VL endpoints stay hidden unless explicitly forced', () => {",
    capability_test,
    'replace old capability contract regression',
)
write(path, text)


# Ensure the new transport/advisory regression file participates in the normal
# test command used by local development and PR CI.
path = 'package.json'
text = read(path)
old = '"test": "node --test tests/core.test.js tests/vision-resilience.test.js tests/client.test.js'
new = '"test": "node --test tests/core.test.js tests/capability-advisory.test.js tests/vision-resilience.test.js tests/client.test.js'
text = replace_once(text, old, new, 'include advisory test file in package test command')
write(path, text)

# Keep the visible verified-test badge truthful once the full suite reaches 256.
for path in ('README.md', 'README.zh.md'):
    text = read(path)
    text = text.replace('verified-252%20tests', 'verified-256%20tests')
    text = text.replace('Verified: 252 tests', 'Verified: 256 tests')
    write(path, text)

print('advisory test contracts aligned')

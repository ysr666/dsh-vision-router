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
    if (name === '@deepseek-ai/dsh-client-ui-attachment') {
      return { ImageGallery: () => null }
    }
    throw new Error('require(' + name + ')')
  })
}

test('unwrapModelsResult reads the catalog from the RPC envelope', () => {
  const bundle = loadClientBundle()
  const groups = [{ id: 'deepseek-official', name: 'DeepSeek', models: [] }]
  const value = bundle.unwrapModelsResult({
    rpcId: 'x',
    result: { ok: true, value: { groups, failures: [] } },
  })
  assert.deepEqual(value.groups, groups)
  // plain values pass through untouched
  assert.deepEqual(bundle.unwrapModelsResult({ groups: [] }), { groups: [] })
  // failed envelopes throw with the host message
  assert.throws(
    () => bundle.unwrapModelsResult({ rpcId: 'x', result: { ok: false, error: { message: 'boom' } } }),
    /boom/,
  )
})

test('filterVisionBackendGroups keeps callable generative models and hides only structural routes', () => {
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

test('the client bundle does not hard-inject the optional connection service', () => {
  const bundle = loadClientBundle()
  assert.deepEqual(bundle.inject, ['settingsScope', 'slots', 'locale', 'sessions', 'remote'])
  assert.equal(typeof bundle.apply, 'function')
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("return ctx.get('connection')"), true)
  assert.equal(source.includes("'sessions', 'connection', 'remote'"), false)
})

test('commitSettingsPlan keeps drafts when a resolved set did not land in the user layer', async () => {
  const bundle = loadClientBundle()
  const requested = [{ provider: 'zhipu', model: 'glm-4.6v-flash' }]
  const drafts = { providers: requested }
  const calls = []
  const scope = {
    async set(field, value) {
      calls.push([field, value])
      // SettingsScope resolves after its recovery read even when the Host
      // rejected the mutation. Deliberately leave the old user layer intact.
    },
    getSnapshot() {
      return { status: 'ready', writable: true, user: { providers: [] } }
    },
  }

  const outcome = await bundle.commitSettingsPlan(scope, [
    { key: 'providers', run: { value: requested } },
  ], drafts)

  assert.deepEqual(calls, [['providers', requested], ['providers', requested]])
  assert.equal(outcome.landed, false)
  assert.equal(outcome.failed, true)
  assert.equal(outcome.nextDrafts, drafts)
  assert.deepEqual(outcome.failures.map(({ field, operation, reason }) => ({ field, operation, reason })), [{
    field: 'providers',
    operation: 'set',
    reason: 'readback-mismatch',
  }])
})

test('commitSettingsPlan accepts structurally equal JSON readback and clears drafts', async () => {
  const bundle = loadClientBundle()
  const requested = [{ provider: 'zhipu', model: 'glm-4.6v-flash' }]
  const snapshot = { status: 'ready', writable: true, user: {} }
  const scope = {
    async set(field, value) {
      snapshot.user[field] = structuredClone(value)
    },
    getSnapshot() {
      return snapshot
    },
  }

  const outcome = await bundle.commitSettingsPlan(scope, [
    { key: 'providers', run: { value: requested } },
  ], { providers: requested })

  assert.equal(outcome.landed, true)
  assert.equal(outcome.failed, false)
  assert.deepEqual(outcome.nextDrafts, {})
  assert.deepEqual(outcome.failures, [])
  assert.equal(bundle.jsonValueEqual({ a: 1, b: [2] }, { b: [2], a: 1 }), true)
  assert.equal(bundle.jsonValueEqual(-0, 0), true)
})

test('commitSettingsPlan clears only fields that landed during a partial save', async () => {
  const bundle = loadClientBundle()
  const providers = [{ provider: 'zhipu', model: 'glm-4.6v-flash' }]
  const drafts = { routing: true, providers }
  const snapshot = { status: 'ready', writable: true, user: { providers: [] } }
  const outcome = await bundle.commitSettingsPlan({
    async set(field, value) {
      if (field === 'routing') snapshot.user[field] = value
      // The providers write resolves after a rejected Host mutation and its
      // recovery read, leaving the old user-layer value in place.
    },
    getSnapshot() { return snapshot },
  }, [
    { key: 'routing', run: { value: true } },
    { key: 'providers', run: { value: providers } },
  ], drafts)

  assert.equal(outcome.landed, false)
  assert.deepEqual(outcome.landedFields, ['routing'])
  assert.deepEqual(outcome.nextDrafts, { providers })
  assert.deepEqual(outcome.failures.map(({ field, reason }) => [field, reason]), [
    ['providers', 'readback-mismatch'],
  ])
})

test('commitSettingsPlan requires unset to remove the user-layer own property', async () => {
  const bundle = loadClientBundle()
  const plan = [{ key: 'proxyHosts', run: { clear: true } }]
  const drafts = { proxyHosts: '' }
  const rejectedSnapshot = { status: 'ready', writable: true, user: { proxyHosts: ['example.test'] } }
  const rejected = await bundle.commitSettingsPlan({
    async unset() {},
    getSnapshot() { return rejectedSnapshot },
  }, plan, drafts)
  assert.equal(rejected.landed, false)
  assert.equal(rejected.nextDrafts, drafts)
  assert.equal(rejected.failures[0].reason, 'readback-mismatch')

  const acceptedSnapshot = { status: 'ready', writable: true, user: { proxyHosts: ['example.test'] } }
  const accepted = await bundle.commitSettingsPlan({
    async unset(field) { delete acceptedSnapshot.user[field] },
    getSnapshot() { return acceptedSnapshot },
  }, plan, drafts)
  assert.equal(accepted.landed, true)
  assert.deepEqual(accepted.nextDrafts, {})
})

test('commitSettingsPlan classifies write and readback errors without dropping drafts', async () => {
  const bundle = loadClientBundle()
  const drafts = { routing: true, tool: true }
  const outcome = await bundle.commitSettingsPlan({
    async set(field) {
      if (field === 'routing') throw new Error('transport failed')
    },
    getSnapshot() {
      throw new Error('snapshot failed')
    },
  }, [
    { key: 'routing', run: { value: true } },
    { key: 'tool', run: { value: true } },
  ], drafts)

  assert.equal(outcome.landed, false)
  assert.equal(outcome.nextDrafts, drafts)
  assert.deepEqual(outcome.failures.map(({ field, reason }) => [field, reason]), [
    ['routing', 'write-error'],
    ['tool', 'readback-error'],
  ])
})


test('commitSettingsPlan retries one resolved-but-unlanded settings write', async () => {
  const bundle = loadClientBundle()
  const requested = [{ provider: 'zhipu', model: 'glm-4.6v-flash' }]
  const snapshot = { status: 'ready', writable: true, user: {} }
  let writes = 0
  let loads = 0
  const outcome = await bundle.commitSettingsPlan({
    async set(field, value) {
      writes += 1
      if (writes === 2) snapshot.user[field] = structuredClone(value)
    },
    async load() { loads += 1 },
    getSnapshot() { return snapshot },
  }, [{ key: 'providers', run: { value: requested } }], { providers: requested })

  assert.equal(outcome.landed, true)
  assert.equal(writes, 2)
  assert.equal(loads, 1)
  assert.deepEqual(outcome.nextDrafts, {})
})

test('vision chain normalization drops legacy blank rows without hiding half-filled drafts', () => {
  const bundle = loadClientBundle()
  assert.deepEqual(bundle.normalizeVisionChainRows([
    { provider: '', model: '' },
    { provider: '  ', model: ' ' },
    { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B' },
    { provider: ' zhipu ', model: '' },
    { provider: ' siliconflow ', model: ' Qwen/Qwen3-VL-32B-Instruct ' },
  ]), [
    { provider: 'zhipu', model: '' },
    { provider: 'siliconflow', model: 'Qwen/Qwen3-VL-32B-Instruct' },
  ])
})

test('guide lifecycle separates durable disposition from session-only progress', () => {
  const bundle = loadClientBundle()
  assert.equal(
    bundle.guideTransition(bundle.GUIDE_STATE.CHAT_MODEL, { type: bundle.GUIDE_EVENT.SETTINGS_CLOSED }),
    bundle.GUIDE_STATE.CHAT_MODEL,
  )
  assert.equal(
    bundle.guideTransition(bundle.GUIDE_STATE.SETTINGS, { type: bundle.GUIDE_EVENT.SETTINGS_CLOSED }),
    bundle.GUIDE_STATE.IDLE,
  )
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('let onboardingSeenMemory = false'), true)
  assert.equal(source.includes("return 'unknown'"), true)
  assert.equal(source.includes('session-only'), true)
  assert.equal(source.includes('settingsPersistence.get(LEGACY_VISION_GUIDE_SETTINGS_KEY)'), false)
  assert.equal(source.includes('settingsPersistence.set(LEGACY_VISION_GUIDE_SETTINGS_KEY'), false)
  assert.equal(source.includes("pending.set(field, { operation, value, attempted: false })"), true)
  assert.equal(source.includes('filter(([, entry]) => !entry.attempted)'), true)
})

test('settings save failure copy says unwritten drafts were kept', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('保存失败：部分配置未写入。未写入的修改已保留，请重试。'), true)
  assert.equal(source.includes('Save failed: some changes were not written. Unwritten changes were kept; please retry.'), true)
  assert.equal(source.includes("className: 'vr-failed', role: 'alert'"), true)
  assert.equal(source.includes("failedFields.join('、')"), true)
  // One-click field resets share the same verified write path, and all
  // editors are frozen during the round-trip so a successful save cannot
  // discard a newer in-flight edit.
  assert.equal(source.includes('const resetField = async (key) => {'), true)
  assert.equal(source.includes("commitSettingsPlan(scope, [{ key, run: { clear: true } }], drafts)"), true)
  assert.equal(source.includes('const editBlocked = !writable || saving'), true)
  assert.equal(source.includes('if (outcome.landedFields.length > 0) setDrafts(outcome.nextDrafts)'), true)
  assert.equal(source.includes("if (outcome.landedFields.includes('extraVisionModels'))"), true)
})


test('model-selection guide separates session and vision models and targets the vision chain', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("onboardingStep1Title: '1 · 选择聊天模型'"), true)
  assert.equal(source.includes("quickStartTitle: '聊天和看图分别设置'"), true)
  assert.equal(source.includes("quickStartTitle: 'Chat and image understanding are separate'"), true)
  assert.equal(source.includes("onboardingStep2Body: '打开「设置 → Vision Router」"), true)
  assert.equal(source.includes("GUIDE_STATE = Object.freeze"), true)
  assert.equal(source.includes("CHAT_MODEL: 'chat-model'"), true)
  assert.equal(source.includes("VISION_MODEL: 'vision-model'"), true)
  assert.equal(source.includes('startVisionSettingsGuide(t)'), true)
  assert.equal(source.includes("id: 'vr-vision-backend-chain'"), true)
  assert.equal(source.includes("'data-vr-guide-target': 'vision-backend'"), true)
  assert.equal(source.includes("target.scrollIntoView({ behavior: 'smooth', block: 'center' })"), true)
  assert.equal(source.includes("const guideTargetsVisionSettings = guideStep === 'step2'"), true)
})

test('re-viewing the guide is explicit and first-run display waits for a real settings decision', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('guideHostUi.closeSettings()'), true)
  assert.equal(source.includes("showOnboarding(t, { auto: false, focus: true })"), true)
  assert.equal(source.includes('function readOnboardingDisposition()'), true)
  assert.equal(source.includes("if (!snapshot || snapshot.status !== 'ready') return 'unknown'"), true)
  assert.equal(source.includes('onboardingAutoPresented'), true)
  assert.equal(source.includes('}, 650)'), false)
  assert.equal(source.includes('dismissOnboarding(false)\n        startVisionSettingsGuide(t)'), true)
})

test('walkthrough completion and Settings-close semantics are explicit state transitions', () => {
  const bundle = loadClientBundle()
  const S = bundle.GUIDE_STATE
  const E = bundle.GUIDE_EVENT
  assert.equal(bundle.guideTransition(S.CHAT_MODEL, { type: E.SETTINGS_CLOSED }), S.CHAT_MODEL)
  assert.equal(bundle.guideTransition(S.CHAT_MODEL, { type: E.NEXT }), S.SETTINGS)
  assert.equal(bundle.guideTransition(S.SETTINGS, { type: E.TARGET_READY }), S.VISION_MODEL)
  assert.equal(bundle.guideTransition(S.SETTINGS, { type: E.SETTINGS_CLOSED }), S.IDLE)
  assert.equal(bundle.guideTransition(S.VISION_MODEL, { type: E.COMPLETE }), S.IDLE)
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('guideSettingsPanelSeen'), true)
  assert.equal(source.includes('scheduleGuidePanelCloseCheck'), true)
  assert.equal(source.includes('}, 400)'), false)
  assert.equal(source.includes('window.setInterval(() => syncVisionGuidePrompt'), false)
  assert.equal(source.includes('if (guideTargetsVisionSettings && outcome.landed) finishGuide()'), true)
  assert.equal(source.includes('if (row.provider && event.target.value) finishGuide()'), false)
})

test('only onboarding disposition is durable; legacy guide progress is cleaned and ignored (#78/#207)', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("const ONBOARDING_SETTINGS_KEY = 'onboardingSeen'"), true)
  assert.equal(source.includes('settingsPersistence.set(ONBOARDING_SETTINGS_KEY, true)'), true)
  assert.equal(source.includes("ONBOARDING_STORAGE_KEY = 'dsh-vision-router:onboarding:model-guide-v2'"), true)
  assert.equal(source.includes("LEGACY_VISION_GUIDE_SETTINGS_KEY = 'visionGuideStep'"), true)
  assert.equal(source.includes('settingsPersistence.unset(LEGACY_VISION_GUIDE_SETTINGS_KEY)'), true)
  assert.equal(source.includes('settingsPersistence.get(LEGACY_VISION_GUIDE_SETTINGS_KEY)'), false)
  assert.equal(source.includes('settingsPersistence.set(LEGACY_VISION_GUIDE_SETTINGS_KEY'), false)
  const serverSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(serverSource.includes('onboardingSeen: z.boolean().default(false)'), true)
  assert.equal(serverSource.includes("visionGuideStep: z.string().default('')"), true)
  assert.equal(serverSource.includes('Deprecated compatibility field'), true)
})

test('the walkthrough is an explicit state machine with visual fallbacks for all three steps', () => {
  const bundle = loadClientBundle()
  const S = bundle.GUIDE_STATE
  const E = bundle.GUIDE_EVENT
  assert.equal(bundle.guideTransition(S.IDLE, { type: E.START }), S.CHAT_MODEL)
  assert.equal(bundle.guideTransition(S.CHAT_MODEL, { type: E.NEXT }), S.SETTINGS)
  assert.equal(bundle.guideTransition(S.SETTINGS, { type: E.TARGET_READY }), S.VISION_MODEL)
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("guideStep1Title: '第 1 步 · 选择聊天模型'"), true)
  assert.equal(source.includes("guidePromptTitle: '第 2 步 · 选择识图模型'"), true)
  assert.equal(source.includes("guideChainTitle: '第 3 步 · 设置备用模型'"), true)
  assert.equal(source.includes('vr-guide-spot-hole'), true)
  assert.equal(source.includes('vr-guide-spot-ring'), true)
  assert.equal(source.includes('vr-guide-arrow'), true)
  assert.equal(source.includes('[data-slot="conversation.input.model"] button[aria-haspopup="menu"]'), true)
  assert.equal(source.includes('button[aria-haspopup="dialog"]'), true)
  assert.equal(source.includes('[role="dialog"][aria-modal="true"]'), true)
  assert.equal(source.includes('guideHostUi.openSettings()'), true)
  assert.equal(source.includes('guideHostUi.openVisionRouter()'), true)
  assert.equal(source.includes('Judge coverage on the CLAMPED box'), true)
  assert.equal(source.includes('const halo = 10'), true)
})

test('manual update help uses a dedicated vertical command card and never falls back to bare update', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("className: 'vr-update-manual'"), true)
  assert.equal(source.includes("className: 'vr-update-command'"), true)
  assert.equal(source.includes("className: 'vr-update-code'"), true)
  assert.equal(source.includes("className: 'vr-update-note'"), true)
  assert.equal(source.includes("className: 'vr-update-actions'"), true)
  assert.equal(source.includes("const commandStyle = {"), false)
  assert.equal(source.includes(": 'update dsh-vision-router'"), false)
  assert.equal(source.includes("const manualAction = 'add ' + manualPackageSpec"), true)
  assert.equal(source.includes("'dsh-vision-router@latest'"), false)
  assert.equal(source.includes("'<version>'"), true)
  assert.equal(source.includes('const manualTargetKnown = manualVersion !=='), true)
  assert.equal(source.includes('updateManualUnknownTarget'), true)
  assert.equal(source.includes("updateNoDiagnostic: '更新检查接口未返回可诊断的错误详情'"), true)
  assert.equal(source.includes("updateInvalidResponse: '更新检查接口返回了无效响应'"), true)
  assert.equal(source.includes("typeof result.ok !== 'boolean'"), true)
  assert.equal(source.includes("result.releaseFallback === true"), true)
})

test('the settings card skips offscreen paint and reuses bounded model-option caches', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Long sections paint only when scrolled into view: the card hosts many
  // native selects whose option lists can reach hundreds of entries per
  // provider, which used to make scrolling the settings panel stutter.
  assert.equal(source.includes('content-visibility:auto'), true)
  assert.equal(source.includes('contain-intrinsic-size:auto 96px'), true)
  // Option vnode lists and expensive catalog derivations are memoized.
  // visionGroups itself must stay stable: an always-new array defeats
  // visionGroupOptions' memo and brings back large-catalog scroll stutter.
  assert.equal(source.includes('const groupOptions = useMemo('), true)
  assert.equal(source.includes('const visionGroupOptions = useMemo('), true)
  assert.equal(source.includes('const wrapGroupOptions = useMemo('), true)
  assert.equal(source.includes('const visionGroups = useMemo('), true)
  assert.equal(source.includes('() => filterVisionBackendGroups(catalog.groups, visionCaps.capabilities)'), true)
  assert.equal(source.includes('[catalog.groups, visionCaps.capabilities]'), true)
  assert.equal(source.includes('[catalog.groups, chainRouteValue, wrapperRouteValue]'), true)
  assert.equal(source.includes("const visionGroups = filterVisionBackendGroups("), false)
  assert.equal(source.includes('modelOptionCache = React.useRef(new Map())'), true)
  assert.equal(source.includes('modelOptionsOf(modelsOf('), true)
  // The card is memoized with a stable props object so app re-renders of the
  // settings panel skip it.
  assert.equal(source.includes('React.memo(VisionRouterCard)'), true)
  assert.equal(source.includes('const cardInject = { getConnection, t, locale: ctx.locale, remote: ctx.remote, subscribeConnectionReset }'), true)
  assert.equal(source.includes("const sectionCardInject = Object.freeze({ ...cardInject, scope: primaryScope, surface: 'section' })"), true)
  assert.equal(source.includes('const legacyEntryInject = Object.freeze({ t })'), false)
  assert.equal(source.includes('VisionRouterLegacyEntry'), false)
  assert.equal(source.includes("ctx.slots.inject('settings.plugin.item'"), false)
})

test('guide sync never queries the DOM or forces layout when no walkthrough is active', () => {
  const bundle = loadClientBundle()
  const savedDocument = globalThis.document
  const savedWindow = globalThis.window
  let queryCount = 0
  let rectCount = 0
  // A settings dialog is on screen (as it is while scrolling the settings
  // panel). The idle guide sync must not even look for it: querySelectorAll
  // and getBoundingClientRect per scroll event are what forced layout and
  // stuttered the panel.
  const fakeDialog = {
    getBoundingClientRect: () => {
      rectCount += 1
      return { width: 800, height: 600, x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600 }
    },
  }
  globalThis.document = {
    body: {},
    querySelectorAll: () => {
      queryCount += 1
      return [fakeDialog]
    },
  }
  globalThis.window = { clearInterval: () => {}, clearTimeout: () => {}, setTimeout: () => 0 }
  try {
    bundle.syncVisionGuidePrompt((key) => key)
    assert.equal(queryCount, 0)
    assert.equal(rectCount, 0)
  } finally {
    globalThis.document = savedDocument
    globalThis.window = savedWindow
  }
})



test('local provider drafts preserve protocol and optional sampling fields', () => {
  const bundle = loadClientBundle()
  const defaults = { baseURL: 'http://local.test/v1', model: 'model-default' }
  const formatted = bundle.normalizeLocalProviderDraft(
    {
      enabled: true,
      baseURL: ' http://custom.test/v1 ',
      model: ' model-id ',
      format: 'anthropic',
    },
    defaults,
  )
  assert.deepEqual(formatted, {
    enabled: true,
    baseURL: ' http://custom.test/v1 ',
    model: ' model-id ',
    format: 'anthropic',
    temperature: undefined,
    top_p: undefined,
  })
  assert.deepEqual(bundle.parseLocalProviderDraft(formatted, defaults), {
    enabled: true,
    baseURL: 'http://custom.test/v1',
    model: 'model-id',
    format: 'anthropic',
  })
  assert.deepEqual(
    bundle.parseLocalProviderDraft(
      { enabled: true, format: 'openai', temperature: 9, top_p: -2 },
      defaults,
    ),
    {
      enabled: true,
      baseURL: defaults.baseURL,
      model: defaults.model,
      format: 'openai',
      temperature: 2,
      top_p: 0,
    },
  )
})

test('local vision settings expose backends only and keep 1+x as the sole first-pass switch', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("const [showLocalVision, setShowLocalVision] = useState(false)"), true)
  assert.equal(source.includes("'aria-controls': 'vr-local-vision-body'"), true)
  assert.equal(source.includes("id: 'vr-local-vision-body'"), true)
  assert.equal(source.includes("groupLocalOllama: '本地视觉 · Ollama / LM Studio'"), true)
  assert.equal(source.includes("groupLocalOllama: 'Local vision · Ollama / LM Studio'"), true)
  assert.equal(source.includes('自动首遍识别统一由上方「结构化预识别（1+x）」控制'), true)
  assert.equal(source.includes('controlled solely by “Structured pre-scan (1+x)” above'), true)
  assert.equal(source.includes("toggleField('instantDescribe')"), false)
  assert.equal(source.includes('const describeStyleEditor ='), false)
  assert.equal(source.includes('.vr-local-style{'), false)
  assert.equal(source.includes("localOllamaEditor()"), true)
  assert.equal(source.includes("localLmStudioEditor()"), true)
  assert.equal(source.includes("className: 'vr-group vr-local-group' + (showLocalVision ? ' vr-local-group-open' : '')"), true)
  assert.equal(source.includes('.vr-local-group-open{margin-bottom:10px;padding-bottom:12px;border-bottom:1px solid'), true)
  assert.equal(source.includes("toggleDesktopScreenshot: '桌面截图识图'"), true)
  assert.equal(source.includes("toggleDesktopScreenshot: 'Desktop screenshot vision'"), true)
  assert.equal(source.includes('/_dsh/vision-router/request-screenshot-permission'), true)
  assert.equal(source.includes("outcome.landedFields.includes('desktopScreenshot')"), true)
  assert.equal(source.includes("!remoteMode ? toggleField('desktopScreenshot') : null"), true)
  assert.equal(source.includes("placeholder: t('localTemperaturePlaceholder')"), true)
  assert.equal(source.includes("placeholder: t('localTopPPlaceholder')"), true)
  assert.equal(source.includes("placeholder: t('localLmStudioModelPlaceholder')"), true)
  assert.equal(source.includes('.vr-local-row{display:grid'), true)
  assert.equal(source.includes("'vision_screenshot',"), true)
})

test('advisory capability diagnostics keep undeclared models selectable and support re-detection', () => {
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


test('toolview cards use a non-default priority so other vision plugins can coexist (#91)', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // DSH keyed slots allow the same key at different priorities. Use a small
  // negative priority so Vision Router keeps ownership of its own tool cards
  // while coexisting with plugins that use the default priority 0.
  assert.equal(source.includes("key: 'vision_present', priority: -10"), true)
  assert.equal(source.includes("key, priority: -10, inject"), true)
})

test('the vision-backend override editor mirrors the chain rows with two selects', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The extraVisionModels setting is rendered as the same two-select row
  // shape as the vision backend chain: a provider select (providers with
  // excluded models) and a model select (that provider's excluded models).
  assert.equal(source.includes("extraVisionModels: 'extraVisionModelsLabel'"), true)
  assert.equal(source.includes("extraVisionModels: 'extraVisionModelsHint'"), true)
  assert.equal(source.includes('const extraVisionModelsEditor = () => {'), true)
  // Option sets are derived by unconditional top-level hooks; the editor
  // itself is plain render code and must stay hook-free (a changing hook
  // count across renders crashes React and blanks the whole settings card).
  assert.equal(source.includes('const hiddenVisionProviders = useMemo('), true)
  assert.equal(source.includes('hiddenVisionBackends.map((entry) => entry.provider)'), true)
  assert.equal(source.includes('const hiddenVisionModelsOf = useMemo(() => {'), true)
  assert.equal(source.includes('hiddenModelsOf.get(row.provider) ?? []'), true)
  assert.equal(source.includes("t('pickProviderFirst')"), true)
  // Rows are drafted as { provider, model } objects so a half-picked row
  // (provider selected, model pending) stays visible instead of collapsing.
  assert.equal(source.includes("setDraft('extraVisionModels', [...rows, { provider: '', model: '' }])"), true)
  assert.equal(source.includes('const hasHalfRow = rows.some('), true)
  // An empty configuration still renders one blank row, like the chain above.
  assert.equal(source.includes("raw.length > 0 ? raw : [{ provider: '', model: '' }]"), true)
  // The current empty value is never merged into the option list (no
  // duplicate blank option under the placeholder).
  assert.equal(source.includes("current !== '' && !hiddenProviders.includes(current)"), true)
  // parse accepts both the object-row drafts and the legacy string shapes.
  assert.equal(source.includes('row && typeof row === \'object\''), true)
  const editorBlock = source.slice(source.indexOf('const extraVisionModelsEditor = () => {'), source.indexOf('const builtinFallbackPanel = () => {'))
  assert.equal(editorBlock.includes('useMemo('), false)
  assert.equal(editorBlock.includes('useState('), false)
  // The editor drafts an array; the free-text fallback stays for when no
  // hidden models / no catalog is available.
  assert.equal(source.includes("textField('extraVisionModels', t('extraVisionModelsLabel'), t('extraVisionModelsHint'), true)"), true)
  assert.equal(source.includes('Array.isArray(text)'), true)
  // Saving the override refreshes the capability map silently (no loading
  // flash / apparent page refresh).
  assert.equal(source.includes("outcome.landedFields.includes('extraVisionModels')"), true)
  assert.equal(source.includes('loadVisionCapabilities(true, true)'), true)
  // The override is now only a capability label; it no longer unlocks admission.
  assert.equal(source.includes('This setting no longer unlocks the picker or admission'), true)
  // Transport-specific HTTP bridging stays behind an explicit http(s) guard.
  assert.equal(source.includes('only a confirmed http(s) OpenAI Chat Completions channel'), true)
  // The hidden-models list is memoized so per-render catalog walks cannot
  // regress the settings card's scroll smoothness.
  assert.equal(source.includes('collectFilteredVisionBackends(catalog.groups, visionCaps.capabilities)'), true)
})


test('auto-discovered inferred vision models retain bridge capability state', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(source.includes('const pairKey = `${pair.provider}/${pair.model}`'), true)
  assert.equal(source.includes('pairCapabilities.set(pairKey, pairCapability)'), true)
  assert.equal(source.includes('resolvedPiAiProfileOf'), true)
  assert.equal(source.includes("transport.api !== 'openai-completions'"), true)
})

test('the twin preserves the picker-chosen reasoningEffort across steps (issue #103)', () => {
  const serverSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // The reasoning level belongs to the chat page's bottom-right picker: the
  // plugin never configures or invents one. The wrapper body only remembers
  // the last explicitly seen effort per delegate and re-injects it on the
  // later steps that arrive without one, so the user's choice survives the
  // twin switch (memory is scoped per provider+model).
  // twin switch. The vision chain keeps reasoningEffort: undefined.
  assert.equal(serverSource.includes('const lastReasoningEffort = new Map()'), true)
  assert.equal(serverSource.includes('lastReasoningEffort.set(effortKey, effort)'), true)
  assert.equal(serverSource.includes('{ ...options, reasoningEffort: effort }'), true)
  assert.equal(serverSource.includes('reasoningEffort: undefined'), true)
  assert.equal(serverSource.includes('reasoningEffort: z.string()'), false)
  assert.equal(serverSource.includes('wrappedProviders[].reasoningEffort'), false)
})


test('vision backend picker keeps generative models when image metadata is advisory', () => {
  const bundle = loadClientBundle()
  const groups = [
    { id: 'custom-ws', name: 'WS provider', models: [
      { id: 'mystery-chat', name: 'Mystery chat' },
      { id: 'embed-model', name: 'Embedding' },
    ] },
    { id: 'declared', name: 'Declared', models: [{ id: 'vision', name: 'Vision' }] },
  ]
  const capabilities = {
    'custom-ws': {
      'mystery-chat': { image: false, attemptable: true, inputModalities: ['text'] },
      'embed-model': { image: false, attemptable: false, inputModalities: ['text', 'image'] },
    },
    declared: {
      vision: { image: true, attemptable: true, inputModalities: ['text', 'image'] },
    },
  }
  const filtered = bundle.filterVisionBackendGroups(groups, capabilities)
  assert.deepEqual(filtered.map((group) => [group.id, group.models.map((model) => model.id)]), [
    ['custom-ws', ['mystery-chat']],
    ['declared', ['vision']],
  ])
  assert.equal(
    bundle.visionCapabilityWarningKey(capabilities['custom-ws']['mystery-chat'], 'ready'),
    'visionCapabilityTextOnlyWarning',
  )
  assert.equal(bundle.visionCapabilityWarningKey(undefined, 'error'), 'visionCapabilityUnknownWarning')
  assert.equal(bundle.visionCapabilityWarningKey(capabilities.declared.vision, 'ready'), undefined)
})


test('hidden settings persistence sends an identical mutation at most once (issue #155)', async () => {
  const bundle = loadClientBundle()
  const snapshot = { status: 'ready', writable: true, value: {}, user: {} }
  const listeners = new Set()
  let writes = 0
  const scope = {
    getSnapshot() { return snapshot },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async set() {
      writes += 1
      // Reproduce the problematic Host behavior: resolve/recover without
      // landing the value, while subscribers keep receiving snapshots.
      for (const listener of [...listeners]) listener()
    },
    async unset() {
      writes += 1
      for (const listener of [...listeners]) listener()
    },
  }
  const persistence = bundle.installSettingsPersistence(scope)
  persistence.subscribe(() => {
    // A render/effect can ask for the same hidden state again on every
    // snapshot. It must not generate another settings.mutate request.
    persistence.set('onboardingSeen', true)
  })
  persistence.set('onboardingSeen', true)
  for (let i = 0; i < 8; i++) {
    for (const listener of [...listeners]) listener()
    persistence.set('onboardingSeen', true)
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(writes, 1)
})

test('hidden settings persistence skips mutations already present in the user layer', async () => {
  const bundle = loadClientBundle()
  const snapshot = {
    status: 'ready', writable: true,
    value: { onboardingSeen: true },
    user: { onboardingSeen: true },
  }
  let writes = 0
  const persistence = bundle.installSettingsPersistence({
    getSnapshot() { return snapshot },
    subscribe() { return () => {} },
    async set() { writes += 1 },
    async unset() { writes += 1 },
  })
  persistence.set('onboardingSeen', true)
  await Promise.resolve()
  assert.equal(writes, 0)
})

test('hidden settings persistence still permits real state transitions', async () => {
  const bundle = loadClientBundle()
  const snapshot = { status: 'ready', writable: true, value: {}, user: {} }
  const writes = []
  const persistence = bundle.installSettingsPersistence({
    getSnapshot() { return snapshot },
    subscribe() { return () => {} },
    async set(field, value) { writes.push(['set', field, value]); snapshot.user[field] = value; snapshot.value[field] = value },
    async unset(field) { writes.push(['unset', field]); delete snapshot.user[field]; delete snapshot.value[field] },
  })
  persistence.set('visionGuideStep', 'step1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  persistence.set('visionGuideStep', 'step2')
  await new Promise((resolve) => setTimeout(resolve, 0))
  persistence.unset('visionGuideStep')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(writes, [
    ['set', 'visionGuideStep', 'step1'],
    ['set', 'visionGuideStep', 'step2'],
    ['unset', 'visionGuideStep'],
  ])
})


test('Vision Router does not register the removed keyed settings.plugin.item surface', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("ctx.slots.inject('settings.plugin.item'"), false)
  assert.doesNotMatch(source, /name: 'settings\.plugin\.item',\s*key: 'vision-router',\s*id: 'vision-router'/)
})


test('partial model-catalog failures stay visible beside successful providers', () => {
  const bundle = loadClientBundle()
  const groups = [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }]
  const failures = [{ id: 'zhipu', name: '智谱', message: 'catalog offline' }]
  const state = bundle.catalogStateFromValue({ groups, failures }, (key) => key === 'catalogEmpty' ? 'empty: ' : key)
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.groups, groups)
  assert.deepEqual(state.failures, failures)
  assert.equal(state.error, undefined)
  assert.match(bundle.catalogFailureDetail(failures), /智谱: catalog offline/)

  const failedOnly = bundle.catalogStateFromValue({ groups: [], failures }, (key) => key === 'catalogEmpty' ? 'empty: ' : key)
  assert.equal(failedOnly.status, 'error')
  assert.deepEqual(failedOnly.failures, failures)
  assert.match(failedOnly.error, /empty: 智谱: catalog offline/)

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("catalogPartialFailure: '部分已配置供应商的模型目录加载失败"), true)
  assert.equal(source.includes("t('catalogPartialFailure', { detail: catalogFailureDetail(catalog.failures) })"), true)
})

test('vision catalog invalidates on provider, settings, credential and connection changes', () => {
  const bundle = loadClientBundle()
  const listeners = new Map()
  const disposed = []
  const remote = {
    $on(name, listener) {
      listeners.set(name, listener)
      return () => { disposed.push(name) }
    },
  }
  let invalidations = 0
  const stop = bundle.subscribeCatalogInvalidations(remote, () => { invalidations += 1 })
  assert.deepEqual([...listeners.keys()], [
    'llm/adapters-updated',
    'settings/document-updated',
    'credentials/updated',
  ])
  listeners.get('llm/adapters-updated')()
  listeners.get('settings/document-updated')()
  listeners.get('credentials/updated')()
  assert.equal(invalidations, 3)
  stop()
  assert.deepEqual(disposed.sort(), [...listeners.keys()].sort())

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("const subscribeConnectionReset = (listener) => ctx.on('connection/reset', listener)"), true)
  assert.equal(source.includes('catalogGeneration.current += 1'), true)
  assert.equal(source.includes('generation !== catalogGeneration.current'), true)
  assert.equal(source.includes('generation !== visionCapsGeneration.current'), true)
})


test('Vision Router owns exactly one primary Settings section', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("ctx.slots.inject('settings.section'"), true)
  assert.equal(source.includes("name: 'settings.section'"), true)
  assert.equal(source.includes("id: 'vision-router'"), true)
  assert.equal(source.includes('order: 12'), true)
  assert.equal(source.includes("label: () => t('settingsNav')"), true)
  assert.equal(source.includes("ctx.slots.inject('settings.plugin.item'"), false)
  assert.equal(source.includes('VisionRouterSettingsSection'), true)
  assert.equal(source.includes("const [open, setOpen] = useState(props.surface === 'section')"), true)
  assert.equal(source.includes('VisionRouterLegacyEntry'), false)
  assert.equal(source.includes('legacyMovedTitle'), false)
  assert.equal(source.includes('legacyMovedBody'), false)
  assert.equal(source.includes('legacyOpen'), false)
})

test('beginner guide teaches only the first-class Vision Router settings path', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("onboardingStep2Body: '打开「设置 → Vision Router」"), true)
  assert.equal(source.includes('设置 → 插件 → Vision Router'), false)
  assert.equal(source.includes('Settings → Plugins → Vision Router'), false)
  assert.equal(source.includes('function guideVisionRouterNav()'), true)
  assert.equal(source.includes('guideHostUi.openVisionRouter()'), true)
  assert.equal(source.includes('guidePluginsNav'), false)
  assert.equal(source.includes('openPlugins()'), false)
})

test('remote settings UI is opt-in, first-class-only, and keeps permission local', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("const REMOTE_SETTINGS_CHANNEL = '/vision-router-settings'"), true)
  assert.equal(source.includes("const useRemoteSettings = shouldUseRemoteSettings(getConnection)"), true)
  assert.equal(source.includes('function shouldUseRemoteSettings(getConnection, locationLike)'), true)
  assert.equal(source.includes("toggleField('allowRemoteSettings')"), true)
  assert.equal(source.includes("!remoteMode ? h('div', { className: 'vr-group' }"), true)
  assert.equal(source.includes("scope: primaryScope, surface: 'section'"), true)
  assert.equal(source.includes('VisionRouterLegacyEntry'), false)
  assert.equal(source.includes("remoteSettingsDisabledTitle: '远程设置未启用'"), true)
  assert.equal(source.includes("fetch('/_dsh/vision-router/settings'"), false)
})

test('remote settings scope reads and writes through the narrow Connection RPC channel', async () => {
  const bundle = loadClientBundle()
  let routing = false
  let revision = 3
  const calls = []
  const getConnection = () => ({
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push([channel, endpoint, structuredClone(payload)])
        assert.equal(channel, '/vision-router-settings')
        if (endpoint === 'mutate') {
          assert.equal(payload.expectedRevision, revision)
          routing = payload.ops[0].value
          revision += 1
        }
        return {
          ok: true,
          value: {
            enabled: true,
            reason: 'enabled',
            writable: true,
            view: {
              value: { routing },
              base: { routing: false },
              user: routing ? { routing: true } : {},
              revision,
              applies: 'live',
            },
          },
        }
      },
    },
  })
  const scope = bundle.createRemoteSettingsScope(getConnection)
  await scope.load()
  assert.equal(scope.getSnapshot().status, 'ready')
  assert.equal(scope.getSnapshot().mode, 'remote')
  assert.equal(scope.getSnapshot().value.routing, false)
  await scope.set('routing', true)
  assert.equal(scope.getSnapshot().value.routing, true)
  assert.deepEqual(scope.getSnapshot().user, { routing: true })
  assert.deepEqual(calls.map((call) => call[1]), ['describe', 'mutate'])
  await scope.dispose()
})

test('remote settings scope exposes disabled state instead of a blank fake config', async () => {
  const bundle = loadClientBundle()
  const scope = bundle.createRemoteSettingsScope(() => ({
    rpc: { async call() { return { ok: true, value: { enabled: false, reason: 'permission-disabled', writable: false } } } },
  }))
  await scope.load()
  const snapshot = scope.getSnapshot()
  assert.equal(snapshot.status, 'unavailable')
  assert.equal(snapshot.mode, 'remote')
  assert.equal(snapshot.remoteDisabled, true)
  assert.equal(snapshot.value, undefined)
  await scope.dispose()
})


test('remote conflict is surfaced and never auto-retried into a lost update', async () => {
  const bundle = loadClientBundle()
  let describes = 0
  let mutates = 0
  const scope = bundle.createRemoteSettingsScope(() => ({ rpc: {
    async call(_channel, endpoint, _payload) {
      if (endpoint === 'describe') {
        describes += 1
        const revision = describes === 1 ? 7 : 8
        return { ok: true, value: { enabled: true, reason: 'enabled', writable: true, view: {
          value: { routing: describes > 1 }, base: { routing: false }, user: describes > 1 ? { routing: true } : {}, revision, applies: 'live',
        } } }
      }
      mutates += 1
      return { ok: false, error: { code: 'settings-conflict', message: 'stale', details: { expected: 7, actual: 8 } } }
    },
  } }))
  await scope.load()
  await assert.rejects(scope.set('routing', false), (error) => error.code === 'settings-conflict')
  assert.equal(mutates, 1)
  assert.equal(scope.getSnapshot().revision, 8)
  const outcome = await bundle.commitSettingsPlan(scope, [{ key: 'routing', run: { value: false } }], { routing: false })
  assert.equal(outcome.failed, true)
  assert.equal(outcome.failures[0].reason, 'settings-conflict')
  assert.equal(mutates, 2, 'one explicit save attempt, never an internal retry')
  await scope.dispose()
})

test('remote RPC times out, aborts, and a later healthy retry recovers', async () => {
  const bundle = loadClientBundle()
  let mode = 'hang'
  const scope = bundle.createRemoteSettingsScope(() => ({ rpc: {
    call(_channel, _endpoint, _payload, signal) {
      if (mode === 'healthy') return Promise.resolve({ ok: true, value: { enabled: true, reason: 'enabled', writable: true, view: { value: { routing: false }, user: {}, revision: 1, applies: 'live' } } })
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    },
  } }), { timeoutMs: 20, initRetryDelays: [] })
  await scope.load()
  assert.equal(scope.getSnapshot().remoteErrorCode, 'settings-timeout')
  mode = 'healthy'
  await scope.reload()
  assert.equal(scope.getSnapshot().status, 'ready')
  await scope.dispose()
})

test('remote load coalesces retry storms instead of queueing duplicate reads', async () => {
  const bundle = loadClientBundle()
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const scope = bundle.createRemoteSettingsScope(() => ({ rpc: {
    async call() {
      calls += 1
      await gate
      return { ok: true, value: { enabled: true, reason: 'enabled', writable: true, view: { value: { routing: false }, user: {}, revision: 1, applies: 'live' } } }
    },
  } }), { timeoutMs: 500 })
  const loads = Array.from({ length: 50 }, () => scope.load())
  assert.equal(calls, 1)
  release()
  await Promise.all(loads)
  assert.equal(calls, 1)
  await scope.dispose()
})

test('namespace initialization is distinct from permission denial and auto-recovers', async () => {
  const bundle = loadClientBundle()
  let calls = 0
  const scope = bundle.createRemoteSettingsScope(() => ({ rpc: {
    async call() {
      calls += 1
      if (calls === 1) return { ok: true, value: { enabled: false, reason: 'namespace-unavailable', writable: false } }
      return { ok: true, value: { enabled: true, reason: 'enabled', writable: true, view: { value: { routing: false }, user: {}, revision: 1, applies: 'live' } } }
    },
  } }), { timeoutMs: 100, initRetryDelays: [5] })
  await scope.load()
  assert.equal(scope.getSnapshot().remoteReason, 'namespace-unavailable')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(scope.getSnapshot().status, 'ready')
  await scope.dispose()
})

test('remote writable state comes from Host instead of being hard-coded true', async () => {
  const bundle = loadClientBundle()
  const scope = bundle.createRemoteSettingsScope(() => ({ rpc: {
    async call() { return { ok: true, value: { enabled: true, reason: 'enabled', writable: false, view: { value: { routing: false }, user: {}, revision: 1, applies: 'live' } } } }
  } }))
  await scope.load()
  assert.equal(scope.getSnapshot().writable, false)
  await assert.rejects(scope.set('routing', true), /read-only/)
  await scope.dispose()
})

test('remote-page selection survives Connection arriving after plugin activation', () => {
  const bundle = loadClientBundle()
  assert.equal(bundle.shouldUseRemoteSettings(() => undefined, { hostname: '192.168.1.44' }), true)
  assert.equal(bundle.shouldUseRemoteSettings(() => undefined, { hostname: 'example.internal' }), true)
  assert.equal(bundle.shouldUseRemoteSettings(() => undefined, { hostname: '127.0.0.1' }), false)
  assert.equal(bundle.shouldUseRemoteSettings(() => undefined, { hostname: 'localhost' }), false)
})

test('removed legacy plugin entry cannot reappear and remote host-only surfaces stay hidden', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('function VisionRouterLegacyEntry(props)'), false)
  assert.equal(source.includes("ctx.slots.inject('settings.plugin.item'"), false)
  assert.equal(source.includes('legacyMovedTitle'), false)
  assert.equal(source.includes('legacyMovedBody'), false)
  assert.equal(source.includes('legacyOpen'), false)
  assert.equal(source.includes("!remoteMode ? toggleField('desktopScreenshot') : null"), true)
  assert.equal(source.includes("!remoteMode ? DEVELOPER_TOGGLE_KEYS.map"), true)
  assert.equal(source.includes("!remoteMode ? TEXT_KEYS.map"), true)
  assert.equal(source.includes("remoteSafeScopeHint"), true)
  assert.equal(source.includes("ctx.remote.$on('settings/document-updated'"), true)
})

test('reverse-proxy route failures are classified with an actionable UI path', async () => {
  const bundle = loadClientBundle()
  const scope = bundle.createRemoteSettingsScope(() => ({ rpc: {
    async call() { throw new Error('transport failure for /vision-router-settings/describe: HTTP 404') }
  } }), { timeoutMs: 100, initRetryDelays: [] })
  await scope.load()
  assert.equal(scope.getSnapshot().remoteErrorCode, 'remote-route-missing')
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('/vision-router-settings/*'), true)
  await scope.dispose()
})

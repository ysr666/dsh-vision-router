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

test('filterVisionBackendGroups hides text-only models and the internal vision-http route', () => {
  const bundle = loadClientBundle()
  const groups = [
    { id: 'vision-http', name: 'Vision HTTP', models: [{ id: 'free', name: 'free' }] },
    { id: 'opencode-go', name: 'opencode-go', models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'qwen-vl', name: 'Qwen VL' },
    ] },
  ]
  const filtered = bundle.filterVisionBackendGroups(groups, {
    'opencode-go': {
      'deepseek-v4-flash': { image: false },
      'qwen-vl': { image: true },
    },
  })
  assert.deepEqual(filtered.map((group) => [group.id, group.models.map((model) => model.id)]), [
    ['opencode-go', ['qwen-vl']],
  ])
  assert.deepEqual(bundle.filterVisionBackendGroups(groups, {}).map((group) => group.id), [])
})

test('the client bundle still loads and registers with the proven injects', () => {
  const bundle = loadClientBundle()
  assert.deepEqual(bundle.inject, ['settingsScope', 'slots', 'locale', 'sessions'])
  assert.equal(typeof bundle.apply, 'function')
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

test('guide dismissal is page-authoritative and hidden persistence does not spin on rejection', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('let onboardingSeenMemory = false'), true)
  assert.equal(source.includes('if (onboardingSeenMemory) return true'), true)
  assert.equal(source.includes('onboardingSeenMemory = true'), true)
  assert.equal(source.includes('let visionGuideMemoryAuthoritative = false'), true)
  assert.equal(source.includes('if (visionGuideMemoryAuthoritative) return visionGuideStepMemory'), true)
  assert.equal(source.includes('visionGuideMemoryAuthoritative = true'), true)
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
  assert.equal(source.includes("onboardingStep1Title: '1 · 会话 / 文字模型'"), true)
  assert.equal(source.includes("quickStartTitle: '聊天与看图分别设置'"), true)
  assert.equal(source.includes("quickStartTitle: 'Chat and vision are configured separately'"), true)
  assert.equal(source.includes("updateProject: '项目主页'"), true)
  assert.equal(source.includes("updateManualSource: '源码仓库 / pnpm DSH：'"), true)
  assert.equal(source.includes('pnpm dsh plugin --profile '), true)
  assert.equal(source.includes('npx @deepseek-ai/dsh plugin --profile '), true)
  assert.equal(source.includes("onboardingStep2Body: '打开「设置 → 插件 → Vision Router」"), true)
  assert.equal(source.includes("onboardingStep1Title: '1 · Session / text model'"), true)
  assert.equal(source.includes('Settings → Plugins → Vision Router'), true)
  assert.equal(source.includes("VISION_GUIDE_STORAGE_KEY = 'dsh-vision-router:guide:vision-backend-v2'"), true)
  assert.equal(source.includes('startVisionSettingsGuide(t)'), true)
  assert.equal(source.includes("id: 'vr-vision-backend-chain'"), true)
  assert.equal(source.includes("'data-vr-guide-target': 'vision-backend'"), true)
  assert.equal(source.includes("target.scrollIntoView({ behavior: 'smooth', block: 'center' })"), true)
  assert.equal(source.includes('if (!open) setOpen(true)'), true)
})

test('re-viewing the model guide replays the overview instead of skipping to step 2', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The re-view button must leave the settings modal and reopen the onboarding
  // overview (steps 1-3) rather than jumping straight into the settings
  // walkthrough, which would skip the session/text-model step whenever the
  // card is already on screen. The settings panel closes on Escape through a
  // native document listener, so the button dispatches that standard keydown.
  assert.equal(source.includes('closeSettingsShell()'), true)
  assert.equal(source.includes("key: 'Escape'"), true)
  assert.equal(source.includes('showOnboarding(t)'), true)
  // The overview dialog is a reusable, single-instance overlay: the first-run
  // auto-show and the re-view button share it without stacking duplicates.
  assert.equal(source.includes('function showOnboarding(t)'), true)
  assert.equal(source.includes('if (onboardingOverlay) return'), true)
  assert.equal(source.includes('function dismissOnboarding(remember = true)'), true)
  // The auto-show is deferred (never synchronous) and gated on the durable
  // seen flag.
  assert.equal(source.includes('window.setTimeout(() => {'), true)
  assert.equal(source.includes('if (!readOnboardingSeen()) showOnboarding(t)'), true)
})

test('onboarding and guide durability live in the settings section, not origin-scoped localStorage (#78)', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // DSH Desktop re-randomizes the Web UI port on every launch, so
  // origin-scoped localStorage forgets everything between restarts. The
  // durable flags must be settings-section fields synced through
  // ctx.settingsScope (persisted in the profile settings file).
  assert.equal(source.includes("const ONBOARDING_SETTINGS_KEY = 'onboardingSeen'"), true)
  assert.equal(source.includes("const VISION_GUIDE_SETTINGS_KEY = 'visionGuideStep'"), true)
  assert.equal(source.includes('function installSettingsPersistence(scope)'), true)
  assert.equal(source.includes('installSettingsPersistence(scope)'), true)
  assert.equal(source.includes('function readOnboardingSeen()'), true)
  assert.equal(source.includes('settingsPersistence.get(ONBOARDING_SETTINGS_KEY) === true'), true)
  assert.equal(source.includes('settingsPersistence.set(ONBOARDING_SETTINGS_KEY, true)'), true)
  // The legacy localStorage marker still exists as a migration/downgrade
  // fallback, not as the source of truth.
  assert.equal(source.includes("ONBOARDING_STORAGE_KEY = 'dsh-vision-router:onboarding:model-guide-v2'"), true)
  assert.equal(source.includes("window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === 'seen'"), true)
  // The guide step mirrors the same dual-channel strategy.
  assert.equal(source.includes('settingsPersistence.get(VISION_GUIDE_SETTINGS_KEY)'), true)
  assert.equal(source.includes('settingsPersistence.set(VISION_GUIDE_SETTINGS_KEY, visionGuideStepMemory)'), true)
  // Both installers re-sync when the settings snapshot changes (the first
  // snapshot resolves asynchronously after page load).
  assert.equal(source.includes('settingsPersistence.subscribe(sync)'), true)
  // Server half declares the two keys in the Config schema so the settings
  // provider accepts and persists them.
  const serverSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(serverSource.includes('onboardingSeen: z.boolean().default(false)'), true)
  assert.equal(serverSource.includes("visionGuideStep: z.string().default('')"), true)
})

test('the walkthrough walks step 1 (session model), step 2 (open settings), step 3 (chain callout)', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Step-aware persistence: step1 always comes first; step2 only ends once the
  // vision-chain card is on screen, where the step-3 callout takes over.
  assert.equal(source.includes('function readVisionGuideStep()'), true)
  assert.equal(source.includes("writeVisionGuideStep('step1')"), true)
  assert.equal(source.includes("writeVisionGuideStep('step2')"), true)
  // The step strings exist in both dictionaries, with the renumbered titles.
  assert.equal(source.includes("guideStep1Title: '第 1 步 · 会话 / 文字模型'"), true)
  assert.equal(source.includes("guideStepNext: '下一步'"), true)
  assert.equal(source.includes("guidePromptTitle: '第 2 步 · 视觉模型'"), true)
  assert.equal(source.includes("guideChainTitle: '第 3 步 · 这里就是视觉模型'"), true)
  assert.equal(source.includes("guideStep1Title: 'Step 1 · Session / text model'"), true)
  assert.equal(source.includes("guideStepNext: 'Next'"), true)
  assert.equal(source.includes("guidePromptTitle: 'Step 2 · Vision model'"), true)
  assert.equal(source.includes("guideChainTitle: 'Step 3 · This is the vision model'"), true)
  // Every step now carries a visual target, not just step 3: the prompt is
  // anchored to a highlighted element (spotlight hole + pulsing ring + arrow),
  // and step 2's copy differs between the sidebar gear phase and the settings
  // panel's Plugins nav row.
  assert.equal(source.includes('vr-guide-spot-hole'), true)
  assert.equal(source.includes('vr-guide-spot-ring'), true)
  assert.equal(source.includes('vr-guide-arrow'), true)
  assert.equal(source.includes("guidePromptGearBody: '点击侧边栏左下角被高亮圈出的「设置」齿轮"), true)
  assert.equal(source.includes("guidePromptNavBody: '在设置面板左侧的导航里，点击被高亮的「插件」入口"), true)
  assert.equal(source.includes("guidePromptGearBody: 'Click the highlighted Settings gear"), true)
  assert.equal(source.includes("guidePromptNavBody: 'In the settings panel’s left navigation"), true)
  // Stable DOM anchors: DSH web hashes its CSS-module class names, so targets
  // are addressed via data-slot / aria attributes instead of class names.
  assert.equal(source.includes('[data-slot="conversation.input.model"] button[aria-haspopup="menu"]'), true)
  assert.equal(source.includes('button[aria-haspopup="dialog"]'), true)
  assert.equal(source.includes('[role="dialog"][aria-modal="true"]'), true)
  // The prompt veils itself while the step-1 model menu is open so the menu
  // stays clickable, and animations respect reduced motion.
  assert.equal(source.includes('vr-guide-prompt-veiled'), true)
  assert.equal(source.includes('prefers-reduced-motion'), true)
  // Step 2 also carries a Next button: it performs the current phase's
  // action for the user (open the settings panel, then enter Plugins), so
  // every non-final step can be driven entirely from the prompt.
  assert.equal(source.includes("const currentPhase = guidePhase('step2')"), true)
  assert.equal(source.includes('gear.click()'), true)
  assert.equal(source.includes("row.tagName === 'BUTTON'"), true)
  assert.equal(source.includes('也可以直接点「下一步」帮你打开'), true)
  assert.equal(source.includes(', or press “Next” and I will open it for you'), true)
  // Anchoring correctness: the prompt must never cover the highlighted
  // target (coverage is judged on the viewport-clamped box, with a small
  // halo around the target), and the arrow must sit on the prompt's edge
  // that faces the target — above the target means a bottom arrow, etc.
  assert.equal(source.includes('Judge coverage on the CLAMPED box'), true)
  assert.equal(source.includes('const halo = 10'), true)
  assert.equal(source.includes("{ top: 'bottom', bottom: 'top', left: 'right', right: 'left' }"), true)
})

test('the settings card skips offscreen paint and rebuilds model options once', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Long sections paint only when scrolled into view: the card hosts many
  // native selects whose option lists can reach hundreds of entries per
  // provider, which used to make scrolling the settings panel stutter.
  assert.equal(source.includes('content-visibility:auto'), true)
  assert.equal(source.includes('contain-intrinsic-size:auto 96px'), true)
  // Option vnode lists are memoized and the per-provider model lists cached,
  // so re-renders no longer rebuild hundreds of option elements.
  assert.equal(source.includes('const groupOptions = useMemo('), true)
  assert.equal(source.includes('const visionGroupOptions = useMemo('), true)
  assert.equal(source.includes('const wrapGroupOptions = useMemo('), true)
  assert.equal(source.includes('modelOptionCache = React.useRef(new Map())'), true)
  assert.equal(source.includes('modelOptionsOf(modelsOf('), true)
  // The card is memoized with a stable props object so app re-renders of the
  // settings panel skip it.
  assert.equal(source.includes('React.memo(VisionRouterCard)'), true)
  assert.equal(source.includes('const cardInject = { scope, getConnection, t, locale: ctx.locale }'), true)
  assert.equal(source.includes('inject: () => cardInject'), true)
})

test('empty vision dropdown diagnostics identify undeclared image models and support re-detection', () => {
  const bundle = loadClientBundle()
  const groups = [
    { id: 'zhipu', name: '智谱', models: [
      { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash' },
      { id: 'glm-4.5v', name: 'GLM-4.5V' },
    ] },
    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen-vl', name: 'Qwen VL' }] },
    { id: 'opencode-go-vision', name: 'opencode-go + 自动识图', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
  ]
  const hidden = bundle.collectFilteredVisionBackends(groups, {
    zhipu: {
      'glm-4.6v-flash': { image: false, reason: 'model metadata does not declare image input' },
      'glm-4.5v': { image: false, reason: 'model metadata does not declare image input' },
    },
    openrouter: { 'qwen-vl': { image: true } },
  })
  assert.deepEqual(hidden.map((entry) => [entry.provider, entry.model, entry.missingImageDeclaration]), [
    ['zhipu', 'glm-4.6v-flash', true],
    ['zhipu', 'glm-4.5v', true],
  ])

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("visionCapsRetry: '重新检测模型'"), true)
  assert.equal(source.includes('input: [text, image]'), true)
  assert.equal(source.includes('defaultInput: [text, image]'), true)
  assert.equal(source.includes('loadCatalog(true)'), true)
  assert.equal(source.includes('loadVisionCapabilities(true)'), true)
  assert.equal(source.includes('emptyVisionModelsPanel()'), true)
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
  // The capability notice reflects name-based / manual recognition.
  assert.equal(source.includes('or are recognized as vision models by name / manual override'), true)
  // The hidden-models panel points at the override editor.
  assert.equal(source.includes('select it in the “Extra vision models” dropdown under Advanced'), true)
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

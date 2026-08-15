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
  assert.equal(source.includes('setTimeout(() => showOnboarding(t), 650)'), true)
  assert.equal(source.includes('function dismissOnboarding(remember = true)'), true)
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
  // Step 1 parks the prompt on the left so the chat selector stays usable.
  assert.equal(source.includes('vr-guide-prompt-left'), true)
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

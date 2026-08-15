import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`missing patch anchor: ${label}`)
  if (source.indexOf(before, first + before.length) !== -1) throw new Error(`duplicate patch anchor: ${label}`)
  return source.slice(0, first) + after + source.slice(first + before.length)
}

const clientPath = 'lib/client.js'
let client = readFileSync(clientPath, 'utf8')

client = replaceOnce(
  client,
`      desc: '安装后会自动创建「原模型组 + 自动识图」；发图时在聊天页右下角选它 · 面板 v6',
      quickStartTitle: '发图前只做这一步',
      quickStartBody: '回到聊天页，点击右下角模型选择器，选择带「+ 自动识图」的模型组（如 opencode-go + 自动识图），然后直接粘贴或上传图片。原模型组保持不变，仍用于纯文字对话。',
      quickStartLive: '模型和包装范围会热更新：新增或修改后无需重启 DSH。',
      onboardingTitle: 'Vision Router 已准备好 👁️',
      onboardingBody: '你已有的模型已经自动获得识图入口。要发送图片，请点击聊天页右下角的模型选择器，选择带「+ 自动识图」的模型组。',
      onboardingExampleLabel: '例如',
      onboardingExample: 'opencode-go + 自动识图',
      onboardingFoot: '原来的模型组不会被修改；它仍可照常用于纯文字对话。模型增删与包装范围会热更新，无需重启。',
      onboardingGotIt: '知道了',
      onboardingClose: '关闭',`,
`      desc: '会话模型负责聊天，视觉后端负责看图；两者分开设置 · 面板 v7',
      quickStartTitle: '先分清两个模型',
      quickStartBody: '① 会话/文字模型：在聊天页右下角选择；发图时选带「+ 自动识图」的模型组。② 视觉模型：在本卡片的「视觉后端链」里选择，只负责看图。',
      quickStartLive: '只想换识图模型，就改下面的「视觉后端链」；不会改变聊天页右下角的会话模型。',
      quickStartGuide: '重新查看模型引导',
      onboardingTitle: '先分清：聊天的模型 ≠ 看图的模型 👁️',
      onboardingBody: 'Vision Router 把“谁负责聊天”和“谁负责看图”拆成了两处设置。按下面 3 步就不会选错。',
      onboardingStep1Title: '1 · 会话 / 文字模型',
      onboardingStep1Body: '在聊天页右下角选择。发图片时，请选带「+ 自动识图」的模型组；组里的 DeepSeek / opencode 模型仍负责聊天、思考和调用工具。',
      onboardingStep2Title: '2 · 视觉模型',
      onboardingStep2Body: '打开「设置 → 插件 → Vision Router」，在「视觉后端链」里选择。它只负责看图，不会替换你的聊天模型。',
      onboardingStep3Title: '3 · 主视觉模型与备用模型',
      onboardingStep3Body: '视觉后端链第一行是主视觉模型；后面的行只在失败时依次回退。默认内置免费视觉模型通常可以直接使用。',
      onboardingGuide: '带我设置视觉模型',
      onboardingLater: '稍后',
      onboardingClose: '关闭',
      guidePromptTitle: '设置视觉模型 · 第 1 步',
      guidePromptBody: '请打开 DSH 的「设置 → 插件」。进入插件页后，我会自动展开 Vision Router，并定位到「视觉后端链」。',
      guidePromptCancel: '结束引导',
      guideChainTitle: '第 2 步 · 这里就是视觉模型',
      guideChainBody: '第一行 = 主视觉模型；后面的行 = 失败时备用。这里不会修改聊天页右下角的会话/文字模型。选好后点击页面底部「保存」。',
      guideDone: '完成引导',`,
  'zh onboarding copy',
)

client = replaceOnce(
  client,
`      desc: 'Automatically creates “original model group + auto vision”; pick it from the lower-right model selector before sending images · panel v6',
      quickStartTitle: 'One step before sending an image',
      quickStartBody: 'Return to chat, open the model selector in the lower-right corner, choose a group marked “+ Auto Vision” (for example, opencode-go + Auto Vision), then paste or upload the image. Your original model group stays unchanged for normal text chat.',
      quickStartLive: 'Models and wrapper scope hot-update: adding or changing them does not require a DSH restart.',
      onboardingTitle: 'Vision Router is ready 👁️',
      onboardingBody: 'Your existing models now have image-ready entries. To send an image, open the model selector in the lower-right corner of chat and choose a model group marked “+ Auto Vision”.',
      onboardingExampleLabel: 'For example',
      onboardingExample: 'opencode-go + Auto Vision',
      onboardingFoot: 'The original model group is never modified and remains available for normal text chat. Model and wrapper changes hot-update without a restart.',
      onboardingGotIt: 'Got it',
      onboardingClose: 'Close',`,
`      desc: 'The session model chats; the vision backend sees images. They are configured separately · panel v7',
      quickStartTitle: 'Know the two model settings',
      quickStartBody: '① Session/text model: choose it from the lower-right chat selector; for image turns use a group marked “+ Auto Vision”. ② Vision model: choose it in this card under “Vision backend chain”; it only handles image understanding.',
      quickStartLive: 'To change only image understanding, edit “Vision backend chain” below; your lower-right session model is not changed.',
      quickStartGuide: 'Show model guide again',
      onboardingTitle: 'First: the chat model ≠ the vision model 👁️',
      onboardingBody: 'Vision Router separates “who chats and reasons” from “who sees the image”. These 3 steps make the distinction explicit.',
      onboardingStep1Title: '1 · Session / text model',
      onboardingStep1Body: 'Choose it from the lower-right chat selector. For images, use a group marked “+ Auto Vision”; the DeepSeek/opencode model inside still handles chat, reasoning, and tool calls.',
      onboardingStep2Title: '2 · Vision model',
      onboardingStep2Body: 'Open Settings → Plugins → Vision Router and choose it under “Vision backend chain”. It only sees images and does not replace your chat model.',
      onboardingStep3Title: '3 · Primary and fallback vision models',
      onboardingStep3Body: 'The first row in the vision backend chain is primary; later rows are tried only on failure. The built-in free vision model is usually fine as the default.',
      onboardingGuide: 'Guide me to vision settings',
      onboardingLater: 'Later',
      onboardingClose: 'Close',
      guidePromptTitle: 'Set the vision model · Step 1',
      guidePromptBody: 'Open DSH Settings → Plugins. Once that page is open, I will expand Vision Router and take you to “Vision backend chain”.',
      guidePromptCancel: 'End guide',
      guideChainTitle: 'Step 2 · This is the vision model',
      guideChainBody: 'First row = primary vision model; later rows = fallbacks. This does not change the session/text model in the lower-right chat selector. Click “Save” at the bottom after choosing.',
      guideDone: 'Finish guide',`,
  'en onboarding copy',
)

client = replaceOnce(
  client,
`      '.vr-onboarding-actions{display:flex;justify-content:flex-end;padding-top:2px}' +
      '.vr-onboarding-primary{appearance:none;border:0;border-radius:9px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);font:inherit;font-size:14px;font-weight:600;cursor:pointer;padding:8px 18px}' +
      '.vr-onboarding-primary:focus-visible,.vr-onboarding-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '@media(max-width:640px){.vr-onboarding-backdrop{align-items:flex-end;padding:0}.vr-onboarding-dialog{width:100%;border-radius:16px 16px 0 0;padding:20px 18px max(20px,env(safe-area-inset-bottom))}}'`,
`      '.vr-onboarding-steps{display:flex;flex-direction:column;gap:8px}' +
      '.vr-onboarding-step{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);padding:10px 12px;display:flex;flex-direction:column;gap:3px}' +
      '.vr-onboarding-step-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary);line-height:1.5}' +
      '.vr-onboarding-step-body{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}' +
      '.vr-onboarding-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:2px;flex-wrap:wrap}' +
      '.vr-onboarding-primary,.vr-onboarding-secondary{appearance:none;border-radius:9px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;padding:8px 18px}' +
      '.vr-onboarding-primary{border:0;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}' +
      '.vr-onboarding-secondary{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}' +
      '.vr-onboarding-primary:focus-visible,.vr-onboarding-secondary:focus-visible,.vr-onboarding-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.vr-guide-prompt{position:fixed;right:20px;bottom:20px;z-index:9999;width:min(360px,calc(100vw - 32px));box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 40px #0004;padding:14px;display:flex;flex-direction:column;gap:7px;color:var(--dsw-alias-label-primary)}' +
      '.vr-guide-prompt-title{font-size:13px;font-weight:700;line-height:1.5}' +
      '.vr-guide-prompt-body{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}' +
      '.vr-guide-target{border:2px solid var(--dsw-alias-brand-primary)!important;border-radius:12px;padding:12px!important;margin:8px -12px!important;background:var(--dsw-alias-bg-module-platform);box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}' +
      '.vr-guide-callout{border-radius:9px;background:var(--dsw-alias-bg-layer-3);padding:10px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:5px;margin-bottom:4px}' +
      '.vr-guide-callout-title{font-size:13px;font-weight:700;color:var(--dsw-alias-brand-primary)}' +
      '.vr-guide-callout-body{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}' +
      '@media(max-width:640px){.vr-onboarding-backdrop{align-items:flex-end;padding:0}.vr-onboarding-dialog{width:100%;border-radius:16px 16px 0 0;padding:20px 18px max(20px,env(safe-area-inset-bottom))}.vr-guide-prompt{left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));width:auto}}'`,
  'guide styles',
)

client = replaceOnce(
  client,
`    const ONBOARDING_STORAGE_KEY = 'dsh-vision-router:onboarding:auto-vision-v1'
    function installOnboarding(t) {`,
`    const ONBOARDING_STORAGE_KEY = 'dsh-vision-router:onboarding:model-guide-v2'
    const VISION_GUIDE_STORAGE_KEY = 'dsh-vision-router:guide:vision-backend-v1'
    const VISION_GUIDE_EVENT = 'dsh-vision-router:vision-settings-guide'
    let visionGuidePrompt

    function readVisionGuideActive() {
      try {
        return !!(window.localStorage && window.localStorage.getItem(VISION_GUIDE_STORAGE_KEY) === 'active')
      } catch {
        return false
      }
    }
    function writeVisionGuideActive(active) {
      try {
        if (!window.localStorage) return
        if (active) window.localStorage.setItem(VISION_GUIDE_STORAGE_KEY, 'active')
        else window.localStorage.removeItem(VISION_GUIDE_STORAGE_KEY)
      } catch {
        // Best effort only; the current page can still run the guide.
      }
    }
    function removeVisionGuidePrompt() {
      if (visionGuidePrompt) visionGuidePrompt.remove()
      visionGuidePrompt = undefined
    }
    function notifyVisionGuideChanged() {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
      const EventCtor = window.Event
      if (typeof EventCtor === 'function') window.dispatchEvent(new EventCtor(VISION_GUIDE_EVENT))
    }
    function syncVisionGuidePrompt(t) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      if (!readVisionGuideActive()) {
        removeVisionGuidePrompt()
        return
      }
      if (document.querySelector('[data-vr-guide-target="vision-backend"]')) {
        removeVisionGuidePrompt()
        return
      }
      if (visionGuidePrompt || !document.body) return
      const prompt = document.createElement('div')
      prompt.className = 'vr-guide-prompt'
      prompt.setAttribute('role', 'status')
      const title = document.createElement('div')
      title.className = 'vr-guide-prompt-title'
      title.textContent = t('guidePromptTitle')
      const body = document.createElement('p')
      body.className = 'vr-guide-prompt-body'
      body.textContent = t('guidePromptBody')
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'vr-btn'
      cancel.textContent = t('guidePromptCancel')
      cancel.addEventListener('click', () => {
        writeVisionGuideActive(false)
        removeVisionGuidePrompt()
        notifyVisionGuideChanged()
      })
      prompt.append(title, body, cancel)
      document.body.appendChild(prompt)
      visionGuidePrompt = prompt
    }
    function startVisionSettingsGuide(t) {
      writeVisionGuideActive(true)
      syncVisionGuidePrompt(t)
      notifyVisionGuideChanged()
    }
    function finishVisionSettingsGuide() {
      writeVisionGuideActive(false)
      removeVisionGuidePrompt()
      notifyVisionGuideChanged()
    }
    function installVisionSettingsGuide(t) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      const sync = () => window.setTimeout(() => syncVisionGuidePrompt(t), 0)
      syncVisionGuidePrompt(t)
      window.addEventListener(VISION_GUIDE_EVENT, sync)
      window.addEventListener('popstate', sync)
      return () => {
        window.removeEventListener(VISION_GUIDE_EVENT, sync)
        window.removeEventListener('popstate', sync)
        removeVisionGuidePrompt()
      }
    }

    function installOnboarding(t) {`,
  'guide state helpers',
)

client = replaceOnce(
  client,
`        const example = document.createElement('div')
        example.className = 'vr-onboarding-example'
        const exampleLabel = document.createElement('span')
        exampleLabel.className = 'vr-onboarding-example-label'
        exampleLabel.textContent = t('onboardingExampleLabel')
        const exampleValue = document.createElement('span')
        exampleValue.className = 'vr-onboarding-example-value'
        exampleValue.textContent = t('onboardingExample')
        example.append(exampleLabel, exampleValue)

        const foot = document.createElement('p')
        foot.className = 'vr-onboarding-text'
        foot.textContent = t('onboardingFoot')`,
`        const steps = document.createElement('div')
        steps.className = 'vr-onboarding-steps'
        for (const index of [1, 2, 3]) {
          const step = document.createElement('div')
          step.className = 'vr-onboarding-step'
          const stepTitle = document.createElement('div')
          stepTitle.className = 'vr-onboarding-step-title'
          stepTitle.textContent = t('onboardingStep' + index + 'Title')
          const stepBody = document.createElement('p')
          stepBody.className = 'vr-onboarding-step-body'
          stepBody.textContent = t('onboardingStep' + index + 'Body')
          step.append(stepTitle, stepBody)
          steps.appendChild(step)
        }`,
  'onboarding steps',
)

client = replaceOnce(
  client,
`        const actions = document.createElement('div')
        actions.className = 'vr-onboarding-actions'
        const primary = document.createElement('button')
        primary.type = 'button'
        primary.className = 'vr-onboarding-primary'
        primary.textContent = t('onboardingGotIt')
        primary.addEventListener('click', dismiss)
        actions.appendChild(primary)

        dialog.append(title, body, example, foot, close, actions)`,
`        const actions = document.createElement('div')
        actions.className = 'vr-onboarding-actions'
        const secondary = document.createElement('button')
        secondary.type = 'button'
        secondary.className = 'vr-onboarding-secondary'
        secondary.textContent = t('onboardingLater')
        secondary.addEventListener('click', dismiss)
        const primary = document.createElement('button')
        primary.type = 'button'
        primary.className = 'vr-onboarding-primary'
        primary.textContent = t('onboardingGuide')
        primary.addEventListener('click', () => {
          startVisionSettingsGuide(t)
          dismiss()
        })
        actions.append(secondary, primary)

        dialog.append(title, body, steps, close, actions)`,
  'onboarding actions',
)

client = replaceOnce(
  client,
`      const [selfUpdateState, setSelfUpdateState] = useState({ status: 'idle', result: undefined })
      const [showAdvanced, setShowAdvanced] = useState(false)`,
`      const [selfUpdateState, setSelfUpdateState] = useState({ status: 'idle', result: undefined })
      const [guideActive, setGuideActive] = useState(() => readVisionGuideActive())
      const [showAdvanced, setShowAdvanced] = useState(false)`,
  'guide component state',
)

client = replaceOnce(
  client,
`      const visionModelVisible = (providerId, modelId) =>
        typeof modelId === 'string' && visionModelsFor(providerId).some((entry) => entry.id === modelId)
      const loadCatalog = () => {`,
`      const visionModelVisible = (providerId, modelId) =>
        typeof modelId === 'string' && visionModelsFor(providerId).some((entry) => entry.id === modelId)
      React.useEffect(() => {
        const refreshGuide = () => setGuideActive(readVisionGuideActive())
        window.addEventListener(VISION_GUIDE_EVENT, refreshGuide)
        refreshGuide()
        return () => window.removeEventListener(VISION_GUIDE_EVENT, refreshGuide)
      }, [])
      React.useEffect(() => {
        if (!guideActive) return
        if (!open) setOpen(true)
        const timer = window.setTimeout(() => {
          const target = document.getElementById('vr-vision-backend-chain')
          if (!target) return
          removeVisionGuidePrompt()
          if (typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
          if (typeof target.focus === 'function') target.focus({ preventScroll: true })
        }, 220)
        return () => window.clearTimeout(timer)
      }, [guideActive, open, catalog.status, visionCaps.status])
      const loadCatalog = () => {`,
  'guide component effects',
)

client = replaceOnce(
  client,
`      const chainEditor = () => {
        const value = format('providers')`,
`      const finishGuide = () => {
        finishVisionSettingsGuide()
        setGuideActive(false)
      }
      const guideCallout = () =>
        guideActive
          ? h('div', { className: 'vr-guide-callout' },
              h('div', { className: 'vr-guide-callout-title' }, t('guideChainTitle')),
              h('p', { className: 'vr-guide-callout-body' }, t('guideChainBody')),
              h('button', { type: 'button', className: 'vr-btn vr-btn-save', onClick: finishGuide }, t('guideDone')),
            )
          : null
      const chainEditor = () => {
        const value = format('providers')`,
  'guide callout helper',
)

client = replaceOnce(
  client,
`        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('chainLabel')),`,
`        return h('div', {
          className: 'vr-field' + (guideActive ? ' vr-guide-target' : ''),
          id: 'vr-vision-backend-chain',
          'data-vr-guide-target': 'vision-backend',
          tabIndex: guideActive ? -1 : undefined,
        },
          guideCallout(),
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('chainLabel')),`,
  'chain guide target',
)

client = replaceOnce(
  client,
`              h('div', { className: 'vr-quickstart' },
                h('div', { className: 'vr-quickstart-title' }, t('quickStartTitle')),
                h('p', { className: 'vr-quickstart-body' }, t('quickStartBody')),
                h('p', { className: 'vr-quickstart-live' }, t('quickStartLive')),
              ),`,
`              h('div', { className: 'vr-quickstart' },
                h('div', { className: 'vr-quickstart-title' }, t('quickStartTitle')),
                h('p', { className: 'vr-quickstart-body' }, t('quickStartBody')),
                h('p', { className: 'vr-quickstart-live' }, t('quickStartLive')),
                h('div', { className: 'vr-quickstart-actions' },
                  h('button', {
                    type: 'button', className: 'vr-btn',
                    onClick: () => startVisionSettingsGuide(t),
                  }, t('quickStartGuide')),
                ),
              ),`,
  'quickstart guide button',
)

client = replaceOnce(
  client,
`              catalogReady
                ? chainEditor()
                : textField('providers', t('textProviders'), t('textProvidersHint'), true),`,
`              catalogReady
                ? chainEditor()
                : h('div', {
                    className: guideActive ? 'vr-guide-target' : '',
                    id: 'vr-vision-backend-chain',
                    'data-vr-guide-target': 'vision-backend',
                    tabIndex: guideActive ? -1 : undefined,
                  },
                    guideCallout(),
                    textField('providers', t('textProviders'), t('textProvidersHint'), true),
                  ),`,
  'fallback guide target',
)

client = replaceOnce(
  client,
`      ctx.effect(installStyles, 'vision-router: card styles')
      ctx.effect(() => installOnboarding(t), 'vision-router: first-run onboarding')`,
`      ctx.effect(installStyles, 'vision-router: card styles')
      ctx.effect(() => installVisionSettingsGuide(t), 'vision-router: model selection guide')
      ctx.effect(() => installOnboarding(t), 'vision-router: first-run onboarding')`,
  'guide lifecycle',
)

writeFileSync(clientPath, client)

const testPath = 'tests/client.test.js'
let tests = readFileSync(testPath, 'utf8')
tests += `\n\ntest('model-selection guide separates session and vision models and targets the vision chain', () => {\n  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')\n  assert.match(source, /onboardingStep1Title: '1 · 会话 \/ 文字模型'/)\n  assert.match(source, /onboardingStep2Body: '打开「设置 → 插件 → Vision Router」/)\n  assert.match(source, /onboardingStep1Title: '1 · Session \/ text model'/)\n  assert.match(source, /Settings → Plugins → Vision Router/)\n  assert.match(source, /VISION_GUIDE_STORAGE_KEY = 'dsh-vision-router:guide:vision-backend-v1'/)\n  assert.match(source, /startVisionSettingsGuide\\(t\\)/)\n  assert.match(source, /id: 'vr-vision-backend-chain'/)\n  assert.match(source, /'data-vr-guide-target': 'vision-backend'/)\n  assert.match(source, /target\.scrollIntoView\\(\\{ behavior: 'smooth', block: 'center' \\}\\)/)\n  assert.match(source, /if \(!open\) setOpen\\(true\\)/)\n})\n`
writeFileSync(testPath, tests)

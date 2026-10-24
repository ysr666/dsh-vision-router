import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import {
  SETTINGS_IA_CLIENT_PRELUDE,
  injectSettingsIaClientPrelude,
  installSettingsIaClientPrelude,
} from '../lib/settings-ia-client-prelude.js'

function reactStub(stateValues = []) {
  let stateIndex = 0
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useMemo(factory) { return factory() },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) {
      const index = stateIndex++
      const value = index < stateValues.length ? stateValues[index] : initial
      return [value, () => {}]
    },
    useEffect() {},
    useRef(initial) { return { current: initial } },
  }
}

function walk(node, visit) {
  if (node === undefined || node === null || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    visit(node)
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit))
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of Array.isArray(node.children) ? node.children : []) walk(child, visit)
}

function textOf(tree) {
  const parts = []
  walk(tree, (node) => {
    if (typeof node === 'string' || typeof node === 'number') parts.push(String(node))
  })
  return parts.join(' ')
}

function baseSettings(overrides = {}) {
  return {
    providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
    freeFallback: true,
    tool: true,
    structuredVisionBootstrap: false,
    visionDepth: 'standard',
    visionDepthMaxCalls: 0,
    guidanceOverrides: [],
    localOllama: { enabled: false, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', format: 'openai' },
    localLmStudio: { enabled: false, baseURL: 'http://localhost:1234/v1', model: '', format: 'openai' },
    desktopScreenshot: false,
    downscale: true,
    downscaleMaxPixels: 4000000,
    cache: true,
    cacheTtlSeconds: 3600,
    cacheMaxEntries: 200,
    timeoutMs: 120000,
    visionTaskTimeoutMs: 120000,
    visionTurnBudgetMs: 0,
    ocrTimeoutMs: 30000,
    ocrEngine: 'auto',
    freeCloudFirst: false,
    autoWrapProviders: true,
    wrappedProviders: [{ provider: 'deepseek-official', models: [] }],
    allowRemoteSettings: false,
    proxy: '',
    proxyHosts: [],
    rewriteImages: true,
    routing: false,
    reverseRouting: true,
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    progressiveTools: false,
    stealth: false,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
    extraVisionModels: [],
    ...overrides,
  }
}

function createHarness(React, { value = baseSettings(), local = true, location, storage } = {}) {
  let captured
  const loader = { load(spec) { captured = spec } }
  const sandbox = {
    window: {
      __ModuleLoader__: loader,
      location: location ?? { protocol: 'http:', hostname: local ? '127.0.0.1' : '10.0.0.20' },
      localStorage: storage,
    },
    document: { documentElement: { lang: 'zh-CN' } },
    Object,
    Promise,
    Array,
    String,
    Number,
    Map,
    Set,
    WeakMap,
    Reflect,
    JSON,
  }
  vm.runInNewContext(SETTINGS_IA_CLIENT_PRELUDE, sandbox)

  let registeredComponent
  const OriginalSection = function OriginalSection() { return { type: 'legacy-section' } }
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) {
          ctx.slots.register(
            { name: 'settings.section', id: 'vision-router', order: 12 },
            OriginalSection,
          )
        },
      }
    },
  })

  const plugin = captured.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  const ctx = {
    slots: {
      register(_options, component) {
        registeredComponent = component
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return { status: 'ready', writable: true, value } },
    async set() {},
    async load() {},
  }
  return { registeredComponent, OriginalSection, scope }
}

test('settings IA publishes both script and stylesheet on the Desktop structured carrier', () => {
  const listeners = []
  const ctx = {
    inject(_deps, callback) {
      callback({
        on(name, listener) { listeners.push([name, listener]) },
        effect(factory) { factory() },
        webServer: { tapIndex() { return () => {} } },
      })
    },
  }
  installSettingsIaClientPrelude(ctx)
  const rows = []
  for (const [name, listener] of listeners) {
    assert.equal(name, 'webserver/index-inject')
    listener(rows)
  }
  assert.equal(rows.filter((row) => row.kind === 'script' && row.text.includes('data-vision-router-settings-ia')).length, 1)
  assert.equal(rows.filter((row) => row.kind === 'style' && row.text.includes('data-vision-router-settings-ia:style')).length, 1)
})

test('v3.1: cloud upload guidance points to the actual save action and supports persistent dismissal', () => {
  const data = new Map()
  const storage = {
    getItem(key) { return data.get(key) ?? null },
    setItem(key, value) { data.set(key, String(value)) },
    removeItem(key) { data.delete(key) },
  }
  const render = () => {
    const { registeredComponent, scope } = createHarness(reactStub(), { storage })
    return registeredComponent({ scope })
  }
  const findButton = (tree, label) => {
    let found
    walk(tree, (node) => {
      if (node?.type === 'button' && node.children?.includes(label)) found = node
    })
    return found
  }
  const first = render()
  assert.match(textOf(first), /要停止上传，请在本页开启「仅本地视觉」，然后点击「保存」/)
  assert.match(textOf(first), /云端聊天模型仍可能收到识图结果文字/)
  const dismiss = findButton(first, '不再提醒')
  assert.ok(dismiss)
  dismiss.props.onClick()
  assert.equal(data.size, 1)

  const next = render()
  assert.doesNotMatch(textOf(next), /数据流向：云端识图/)
  assert.match(textOf(next), /云端识图可能上传图片/)
  const reopen = findButton(next, '查看如何关闭出网')
  assert.ok(reopen)
  reopen.props.onClick()
  assert.equal(data.size, 0)
  assert.match(textOf(render()), /要停止上传，请在本页开启「仅本地视觉」/)
})

test('v3.1: remote view explains where to disable uploads and hidden notice never changes local-only policy', () => {
  const { registeredComponent, scope } = createHarness(reactStub(), { local: false })
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /在运行 DSH 的电脑上打开「设置 → Vision Router → 常规」/)
  assert.match(text, /开启「仅本地视觉」并保存/)
  assert.doesNotMatch(text, /在本页开启「仅本地视觉」，然后点击「保存」/)

  const store = { getItem() { return '1' }, setItem() {}, removeItem() {} }
  const local = createHarness(reactStub(), {
    value: baseSettings({ localOnlyVision: true }),
    storage: store,
  })
  const localText = textOf(local.registeredComponent({ scope: local.scope }))
  assert.match(localText, /图片只发给本机视觉模型/)
  assert.doesNotMatch(localText, /不再提醒/)
})

test('v3.1: storage failure cannot prevent a visible default privacy warning', () => {
  const storage = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }
  const { registeredComponent, scope } = createHarness(reactStub(), { storage })
  const tree = registeredComponent({ scope })
  assert.match(textOf(tree), /数据流向：云端识图/)
  let button
  walk(tree, (node) => { if (node?.type === 'button' && node.children?.includes('不再提醒')) button = node })
  assert.ok(button)
  assert.doesNotThrow(() => button.props.onClick())
})

test('v3.1: ordinary settings retain short visible cloud disclosure without overwhelming detail', () => {
  const { registeredComponent, scope } = createHarness(reactStub())
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /数据流向：云端识图/)
  assert.match(text, /免费或免 Key 不等于离线/)
  assert.match(text, /识图结果文字仍可能发给云端聊天模型/)
  assert.doesNotMatch(text, /严格纯本地还需同时选择本地聊天模型/)
})

test('v3.1: local-only explanation still discloses cloud chat text egress', () => {
  const { registeredComponent, scope } = createHarness(reactStub(), {
    value: baseSettings({ localOnlyVision: true }),
  })
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /图片只发给本机视觉模型/)
  assert.match(text, /识图结果仍交给当前聊天模型/)
  assert.match(text, /结果文字可能出网/)
  assert.doesNotMatch(text, /数据流向：云端识图/)
})

test('v3.1: Host text-only evidence takes priority over image inference and offers a concrete fix', () => {
  const React = reactStub([
    'general', {}, undefined, undefined, undefined, { status: 'idle' },
    { status: 'ready', groups: [{ id: 'openrouter', models: [{ id: 'qwen-vl' }] }] },
    { ollama: false, lmstudio: false, developer: false },
    { status: 'ready', capabilities: { openrouter: { 'qwen-vl': {
      image: true,
      hostInputModalities: ['text'],
      inputModalities: ['text', 'image'],
    } } } },
  ])
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({ providers: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }] }),
  })
  const tree = registeredComponent({ scope })
  const text = textOf(tree)
  assert.match(text, /有模型可能看不了图片/)
  assert.match(text, /设置 → 模型/)
  assert.match(text, /旧版 DSH 怎么设置？/)
  assert.match(text, /重新检测/)
  const readiness = []
  walk(tree, (node) => { if (node?.props?.['data-vr-model-readiness']) readiness.push(node.props['data-vr-model-readiness']) })
  assert.deepEqual(readiness, ['text-only'])
  assert.doesNotMatch(text, /识图已就绪/)
})

test('v3.1: normal users see no premature alert while capability metadata loads', () => {
  const React = reactStub([
    'general', {}, undefined, undefined, undefined, { status: 'idle' },
    { status: 'ready', groups: [{ id: 'openrouter', models: [{ id: 'qwen-vl' }] }] },
    { ollama: false, lmstudio: false, developer: false },
    { status: 'loading', capabilities: {} },
  ])
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({ providers: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }] }),
  })
  const tree = registeredComponent({ scope })
  const text = textOf(tree)
  assert.match(text, /已添加识图模型/)
  assert.doesNotMatch(text, /还不能确认这个模型是否能识图/)
  const readiness = []
  walk(tree, (node) => { if (node?.props?.['data-vr-model-readiness']) readiness.push(node.props['data-vr-model-readiness']) })
  assert.deepEqual(readiness, [])
})

test('v3.1: image declaration is evidence only, not a claimed successful image delivery', () => {
  const React = reactStub([
    'general', {}, undefined, undefined, undefined, { status: 'idle' },
    { status: 'ready', groups: [{ id: 'openrouter', models: [{ id: 'qwen-vl' }] }] },
    { ollama: false, lmstudio: false, developer: false },
    { status: 'ready', capabilities: { openrouter: { 'qwen-vl': {
      image: true, hostInputModalities: ['text', 'image'],
    } } } },
  ])
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({ providers: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }] }),
  })
  const tree = registeredComponent({ scope })
  const text = textOf(tree)
  assert.match(text, /已添加识图模型/)
  assert.doesNotMatch(text, /图片能力有声明或可信证据/)
  assert.doesNotMatch(text, /有模型可能看不了图片/)
  const readiness = []
  walk(tree, (node) => { if (node?.props?.['data-vr-model-readiness']) readiness.push(node.props['data-vr-model-readiness']) })
  assert.deepEqual(readiness, [])
})

test('v3.1: capability unknown, missing metadata and structurally blocked models remain fail-closed in readiness copy', () => {
  const states = (capabilities, status = 'ready') => [
    'general', {}, undefined, undefined, undefined, { status: 'idle' },
    { status: 'ready', groups: [{ id: 'openrouter', models: [{ id: 'qwen-vl' }] }] },
    { ollama: false, lmstudio: false, developer: false },
    { status, capabilities },
  ]
  const value = baseSettings({ providers: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }] })
  const render = (capabilities, status) => {
    const { registeredComponent, scope } = createHarness(reactStub(states(capabilities, status)), { value })
    return textOf(registeredComponent({ scope }))
  }
  assert.match(render({}, 'ready'), /还不能确认这个模型是否能识图/)
  assert.match(render({}, 'error'), /还不能确认这个模型是否能识图/)
  assert.match(render({ openrouter: { 'qwen-vl': { attemptable: false, image: true } } }), /有模型暂时不可用/)
})

test('settings IA prelude injects once', () => {
  const html = '<html><head></head><body></body></html>'
  const once = injectSettingsIaClientPrelude(html)
  assert.match(once, /data-vision-router-settings-ia/)
  assert.equal(injectSettingsIaClientPrelude(once), once)
})

test('settings IA replaces the legacy section and exposes five second-level destinations', () => {
  const React = reactStub()
  const { registeredComponent, OriginalSection, scope } = createHarness(React)
  assert.notEqual(registeredComponent, OriginalSection)

  const tree = registeredComponent({ scope })
  const text = textOf(tree)
  for (const label of ['常规', '识图策略', '本地与设备', '高级', '诊断']) assert.match(text, new RegExp(label))
  assert.match(text, /内置免费识图/)
})

test('general page keeps the happy path focused on model chain and free fallback', () => {
  const React = reactStub()
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({
      providers: [
        { provider: 'openrouter', model: 'qwen-vl', fallbacks: [] },
        { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
      ],
    }),
  })
  const tree = registeredComponent({ scope })
  const text = textOf(tree)
  assert.match(text, /已添加识图模型/)
  assert.match(text, /识图模型/)
  assert.match(text, /内置免费兜底/)
  assert.match(text, /数据流向/)
  assert.match(text, /免费或免 Key 不等于离线/)
  assert.match(text, /远程 OVHcloud 服务/)
  assert.doesNotMatch(text, /整轮视觉路由（旧工作流）/)
  assert.doesNotMatch(text, /渐进式工具暴露/)
})

test('active local-only vision discloses the derived-text boundary in context', () => {
  const React = reactStub()
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({ localOnlyVision: true }),
  })
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /图片只发给本机视觉模型/)
  assert.match(text, /识图结果仍交给当前聊天模型/)
  assert.match(text, /结果文字可能出网/)
  assert.match(text, /识图结果文字仍可能发给云端聊天模型/)

  const remoteReact = reactStub()
  const remote = createHarness(remoteReact, {
    local: false,
    value: baseSettings({ localOnlyVision: true }),
  })
  const remoteText = textOf(remote.registeredComponent({ scope: remote.scope }))
  assert.match(remoteText, /识图结果仍交给当前聊天模型/)
  assert.match(remoteText, /结果文字可能出网/)
})

test('strategy page groups tool usage, 1+x depth, independent call cap, and custom guidance together', () => {
  const React = reactStub([
    'strategy',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: false },
  ])
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({ structuredVisionBootstrap: true, visionDepth: 'custom', visionDepthMaxCalls: 4 }),
  })
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /Agent 按需使用识图工具/)
  assert.match(text, /结构化预识别（1\+x）/)
  assert.match(text, /看图深度/)
  assert.match(text, /限制深挖次数/)
  assert.match(text, /最多深挖次数/)
  assert.match(text, /自定义识图引导/)
})

test('local page keeps Ollama, LM Studio, and desktop capture out of the general path', () => {
  const React = reactStub([
    'local',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: false },
  ])
  const { registeredComponent, scope } = createHarness(React)
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /Ollama/)
  assert.match(text, /LM Studio/)
  assert.match(text, /云端识图行或免费兜底仍开启/)
  assert.match(text, /识图结果也会交给当前聊天模型/)
  assert.match(text, /允许 Agent 读取桌面截图/)
})

test('advanced page consolidates performance, wrapper scope, compatibility, network, and aggregate budget', () => {
  const React = reactStub([
    'advanced',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: true },
  ])
  const { registeredComponent, scope } = createHarness(React)
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /性能与稳定性/)
  assert.match(text, /整轮视觉工具上限/)
  assert.match(text, /OCR 默认引擎/)
  assert.match(text, /仅视觉模型/)
  assert.match(text, /不限制（推荐）/)
  assert.match(text, /识图模式范围/)
  assert.match(text, /自动允许已启用模型使用识图/)
  assert.match(text, /网络与远程/)
  assert.match(text, /兼容模式/)
  assert.match(text, /整轮视觉路由（旧工作流）/)
  assert.match(text, /开发者设置/)
  assert.match(text, /渐进式工具暴露/)
  assert.match(text, /保存后需重启 DSH 才生效/)
})

test('diagnostics reports the vision-result destination without claiming end-to-end locality', () => {
  const React = reactStub([
    'diagnostics',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: false },
  ])
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({ localOnlyVision: true }),
  })
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /识图结果去向/)
  assert.match(text, /当前聊天模型（可能为云端）/)
})


test('H3 keeps proxy advanced/local-only while blank developer routes restore defaults', async () => {
  assert.match(SETTINGS_IA_CLIENT_PRELUDE, /key==='proxy'\|\|key==='wrapperRoute'\|\|key==='chainRoute'/)
  assert.match(SETTINGS_IA_CLIENT_PRELUDE, /return text\?\{value:text\}:\{clear:true\}/)

  const React = reactStub([
    'advanced', {}, undefined, undefined, undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: true },
  ])
  const local = createHarness(React, { local: true })
  const localText = textOf(local.registeredComponent({ scope: local.scope }))
  assert.match(localText, /视觉专用代理覆盖/)
  assert.match(localText, /视觉代理覆盖域名/)
  assert.match(localText, /视觉链路由名/)

  const remoteReact = reactStub([
    'advanced', {}, undefined, undefined, undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: true },
  ])
  const remote = createHarness(remoteReact, { local: false })
  const remoteText = textOf(remote.registeredComponent({ scope: remote.scope }))
  assert.doesNotMatch(remoteText, /视觉专用代理覆盖/)
  assert.doesNotMatch(remoteText, /视觉代理覆盖域名/)
})

test('remote view does not expose local backend and privileged network controls', () => {
  const React = reactStub([
    'local',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: false },
  ])
  const { registeredComponent, scope } = createHarness(React, { local: false })
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /只能在运行 DSH 的机器上配置/)
  assert.doesNotMatch(text, /允许 Agent 读取桌面截图/)
})

test('official Desktop origin is local without trusting lookalike app origins', () => {
  function renderAt(location) {
    const React = reactStub([
      'local', {}, undefined, undefined, undefined,
      { status: 'idle', error: undefined },
      { status: 'ready', groups: [] },
      { ollama: false, lmstudio: false, developer: false },
    ])
    const harness = createHarness(React, { location })
    return textOf(harness.registeredComponent({ scope: harness.scope }))
  }

  const desktop = renderAt({ protocol: 'dsh-app:', hostname: 'app' })
  assert.match(desktop, /允许 Agent 读取桌面截图/)
  assert.doesNotMatch(desktop, /只能在运行 DSH 的机器上配置/)

  for (const location of [
    { protocol: 'https:', hostname: 'app' },
    { protocol: 'dsh-app:', hostname: 'evil' },
    { protocol: 'other-app:', hostname: 'app' },
  ]) {
    const text = renderAt(location)
    assert.match(text, /只能在运行 DSH 的机器上配置/)
    assert.doesNotMatch(text, /允许 Agent 读取桌面截图/)
  }
})

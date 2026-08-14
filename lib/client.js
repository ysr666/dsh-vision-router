// dsh-vision-router browser half: the 设置 > 插件 > 插件配置 card that edits
// the `vision-router` settings section owned by the host half. Self-contained
// by hand (no bundler in this repo): the client module system wraps it in a
// CJS factory and the kernel adopts { apply, inject } as a client plugin.
window.__ModuleLoader__.load({
  id: 'dsh-vision-router',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useMemo } = React

    // ── locale dictionaries (follow the app's language setting) ─────────────
    const NS = 'vision-router'
    const zh = {
      nav: '视觉路由（自动识图）',
      desc: '默认即用内置免费视觉模型；已配置的模型可直接选择，细节收在高级设置里 · 面板 v5',
      pending: '未保存',
      readOnly: '当前设置提供方只读。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidProviders: '每行需为「provider/model」，例如 openrouter/qwen3-vl-235b',
      invalidTextProvider: '格式为「provider/model」，例如 deepseek-official/deepseek-v4-pro',
      invalidTimeout: '需为 ≥1000 的整数（毫秒）',
      invalidGeneric: '输入无效',
      selectProvider: '选择供应商…',
      selectModel: '选择模型…',
      pickProviderFirst: '先选供应商',
      freeTag: '（免费）',
      builtinFreeTag: '（内置免费模型）',
      chainLabel: '视觉模型链（按顺序失败回退）',
      chainHint: '第一行是主视觉模型，后面的行在其失败时依次回退；清空 = 仅用内置免费模型兜底。',
      addFallback: '+ 添加备用模型',
      remove: '移除',
      removeTitle: '移除这一行',
      textModelLabel: '文本模型（文字轮走它）',
      textModelHint: '通常无需设置；见上方说明，留空即恢复默认。',
      defaultChainNote:
        '默认用内置免费视觉模型（免注册、免 Key）；「设置 > 模型」里配过的供应商会出现在下面的下拉里，' +
        '选了才覆盖默认，不选就是默认。',
      catalogLoading: '正在加载模型目录（与「设置 > 模型」同源）…',
      catalogUnavailable: '连接服务不可用（拿不到模型目录），退回手动输入。',
      catalogTimeout: '目录请求超时（15 秒）',
      catalogEmpty: '模型目录为空：',
      catalogErrorEnvelope: '模型目录接口返回失败',
      catalogError: '模型目录不可用（',
      catalogFallback: '），模型字段已退回手动输入。',
      retryCatalog: '重试加载目录',
      advanced: '高级设置',
      groupTextModel: '文本模型（仅特殊场景）',
      textModelGroupHint:
        '平时文字轮直接使用右下角选择的会话模型，无需设置；此字段仅在开启' +
        '「图片轮整轮自动路由」且会话入口为视觉路由时，作为文字轮的回退模型。',
      groupBehavior: '行为开关',
      groupParams: '参数',
      groupRoutes: '路由名',
      groupProxy: '代理',
      proxyLabel: '代理地址',
      proxyHint: '如 http://127.0.0.1:10808 或 socks5h://127.0.0.1:10808；留空关闭。修改即时生效。',
      proxyHostsLabel: '走代理的域名（每行一个）',
      proxyHostsHint: '仅这些域名经代理，其余直连；留空清除覆盖。修改即时生效。',
      saveFailed: '保存失败：宿主拒绝了本次写入，请重试。',
      discard: '放弃修改',
      save: '保存',
      saving: '保存中…',
      renderFailed: '设置卡渲染失败：',
      toggleRouting: '图片轮整轮自动路由',
      toggleReverseRouting: '文字轮反向路由',
      toggleTool: '识图工具',
      toggleRewriteImages: '图片块改写',
      toggleDownscale: '图片自动压缩',
      toggleCache: '识图答案缓存',
      toggleFreeFallback: '免费兜底',
      toggleStealth: '隐身模式',
      hintRouting:
        '默认关闭：图片轮不整轮切到视觉模型，而是像普通文本轮一样由会话模型调用 ' +
        'vision_describe 等工具看图，可连续多步操作（定位→裁剪→对比…）。' +
        '开启后恢复旧的整轮一次性自动识图行为；注意：开启时降级链只包含 ' +
        '「视觉模型链」里的 provider+fallbacks，httpProviders（含免费兜底端点）不参与。',
      hintReverseRouting: '开启图片轮整轮路由时，把纯文字轮反向路由回文本模型；默认开启。',
      hintTool: 'vision_describe / vision_ground 等像素级视觉工具；关闭后这些工具不可用。',
      hintRewriteImages:
        '把消息里的图片块替换为文字：已有视觉记录就给出记录，否则给出附件标记，' +
        '文本模型始终不会收到它看不懂的图片内容。',
      hintDownscale: '超过像素预算的图片先缩放再送视觉模型，降低延迟与成本；默认开启。',
      hintCache: '缓存识图答案（按图片内容 + 问题）；默认开启。',
      hintFreeFallback: '未显式配置 httpProviders 时启用内置免 Key 免费端点兜底；默认开启。',
      hintStealth:
        '接管官方 DeepSeek 路由，模型选择器保持原样。需在 profile 补丁层 ' +
        '（cordis.patch.yml）禁用官方 llm-deepseek 行后才真正接管；官方行还在时 ' +
        '插件自动回退为选择器里的「自动识图」包装路由。改动后需重启 dsh 生效。',
      numTimeoutMs: '视觉请求超时（毫秒）',
      numDownscaleMaxPixels: '图片像素预算',
      numCacheTtlSeconds: '缓存有效期（秒）',
      numCacheMaxEntries: '缓存条目上限',
      numHintTimeoutMs: '单个视觉请求超时；默认 120000。',
      numHintDownscaleMaxPixels: '约 8MP = 8000000；超过的图先缩放再送视觉模型。',
      numHintCacheTtlSeconds: '视觉答案缓存有效期；0 = 永久；默认 3600。',
      numHintCacheMaxEntries: '缓存 LRU 容量；默认 200。',
      textWrapperRoute: '包装路由名',
      textChainRoute: '视觉链路由名',
      textHintWrapperRoute: '模型选择器里显示的「自动识图」入口路由名。',
      textHintChainRoute: '视觉链的挂载路由名（识图工具经由真实 provider 直接调用，不经过它）。',
      textProviders: '视觉模型链',
      textProvidersHint: '每行一个「provider/model」，从上到下失败回退；留空清除用户覆盖。',
      textTextProvider: '文本模型',
      textTextProviderHint: '格式「provider/model」。',
    }
    const en = {
      nav: 'Vision Router (auto image understanding)',
      desc: 'Built-in free vision model by default; configured models become selectable, details under Advanced · panel v5',
      pending: 'Unsaved',
      readOnly: 'The active settings provider is read-only.',
      overridden: 'Overridden',
      reset: 'Reset',
      invalidProviders: 'Each line must be "provider/model", e.g. openrouter/qwen3-vl-235b',
      invalidTextProvider: 'Format "provider/model", e.g. deepseek-official/deepseek-v4-pro',
      invalidTimeout: 'Must be an integer ≥ 1000 (milliseconds)',
      invalidGeneric: 'Invalid input',
      selectProvider: 'Select provider…',
      selectModel: 'Select model…',
      pickProviderFirst: 'Pick a provider first',
      freeTag: ' (free)',
      builtinFreeTag: ' (built-in free model)',
      chainLabel: 'Vision chain (top-down failover)',
      chainHint: 'The first row is the primary vision model; later rows are tried in order on failure. Empty = the built-in free fallback only.',
      addFallback: '+ Add fallback model',
      remove: 'Remove',
      removeTitle: 'Remove this row',
      textModelLabel: 'Text model (text turns use it)',
      textModelHint: 'Usually unneeded; leave empty to restore the default.',
      defaultChainNote:
        'The built-in free vision model (no signup, no key) is the default; providers configured in ' +
        'Settings → Models appear in the dropdowns below. Picking one overrides the default; not picking keeps it.',
      catalogLoading: 'Loading the model catalog (same source as Settings → Models)…',
      catalogUnavailable: 'Connection service unavailable (no model catalog); falling back to free-text input.',
      catalogTimeout: 'Catalog request timed out (15s)',
      catalogEmpty: 'Model catalog is empty: ',
      catalogErrorEnvelope: 'The model catalog endpoint failed',
      catalogError: 'Model catalog unavailable (',
      catalogFallback: '); model fields fell back to free-text input.',
      retryCatalog: 'Retry catalog',
      advanced: 'Advanced settings',
      groupTextModel: 'Text model (special cases only)',
      textModelGroupHint:
        'Text turns normally use the session model picked in the composer; this field only acts as the ' +
        'text-turn fallback when whole-turn routing is on and the session entry is a vision route.',
      groupBehavior: 'Behavior',
      groupParams: 'Parameters',
      groupRoutes: 'Route names',
      groupProxy: 'Proxy',
      proxyLabel: 'Proxy URL',
      proxyHint: 'e.g. http://127.0.0.1:10808 or socks5h://127.0.0.1:10808; empty disables. Applies immediately.',
      proxyHostsLabel: 'Proxied hosts (one per line)',
      proxyHostsHint: 'Only these hosts go through the proxy; everything else stays direct. Empty clears the override. Applies immediately.',
      saveFailed: 'Save failed: the host rejected this write, please retry.',
      discard: 'Discard',
      save: 'Save',
      saving: 'Saving…',
      renderFailed: 'Settings card failed to render: ',
      toggleRouting: 'Whole-turn vision routing',
      toggleReverseRouting: 'Reverse routing for text turns',
      toggleTool: 'Vision tools',
      toggleRewriteImages: 'Image-block rewriting',
      toggleDownscale: 'Auto downscale',
      toggleCache: 'Vision answer cache',
      toggleFreeFallback: 'Free fallback',
      toggleStealth: 'Stealth mode',
      hintRouting:
        'Off by default: image turns are not switched to the vision model as a whole; instead the ' +
        'session model looks at images through vision_describe and friends like any tool call, enabling ' +
        'continuous multi-step work (ground → crop → diff → …). Turning it on restores the legacy one-shot ' +
        'whole-turn behavior. Note: with routing on, the fallback chain only contains provider+fallbacks ' +
        'from the vision chain; httpProviders (including the free fallback) do not participate.',
      hintReverseRouting: 'With whole-turn routing on, route plain text turns back to the text model; on by default.',
      hintTool: 'Pixel-level vision tools such as vision_describe / vision_ground; turning this off disables them.',
      hintRewriteImages:
        'Replaces image blocks in the model input with text: a recorded vision description when one exists, ' +
        'otherwise an attachment marker — a text-only model never receives image content it cannot handle.',
      hintDownscale: 'Images beyond the pixel budget are resized before the vision call, cutting latency and cost; on by default.',
      hintCache: 'Caches vision answers (keyed by image content + question); on by default.',
      hintFreeFallback: 'Enables the built-in keyless free endpoint fallback when httpProviders are not explicitly configured; on by default.',
      hintStealth:
        'Takes over the official DeepSeek route while the model picker looks exactly like stock. Requires the ' +
        'official llm-deepseek row to be disabled in your profile patch layer (cordis.patch.yml); while the ' +
        'stock row is present the plugin falls back to the visible "auto image understanding" wrapper entry. ' +
        'Restart dsh after changing this.',
      numTimeoutMs: 'Vision request timeout (ms)',
      numDownscaleMaxPixels: 'Image pixel budget',
      numCacheTtlSeconds: 'Cache TTL (seconds)',
      numCacheMaxEntries: 'Cache entry limit',
      numHintTimeoutMs: 'Per vision-call deadline; default 120000.',
      numHintDownscaleMaxPixels: 'About 8MP = 8000000; larger images are resized before the vision call.',
      numHintCacheTtlSeconds: 'Vision answer cache lifetime; 0 = forever; default 3600.',
      numHintCacheMaxEntries: 'Cache LRU capacity; default 200.',
      textWrapperRoute: 'Wrapper route name',
      textChainRoute: 'Chain route name',
      textHintWrapperRoute: 'The "auto image understanding" entry route shown in the model picker.',
      textHintChainRoute: 'The fallback chain mount route (vision tools call real providers directly, not through it).',
      textProviders: 'Vision chain',
      textProvidersHint: 'One "provider/model" per line, top-down failover; empty clears the override.',
      textTextProvider: 'Text model',
      textTextProviderHint: 'Format "provider/model".',
    }

    /**
     * Unwrap the client RPC envelope the `connection` api returns for unary
     * calls: { rpcId, result: { ok, value } }. The catalog fields live in
     * `result.value`, NOT on the envelope itself.
     */
    function unwrapModelsResult(body, t) {
      if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {
        if (body.result.ok !== true) {
          const message =
            body.result.error && body.result.error.message
              ? body.result.error.message
              : t('catalogErrorEnvelope')
          throw new Error(message)
        }
        return body.result.value
      }
      return body
    }

    // ── field specs ──────────────────────────────────────────────────────────
    const TOGGLE_KEYS = ['routing', 'tool', 'stealth']
    const ADVANCED_TOGGLE_KEYS = ['reverseRouting', 'rewriteImages', 'downscale', 'cache', 'freeFallback']
    const ALL_TOGGLE_KEYS = [...TOGGLE_KEYS, ...ADVANCED_TOGGLE_KEYS]
    const NUMBER_KEYS = ['timeoutMs', 'downscaleMaxPixels', 'cacheTtlSeconds', 'cacheMaxEntries']
    const NUMBER_META = {
      timeoutMs: { min: 1000 },
      downscaleMaxPixels: { min: 1000 },
      cacheTtlSeconds: { min: 0 },
      cacheMaxEntries: { min: 1 },
    }
    const TEXT_KEYS = ['wrapperRoute', 'chainRoute']

    function readValue(snapshot, key) {
      const value = snapshot && snapshot.value
      return value && typeof value === 'object' ? value[key] : undefined
    }
    function userHas(snapshot, key) {
      const user = snapshot && snapshot.user
      return user && typeof user === 'object' && key in user
    }

    function providersToText(value) {
      if (!Array.isArray(value)) return ''
      return value
        .map((pair) => (pair && pair.provider ? `${pair.provider}/${pair.model ?? ''}` : ''))
        .join('\n')
    }
    function parseProviders(text) {
      const list = []
      for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        const idx = line.indexOf('/')
        if (idx <= 0) return undefined
        const provider = line.slice(0, idx).trim()
        const model = line.slice(idx + 1).trim()
        if (provider === '' || model === '') return undefined
        list.push({ provider, model })
      }
      return list
    }
    function textProviderToText(value) {
      if (!value || typeof value !== 'object') return ''
      return `${value.provider ?? ''}/${value.model ?? ''}`
    }
    function parseTextProvider(text) {
      const idx = String(text ?? '').indexOf('/')
      if (idx <= 0) return undefined
      const provider = String(text).slice(0, idx).trim()
      const model = String(text).slice(idx + 1).trim()
      if (provider === '' || model === '') return undefined
      return { provider, model }
    }
    function parseNumber(text, min) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return { clear: true }
      const parsed = Number(trimmed)
      return Number.isInteger(parsed) && parsed >= min ? { value: parsed } : undefined
    }

    // ── styles: mirrors the built-in plugin cards (same design tokens) ──────
    const CSS =
      '.vr-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}' +
      '.vr-card:hover{border-color:var(--dsw-alias-label-dimmed)}' +
      '.vr-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
      '.vr-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}' +
      '.vr-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}' +
      '.vr-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
      '.vr-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.vr-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}' +
      '.vr-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}' +
      '.vr-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;font-size:12px;line-height:1}' +
      '.vr-chevron-open{transform:rotate(180deg)}' +
      '.vr-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}' +
      '.vr-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}' +
      '.vr-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}' +
      '.vr-field + .vr-field{border-top:1px solid var(--dsw-alias-border-l2)}' +
      '.vr-field-head{align-items:center;gap:8px;display:flex}' +
      '.vr-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}' +
      '.vr-badges{align-items:center;gap:8px;display:inline-flex}' +
      '.vr-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}' +
      '.vr-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}' +
      '.vr-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}' +
      '.vr-reset:disabled{cursor:default}' +
      '.vr-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}' +
      '.vr-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.vr-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}' +
      '.vr-input-invalid{border-color:var(--dsw-alias-label-error)}' +
      '.vr-area{resize:vertical;min-height:84px;font-family:monospace}' +
      '.vr-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}' +
      '.vr-chain-row{display:flex;align-items:center;gap:8px;margin:6px 0}' +
      '.vr-catalog-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.vr-subheader{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:8px 0;border:none;background:none;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary);text-align:left}' +
      '.vr-group{border-top:1px solid var(--dsw-alias-border-l2);padding:10px 0 2px;display:flex;flex-direction:column;gap:8px}' +
      '.vr-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin:0}' +
      '.vr-select{flex:1;min-width:0;font:inherit}' +
      '.vr-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}' +
      '.vr-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}' +
      '.vr-toggle{display:flex;align-items:center;gap:10px;justify-content:space-between;width:100%}' +
      '.vr-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}' +
      '.vr-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}' +
      '.vr-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0}' +
      '.vr-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}' +
      '.vr-btn-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:#0000}' +
      '.vr-btn:disabled{opacity:.4;cursor:default}' +
      '.vr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}'

    let stylesInstalled = false
    function installStyles() {
      if (stylesInstalled || typeof document === 'undefined') return
      stylesInstalled = true
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-vision-router'
      tag.dataset.pluginCss = 'dsh-vision-router/plugin-card'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
        stylesInstalled = false
      }
    }

    const LABEL_KEY = {
      routing: 'toggleRouting',
      reverseRouting: 'toggleReverseRouting',
      tool: 'toggleTool',
      rewriteImages: 'toggleRewriteImages',
      downscale: 'toggleDownscale',
      cache: 'toggleCache',
      freeFallback: 'toggleFreeFallback',
      stealth: 'toggleStealth',
      timeoutMs: 'numTimeoutMs',
      downscaleMaxPixels: 'numDownscaleMaxPixels',
      cacheTtlSeconds: 'numCacheTtlSeconds',
      cacheMaxEntries: 'numCacheMaxEntries',
      wrapperRoute: 'textWrapperRoute',
      chainRoute: 'textChainRoute',
    }
    const HINT_KEY = {
      routing: 'hintRouting',
      reverseRouting: 'hintReverseRouting',
      tool: 'hintTool',
      rewriteImages: 'hintRewriteImages',
      downscale: 'hintDownscale',
      cache: 'hintCache',
      freeFallback: 'hintFreeFallback',
      stealth: 'hintStealth',
      timeoutMs: 'numHintTimeoutMs',
      downscaleMaxPixels: 'numHintDownscaleMaxPixels',
      cacheTtlSeconds: 'numHintCacheTtlSeconds',
      cacheMaxEntries: 'numHintCacheMaxEntries',
      wrapperRoute: 'textHintWrapperRoute',
      chainRoute: 'textHintChainRoute',
    }

    function VisionRouterCard(props) {
      const scope = props.scope
      const t = props.t
      const locale = props.locale
      // Re-render on language switches: t() re-reads the active dictionary.
      // The locale face's subscribe/getSnapshot are prototype methods using
      // `this` exactly like the settings binder — bind them before handing
      // them to useSyncExternalStore, or the card crashes with "Cannot read
      // properties of undefined" and gets abdicated.
      const localeSubscribe = useMemo(
        () => (locale && typeof locale.subscribe === 'function' ? locale.subscribe.bind(locale) : () => () => {}),
        [locale],
      )
      const localeGetSnapshot = useMemo(
        () => (locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot.bind(locale) : () => undefined),
        [locale],
      )
      React.useSyncExternalStore(localeSubscribe, localeGetSnapshot)
      // The binder's getSnapshot/subscribe are prototype methods using `this`:
      // passing them bare to useSyncExternalStore detaches the receiver and
      // crashes with "Cannot read properties of undefined (reading 'store')".
      // Bind them so a crash can never abdicate the card again.
      const subscribe = useMemo(() => scope.subscribe.bind(scope), [scope])
      const getSnapshot = useMemo(() => scope.getSnapshot.bind(scope), [scope])
      const [drafts, setDrafts] = useState({})
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState(false)
      const [open, setOpen] = useState(false)
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [catalog, setCatalog] = useState({ status: 'idle', groups: [], error: undefined })
      const catalogReady = catalog.status === 'ready' && catalog.groups.length > 0
      const loadCatalog = () => {
        if (catalog.status === 'loading' || catalog.status === 'ready') return
        setCatalog({ status: 'loading', groups: [], error: undefined })
        try {
          const connection = props.getConnection ? props.getConnection() : undefined
          const api = connection && connection.api
          const modelsFn = api && api.llm && typeof api.llm.models === 'function' ? api.llm.models : undefined
          if (modelsFn === undefined) {
            setCatalog({ status: 'error', groups: [], error: t('catalogUnavailable') })
            return
          }
          const timeout = new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error(t('catalogTimeout'))), 15000)
          })
          Promise.race([
            modelsFn({}).catch((error) => {
              throw error && error.message ? error : new Error(String(error))
            }),
            timeout,
          ]).then((body) => unwrapModelsResult(body, t)).then(
            (value) => {
              const groups = (value && value.groups) || []
              const failures = (value && value.failures) || []
              if (groups.length === 0 && failures.length > 0) {
                const detail = failures
                  .map((f) => (f && f.name ? f.name + '：' : '') + ((f && f.message) || ''))
                  .join('；').slice(0, 300)
                setCatalog({ status: 'error', groups: [], error: t('catalogEmpty') + detail })
                return
              }
              setCatalog({ status: 'ready', groups, error: undefined })
            },
            (error) => {
              setCatalog({
                status: 'error',
                groups: [],
                error: error && error.message ? error.message : String(error),
              })
            },
          )
        } catch (error) {
          setCatalog({
            status: 'error',
            groups: [],
            error: error && error.message ? error.message : String(error),
          })
        }
      }
      let snapshot
      let renderError
      try {
        snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
      } catch (error) {
        renderError = error
      }
      if (renderError !== undefined) {
        return React.createElement(
          'li',
          { className: 'vr-card' },
          React.createElement(
            'div',
            { style: { padding: '14px 16px', fontSize: 12, color: 'var(--dsw-alias-label-error)' } },
            t('renderFailed') + (renderError && renderError.message ? renderError.message : String(renderError)),
          ),
        )
      }
      if (!snapshot || snapshot.status !== 'ready') {
        // Match the built-in cards: render nothing while the namespace is
        // unavailable rather than a disabled card the user cannot act on.
        return null
      }
      const writable = snapshot.writable

      const format = (key) => {
        if (key in drafts) return drafts[key]
        const value = readValue(snapshot, key)
        if (key === 'providers') {
          if (catalogReady) return Array.isArray(value) ? value : []
          return providersToText(value)
        }
        if (key === 'textProvider') {
          if (catalogReady) {
            return value && typeof value === 'object' ? value : { provider: '', model: '' }
          }
          return textProviderToText(value)
        }
        if (key === 'proxyHosts') return Array.isArray(value) ? value.join('\n') : ''
        if (NUMBER_KEYS.includes(key)) return typeof value === 'number' ? String(value) : ''
        if (ALL_TOGGLE_KEYS.includes(key)) return value === true
        return typeof value === 'string' ? value : ''
      }
      const parse = (key, text) => {
        if (ALL_TOGGLE_KEYS.includes(key)) return { value: text === true }
        if (key === 'providers') {
          if (catalogReady) {
            const rows = Array.isArray(text) ? text : []
            const half = rows.some((row) => row && (row.provider ? !row.model : !!row.model))
            if (half) return undefined
            const filled = rows.filter((row) => row && row.provider && row.model)
            return filled.length > 0 ? { value: filled } : { clear: true }
          }
          const value = parseProviders(text)
          return value === undefined ? undefined : { value }
        }
        if (key === 'textProvider') {
          if (catalogReady) {
            const pair = text && typeof text === 'object' ? text : { provider: '', model: '' }
            if (pair.provider && pair.model) return { value: { provider: pair.provider, model: pair.model } }
            if (!pair.provider && !pair.model) return { clear: true }
            return undefined
          }
          const value = parseTextProvider(text)
          return value === undefined ? undefined : { value }
        }
        if (NUMBER_KEYS.includes(key)) return parseNumber(text, NUMBER_META[key].min)
        if (key === 'proxyHosts') {
          const list = String(text ?? '')
            .split('\n')
            .map((host) => host.trim())
            .filter((host) => host !== '')
          return list.length > 0 ? { value: list } : { clear: true }
        }
        const trimmed = String(text ?? '').trim()
        return trimmed === '' ? { clear: true } : { value: trimmed }
      }
      const plan = Object.keys(drafts)
        .map((key) => ({ key, run: parse(key, drafts[key]) }))
        .filter((item) => item.run !== undefined)
      const dirty = Object.keys(drafts).length > 0
      const invalid = plan.length !== Object.keys(drafts).length
      const blocked = !dirty || invalid || saving || !writable

      const setDraft = (key, text) => {
        setFailed(false)
        setDrafts((prev) => ({ ...prev, [key]: text }))
      }
      const clearDrafts = () => {
        setDrafts({})
        setFailed(false)
      }
      const save = async () => {
        if (blocked) return
        setSaving(true)
        setFailed(false)
        let landed = true
        for (const item of plan) {
          if (item.run.clear) {
            const ok = await scope.unset(item.key).then(() => true, () => false)
            landed = ok && landed
          } else {
            const ok = await scope.set(item.key, item.run.value).then(() => true, () => false)
            landed = ok && landed
          }
        }
        if (landed) setDrafts({})
        setSaving(false)
        setFailed(!landed)
      }
      const resetField = (key) => {
        setFailed(false)
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        scope.unset(key)
      }

      const h = React.createElement
      const overriddenBadge = (key) =>
        userHas(snapshot, key)
          ? h('span', { className: 'vr-badges' },
              h('span', { className: 'vr-badge' }, t('overridden')),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: !writable,
                onClick: () => resetField(key),
              }, t('reset')))
          : null
      const toggleField = (key) =>
        h('div', { className: 'vr-field', key },
          h('div', { className: 'vr-field-head' },
            h('div', { className: 'vr-toggle' },
              h('span', { className: 'vr-label' }, t(LABEL_KEY[key])),
              h('input', {
                type: 'checkbox', className: 'vr-check', checked: format(key),
                disabled: !writable,
                onChange: (event) => setDraft(key, event.target.checked),
              }),
            ),
            overriddenBadge(key),
          ),
          HINT_KEY[key]
            ? h('p', { className: 'vr-hint' }, t(HINT_KEY[key]))
            : null,
        )
      const textField = (key, label, hint, multi) => {
        const invalidField = key in drafts && parse(key, drafts[key]) === undefined
        return h('div', { className: 'vr-field', key },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, label),
            overriddenBadge(key),
          ),
          h(multi ? 'textarea' : 'input', {
            className: 'vr-input' + (multi ? ' vr-area' : '') + (invalidField ? ' vr-input-invalid' : ''),
            value: format(key), disabled: !writable,
            placeholder: '',
            onChange: (event) => setDraft(key, event.target.value),
          }),
          invalidField
            ? h('p', { className: 'vr-invalid' },
                key === 'providers'
                  ? t('invalidProviders')
                  : key === 'textProvider'
                    ? t('invalidTextProvider')
                    : key === 'timeoutMs'
                      ? t('invalidTimeout')
                      : t('invalidGeneric'))
            : hint
              ? h('p', { className: 'vr-hint' }, hint)
              : null,
        )
      }

      const groupOptions = catalog.groups.map((group) =>
        h('option', { value: group.id, key: group.id },
          (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id) +
          (group.id === 'vision-http' ? t('builtinFreeTag') : '')),
      )
      const modelsOf = (providerId) => {
        const group = catalog.groups.find((entry) => entry.id === providerId)
        return group && Array.isArray(group.models) ? group.models : []
      }
      const chainEditor = () => {
        const value = format('providers')
        const rows = Array.isArray(value) && value.length > 0 ? value : [{ provider: '', model: '' }]
        const updateChain = (index, next) => {
          const list = rows.map((row) => ({ ...row }))
          list[index] = next
          setDraft('providers', list)
        }
        const removeChain = (index) => {
          const list = rows.filter((_row, i) => i !== index)
          setDraft('providers', list.length > 0 ? list : [{ provider: '', model: '' }])
        }
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('chainLabel')),
            overriddenBadge('providers'),
          ),
          rows.map((row, index) =>
            h('div', { className: 'vr-chain-row', key: index },
              h('select', {
                className: 'vr-input vr-select', value: row.provider ?? '', disabled: !writable,
                onChange: (event) => updateChain(index, { provider: event.target.value, model: '' }),
              },
                h('option', { value: '' }, t('selectProvider')),
                groupOptions,
              ),
              h('select', {
                className: 'vr-input vr-select', value: row.model ?? '',
                disabled: !writable || !row.provider,
                onChange: (event) => updateChain(index, { provider: row.provider, model: event.target.value }),
              },
                h('option', { value: '' }, row.provider ? t('selectModel') : t('pickProviderFirst')),
                modelsOf(row.provider).map((model) =>
                  h('option', { value: model.id, key: model.id },
                    (model.name && model.name !== model.id ? model.name + ' (' + model.id + ')' : model.id) +
                    (row.provider === 'vision-http' ? t('freeTag') : '')),
                ),
              ),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: !writable, title: t('removeTitle'),
                onClick: () => removeChain(index),
              }, t('remove')),
            ),
          ),
          h('button', {
            type: 'button', className: 'vr-btn', disabled: !writable,
            onClick: () => setDraft('providers', [...rows, { provider: '', model: '' }]),
          }, t('addFallback')),
          h('p', { className: 'vr-hint' }, t('chainHint')),
        )
      }
      const textProviderEditor = () => {
        const value = format('textProvider')
        const pair = value && typeof value === 'object' ? value : { provider: '', model: '' }
        const setPair = (next) => setDraft('textProvider', next)
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('textModelLabel')),
            overriddenBadge('textProvider'),
          ),
          h('div', { className: 'vr-chain-row' },
            h('select', {
              className: 'vr-input vr-select', value: pair.provider ?? '', disabled: !writable,
              onChange: (event) => setPair({ provider: event.target.value, model: '' }),
            },
              h('option', { value: '' }, t('selectProvider')),
              groupOptions,
            ),
            h('select', {
              className: 'vr-input vr-select', value: pair.model ?? '',
              disabled: !writable || !pair.provider,
              onChange: (event) => setPair({ provider: pair.provider, model: event.target.value }),
            },
              h('option', { value: '' }, pair.provider ? t('selectModel') : t('pickProviderFirst')),
              modelsOf(pair.provider).map((model) =>
                h('option', { value: model.id, key: model.id },
                  (model.name && model.name !== model.id ? model.name + ' (' + model.id + ')' : model.id) +
                  (pair.provider === 'vision-http' ? t('freeTag') : '')),
              ),
            ),
          ),
          h('p', { className: 'vr-hint' }, t('textModelHint')),
        )
      }

      // Render-phase kick: whenever the body is open and the catalog was never
      // fetched (including after a remount that reset the state), start the
      // fetch. React supports setState during render for the same component,
      // and the status flips to 'loading' so this cannot loop.
      if (open && catalog.status === 'idle') {
        loadCatalog()
      }

      return h('li', { className: 'vr-card' + (open ? ' vr-card-open' : '') },
        h('button', {
          type: 'button', className: 'vr-header', 'aria-expanded': open,
          onClick: () => {
            if (!open) loadCatalog()
            setOpen(!open)
          },
        },
          h('span', { className: 'vr-headText' },
            h('span', { className: 'vr-name' }, t('nav')),
            h('span', { className: 'vr-desc' }, t('desc')),
          ),
          dirty ? h('span', { className: 'vr-pending' }, t('pending')) : null,
          h('span', { className: 'vr-chevron' + (open ? ' vr-chevron-open' : '') }, '▾'),
        ),
        open
          ? h('div', { className: 'vr-body' },
              !writable ? h('p', { className: 'vr-readOnly' }, t('readOnly')) : null,
              TOGGLE_KEYS.map((key) => toggleField(key)),
              h('p', { className: 'vr-hint' }, t('defaultChainNote')),
              catalogReady
                ? chainEditor()
                : textField('providers', t('textProviders'), t('textProvidersHint'), true),
              catalog.status === 'loading'
                ? h('p', { className: 'vr-hint' }, t('catalogLoading'))
                : catalog.status === 'error'
                  ? h('div', { className: 'vr-catalog-error' },
                      h('p', { className: 'vr-hint' }, t('catalogError') + catalog.error + t('catalogFallback')),
                      h('button', {
                        type: 'button', className: 'vr-btn',
                        onClick: () => {
                          setCatalog({ status: 'idle', groups: [], error: undefined })
                          loadCatalog()
                        },
                      }, t('retryCatalog')),
                    )
                  : null,
              h('button', {
                type: 'button', className: 'vr-subheader', 'aria-expanded': showAdvanced,
                onClick: () => setShowAdvanced(!showAdvanced),
              },
                h('span', { className: 'vr-label' }, t('advanced')),
                h('span', { className: 'vr-chevron' + (showAdvanced ? ' vr-chevron-open' : '') }, '▾'),
              ),
              showAdvanced
                ? h('div', { className: 'vr-advanced' },
                    h('div', { className: 'vr-group' },
                      h('p', { className: 'vr-group-title' }, t('groupTextModel')),
                      catalogReady
                        ? textProviderEditor()
                        : textField('textProvider', t('textTextProvider'), t('textTextProviderHint'), false),
                      h('p', { className: 'vr-hint' }, t('textModelGroupHint')),
                    ),
                    h('div', { className: 'vr-group' },
                      h('p', { className: 'vr-group-title' }, t('groupBehavior')),
                      ADVANCED_TOGGLE_KEYS.map((key) => toggleField(key)),
                    ),
                    h('div', { className: 'vr-group' },
                      h('p', { className: 'vr-group-title' }, t('groupParams')),
                      NUMBER_KEYS.map((key) => textField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), false)),
                    ),
                    h('div', { className: 'vr-group' },
                      h('p', { className: 'vr-group-title' }, t('groupRoutes')),
                      TEXT_KEYS.map((key) => textField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), false)),
                    ),
                    h('div', { className: 'vr-group' },
                      h('p', { className: 'vr-group-title' }, t('groupProxy')),
                      textField('proxy', t('proxyLabel'), t('proxyHint'), false),
                      textField('proxyHosts', t('proxyHostsLabel'), t('proxyHostsHint'), true),
                    ),
                  )
                : null,
              h('div', { className: 'vr-footer' },
                failed ? h('p', { className: 'vr-failed' }, t('saveFailed')) : null,
                h('button', {
                  type: 'button', className: 'vr-btn', disabled: !dirty || saving,
                  onClick: clearDrafts,
                }, t('discard')),
                h('button', {
                  type: 'button', className: 'vr-btn vr-btn-save', disabled: blocked,
                  onClick: save,
                }, saving ? t('saving') : t('save')),
              ),
            )
          : null,
      )
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: 'vision-router' })
      // Follow the app language: register our dictionaries and re-read them
      // whenever the user switches the locale in Settings → General.
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vision-router: card locale')
      const t = ctx.locale.bind(NS)
      // Lazily reach the client `connection` service for the model catalog.
      // Never a hard inject (a parked inject would keep the card from
      // registering); absence degrades to the free-text inputs.
      const getConnection = () => {
        try {
          return ctx.get('connection')
        } catch {
          return undefined
        }
      }
      ctx.effect(installStyles, 'vision-router: card styles')
      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugin.item', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.plugin.item',
                id: 'vision-router',
                order: 30,
                label: () => t('nav'),
                inject: () => ({ scope, getConnection, t, locale: ctx.locale }),
              },
              VisionRouterCard,
            )
          }),
        'vision-router: settings card',
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots', 'locale']
    exports.unwrapModelsResult = unwrapModelsResult
    return module.exports
  },
})

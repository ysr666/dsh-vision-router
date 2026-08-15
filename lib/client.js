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
    const { ImageGallery } = require('@deepseek-ai/dsh-client-ui-attachment')

    // ── locale dictionaries (follow the app's language setting) ─────────────
    const NS = 'vision-router'
    const zh = {
      nav: '视觉路由（自动识图）',
      desc: '会话模型负责聊天，视觉后端负责看图；两者分开设置 · 面板 v7',
      quickStartTitle: '先分清两个模型',
      quickStartBody: '① 会话/文字模型：在聊天页右下角选择；发图时选带「+ 自动识图」的模型组。② 视觉模型：在本卡片的「视觉后端链」里选择，只负责看图。',
      quickStartLive: '只想换识图模型，就改下面的「视觉后端链」；不会改变聊天页右下角的会话模型。',
      quickStartGuide: '重新查看模型引导',
      onboardingTitle: 'Vision Router 已准备好 🎉',
      onboardingBody: 'Vision Router 把“谁负责聊天”和“谁负责看图”拆成了两处设置。按下面 3 步就不会选错。',
      onboardingStep1Title: '1 · 会话 / 文字模型',
      onboardingStep1Body: '在聊天页右下角选择。发图片时，请选带「+ 自动识图」的模型组；组里的 DeepSeek / opencode 模型仍负责聊天、思考和调用工具。',
      onboardingStep2Title: '2 · 视觉模型',
      onboardingStep2Body: '打开「设置 → 插件 → Vision Router」，在「视觉后端链」里选择。它只负责看图，不会替换你的聊天模型。',
      onboardingStep3Title: '3 · 主视觉模型与备用模型',
      onboardingStep3Body: '视觉后端链每一行都是你自己的视觉模型，从上到下依次尝试；可以全部留空。内置 OVH 匿名免费链固定在最后自动兜底。',
      onboardingGuide: '带我设置视觉模型',
      onboardingLater: '稍后',
      onboardingClose: '关闭',
      guidePromptTitle: '设置视觉模型 · 第 1 步',
      guidePromptBody: '请打开 DSH 的「设置 → 插件」。进入插件页后，我会自动展开 Vision Router，并定位到「视觉后端链」。',
      guidePromptCancel: '结束引导',
      guideChainTitle: '第 2 步 · 这里就是视觉模型',
      guideChainBody: '上面的每一行都是你自己的视觉模型，从上到下依次尝试；可以全部留空。内置 OVH 免费链固定在最后自动兜底。这里不会修改聊天页右下角的会话/文字模型。选好后点击页面底部「保存」。',
      guideDone: '完成引导',
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
      builtinFallbackLabel: '内置免费兜底（自动）',
      builtinFallbackEnabled: '已启用',
      builtinFallbackDisabled: '已关闭',
      builtinFallbackBody: 'OVHcloud 匿名视觉链共 {count} 个模型，首选 {primary}。匿名限额为每 IP、每模型 2 次/分钟；5 个模型独立限额，理论合计约 10 次/分钟，实际以 OVH 限流为准。它固定在上面用户模型之后尝试，免注册、免 Key。',
      chainLabel: '视觉后端链（给识图工具用）',
      chainHint: '上面每一行只选择一个你在「设置 → 模型」中已经配置、且明确支持 image 输入的用户模型；从上到下依次尝试。可以一行都不填，下方内置 OVH 免费兜底仍会工作。',
      addFallback: '+ 添加备用视觉模型',
      remove: '移除',
      removeTitle: '移除这一行',
      textModelLabel: '文本模型（文字轮走它）',
      textModelHint: '通常无需设置；见上方说明，留空即恢复默认。',
      defaultChainNote:
        '这里配置识图工具真正调用的“眼睛”，不是聊天页右下角的“脑子/会话模型”。上面的行只选你自己的视觉模型；内置 OVH 匿名免费链固定显示在最下方，不需要选择 Vision HTTP。',
      catalogLoading: '正在加载模型目录（与「设置 > 模型」同源）…',
      catalogUnavailable: '连接服务不可用（拿不到模型目录），退回手动输入。',
      catalogTimeout: '目录请求超时（15 秒）',
      catalogEmpty: '模型目录为空：',
      catalogErrorEnvelope: '模型目录接口返回失败',
      catalogError: '模型目录不可用（',
      catalogFallback: '），模型字段已退回手动输入。',
      visionCapsLoading: '正在验证哪些模型真正支持图片输入…',
      visionCapsError: '视觉能力元数据暂时不可用；为防止误选，暂不提供用户视觉模型下拉。内置 OVH 免费兜底仍可用。',
      visionCapsFiltered: '视觉后端下拉只显示明确声明 image 输入的模型。',
      chainInvalidCurrent: '当前保存的视觉后端不支持图片或无法验证，已从下拉列表隐藏，运行时也会跳过：',
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
      testConnection: '测试连接',
      testConnecting: '测试中…',
      testOk: '连接正常',
      testFailed: '连接失败',
      updateTitle: '版本更新',
      checkUpdate: '检查更新',
      updateChecking: '检查中…',
      updateAvailable: '发现新版本 v{latest}（当前 v{current}）',
      updateCurrent: '已是最新版本 v{current}',
      updateAhead: '当前 v{current} 高于 registry 最新 v{latest}；可能是源码或预发布构建，不会建议降级。',
      updateFailed: '更新检查失败：{error}',
      updateInstallHint: '已安全识别当前 DSH CLI，可直接用这套 DSH 更新插件；完成后需要重启 DSH 才会加载新版本。',
      updateAutoUnavailable: '当前 DSH CLI 无法被安全识别，因此不执行自动更新。请沿用你原来安装 DSH / 插件的方式手动更新。',
      updateNow: '一键更新到 v{latest}',
      updateRunning: '正在更新…',
      updateConfirm: '将通过当前正在运行的 DSH 更新 Vision Router。更新完成后需要重启 DSH。继续吗？',
      updateSuccess: '更新命令已完成（目标 v{latest}）。请重启 DSH；重启后新版本才会生效。',
      updateActionFailed: '一键更新失败：{error}',
      updateReleaseNotes: '查看更新说明',
      save: '保存',
      saving: '保存中…',
      renderFailed: '设置卡渲染失败：',
      toggleRouting: '图片轮整轮自动路由',
      toggleReverseRouting: '文字轮反向路由',
      toggleTool: '识图工具',
      toggleAutoWrapProviders: '自动创建「+ 自动识图」模型组',
      toggleRewriteImages: '图片块改写',
      toggleDownscale: '图片自动压缩',
      toggleCache: '识图答案缓存',
      toggleFreeFallback: '免费兜底',
      toggleStealth: '隐身模式',
      hintRouting:
        '默认关闭：图片轮不整轮切到视觉模型，而是像普通文本轮一样由会话模型调用 ' +
        'vision_describe 等工具看图，可连续多步操作（定位→裁剪→对比…）。' +
        '开启后恢复旧的整轮一次性自动识图行为；注意：开启时降级链只包含 ' +
        '「视觉后端链」里的 provider+fallbacks，httpProviders（含免费兜底端点）不参与。',
      hintReverseRouting: '开启图片轮整轮路由时，把纯文字轮反向路由回文本模型；默认开启。',
      hintTool: 'vision_describe / vision_ground 等像素级视觉工具；关闭后这些工具不可用。',
      hintAutoWrapProviders: '推荐保持开启。插件会自动发现「设置 → 模型」里已启用的路由，并额外创建同名的「+ 自动识图」模型组；发图时请在聊天页右下角选择这个新组。原模型组完全不变。模型增删与包装范围会热更新，无需重启。',
      hintRewriteImages:
        '把消息里的图片块替换为文字：已有视觉记录就给出记录，否则给出附件标记，' +
        '文本模型始终不会收到它看不懂的图片内容。',
      hintDownscale: '超过像素预算的图片先缩放再送视觉模型，降低延迟与成本；默认开启。',
      hintCache: '缓存识图答案（按图片内容 + 问题）；默认开启。',
      hintFreeFallback: '启用内置 OVH 匿名视觉链作为最终兜底：免注册、免 Key，并在你选择的用户视觉模型之后尝试；默认开启。',
      hintStealth:
        '只作用于官方 DeepSeek 路由：接管后模型选择器保持原样。需在 profile 补丁层 ' +
        '（cordis.patch.yml）禁用官方 llm-deepseek 行后才真正接管；官方行还在时 ' +
        '插件自动回退为选择器里的「自动识图」包装路由。opencode 等自定义路由与隐身模式无关，' +
        '它们默认由「自动创建 + 自动识图模型组」处理；只有要限制范围时才用下方手动包装。改动后需重启 dsh 生效。',
      stealthOfficialDeadHint:
        '提示：检测到官方 DeepSeek 行当前被禁用（profile 补丁层），所以即使关闭隐身模式，' +
        '本插件仍会接管 deepseek-official 路由，否则 DeepSeek 模型会从选择器消失。' +
        '如需完全恢复官方原生行，请先把 cordis.patch.yml 里 llm-deepseek 的 disabled 改回 false 再重启。',
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
      textWrappedProviders: '手动包装模型（可选）',
      groupWrappers: '手动限定自动识图范围（可选）',
      textHintWrappedProviders: '通常不用配置。只有关闭自动创建，或只想让某些模型出现在「+ 自动识图」组时才使用：每行 `provider` 包装全部模型，或 `provider/model1,model2` 只包装指定模型。改动即时生效，无需重启。',
      wrapHint: '通常无需配置：默认会自动发现并包装「设置 → 模型」里已启用的模型。只有想限制某个 provider 的自动识图范围，或关闭上方自动创建后手动指定时才在这里添加；模型留空 = 该路由全部模型。原模型组始终保留不变。改动即时生效，无需重启。',
      wrapAllModels: '全部模型（不选 = 包装全部）',
      addWrapper: '+ 添加手动包装',
      textProviders: '视觉后端链',
      textProvidersHint: '每行一个真正支持图片输入的「provider/model」，从上到下失败回退；不要填写纯文本模型。留空清除用户覆盖。',
      textTextProvider: '文本模型',
      textTextProviderHint: '格式「provider/model」。',
      presentingImage: '正在准备图片…',
      presentedImage: '图片',
      openPresentedImage: '点击查看原图',
      openNamedImage: '查看原图：{name}',
      loadingPresentedImage: '图片加载中…',
      retryPresentedImage: '加载失败，点击重试',
      imagePreviewDialog: '图片预览',
      closeImagePreview: '关闭预览',
    }
    const en = {
      nav: 'Vision Router (auto image understanding)',
      desc: 'The session model chats; the vision backend sees images. They are configured separately · panel v7',
      quickStartTitle: 'Know the two model settings',
      quickStartBody: '① Session/text model: choose it from the lower-right chat selector; for image turns use a group marked “+ Auto Vision”. ② Vision model: choose it in this card under “Vision backend chain”; it only handles image understanding.',
      quickStartLive: 'To change only image understanding, edit “Vision backend chain” below; your lower-right session model is not changed.',
      quickStartGuide: 'Show model guide again',
      onboardingTitle: 'Vision Router is ready 🎉',
      onboardingBody: 'Vision Router separates “who chats and reasons” from “who sees the image”. These 3 steps make the distinction explicit.',
      onboardingStep1Title: '1 · Session / text model',
      onboardingStep1Body: 'Choose it from the lower-right chat selector. For images, use a group marked “+ Auto Vision”; the DeepSeek/opencode model inside still handles chat, reasoning, and tool calls.',
      onboardingStep2Title: '2 · Vision model',
      onboardingStep2Body: 'Open Settings → Plugins → Vision Router and choose it under “Vision backend chain”. It only sees images and does not replace your chat model.',
      onboardingStep3Title: '3 · Primary and fallback vision models',
      onboardingStep3Body: 'Each row in the vision backend chain is one of your own vision models and is tried top to bottom. You may leave every row empty; the built-in anonymous OVH chain remains the automatic final fallback.',
      onboardingGuide: 'Guide me to vision settings',
      onboardingLater: 'Later',
      onboardingClose: 'Close',
      guidePromptTitle: 'Set the vision model · Step 1',
      guidePromptBody: 'Open DSH Settings → Plugins. Once that page is open, I will expand Vision Router and take you to “Vision backend chain”.',
      guidePromptCancel: 'End guide',
      guideChainTitle: 'Step 2 · This is the vision model',
      guideChainBody: 'Each row above is one of your own vision models, tried top to bottom; you may leave them all empty. The built-in OVH chain remains the automatic final fallback. This does not change the session/text model in the lower-right chat selector. Click “Save” after choosing.',
      guideDone: 'Finish guide',
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
      builtinFallbackLabel: 'Built-in free fallback (automatic)',
      builtinFallbackEnabled: 'Enabled',
      builtinFallbackDisabled: 'Disabled',
      builtinFallbackBody: 'The anonymous OVHcloud vision chain contains {count} models, starting with {primary}. Anonymous limits are 2 requests/minute per IP per model; five independent model buckets are about 10 RPM in theory, subject to OVH rate limiting. It always runs after your user models and needs no signup or API key.',
      chainLabel: 'Vision backend chain (used by the vision tools)',
      chainHint: 'Each row selects one user model already configured under Settings → Models and explicitly declaring image input. Rows are tried top to bottom. You may leave them all empty; the built-in OVH fallback below still works.',
      addFallback: '+ Add vision fallback',
      remove: 'Remove',
      removeTitle: 'Remove this row',
      textModelLabel: 'Text model (text turns use it)',
      textModelHint: 'Usually unneeded; leave empty to restore the default.',
      defaultChainNote:
        'This section configures the “eyes” used by the vision tools, not the brain/conversation model in the lower-right picker. The rows above are only your own vision models; the built-in anonymous OVH chain is fixed at the bottom and never requires selecting Vision HTTP.',
      catalogLoading: 'Loading the model catalog (same source as Settings → Models)…',
      catalogUnavailable: 'Connection service unavailable (no model catalog); falling back to free-text input.',
      catalogTimeout: 'Catalog request timed out (15s)',
      catalogEmpty: 'Model catalog is empty: ',
      catalogErrorEnvelope: 'The model catalog endpoint failed',
      catalogError: 'Model catalog unavailable (',
      catalogFallback: '); model fields fell back to free-text input.',
      visionCapsLoading: 'Checking which models genuinely accept image input…',
      visionCapsError: 'Vision capability metadata is unavailable; user vision-model choices are hidden to prevent bad selections. The built-in OVH fallback still works.',
      visionCapsFiltered: 'The vision-backend dropdown only shows models that explicitly declare image input.',
      chainInvalidCurrent: 'This saved vision backend does not support images or could not be verified. It is hidden from the dropdown and skipped at runtime: ',
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
      testConnection: 'Test connection',
      testConnecting: 'Testing…',
      testOk: 'Connected',
      testFailed: 'Connection failed',
      updateTitle: 'Updates',
      checkUpdate: 'Check for updates',
      updateChecking: 'Checking…',
      updateAvailable: 'Update available: v{latest} (current v{current})',
      updateCurrent: 'Up to date: v{current}',
      updateAhead: 'Current v{current} is ahead of registry v{latest}; this may be a source or prerelease build, so no downgrade is suggested.',
      updateFailed: 'Update check failed: {error}',
      updateInstallHint: 'The current DSH CLI was verified, so Vision Router can update through this same DSH installation. Restart DSH after the update to load the new plugin bundle.',
      updateAutoUnavailable: 'The current DSH CLI could not be verified safely, so automatic update is disabled. Update through the same DSH/plugin installation path you originally used.',
      updateNow: 'Update to v{latest}',
      updateRunning: 'Updating…',
      updateConfirm: 'Vision Router will update through the DSH CLI that is currently running. You will need to restart DSH afterward. Continue?',
      updateSuccess: 'The update command completed (target v{latest}). Restart DSH to load the new version.',
      updateActionFailed: 'One-click update failed: {error}',
      updateReleaseNotes: 'View release notes',
      save: 'Save',
      saving: 'Saving…',
      renderFailed: 'Settings card failed to render: ',
      toggleRouting: 'Whole-turn vision routing',
      toggleReverseRouting: 'Reverse routing for text turns',
      toggleTool: 'Vision tools',
      toggleAutoWrapProviders: 'Auto-create “+ Auto Vision” model groups',
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
        'from the vision backend chain; httpProviders (including the free fallback) do not participate.',
      hintReverseRouting: 'With whole-turn routing on, route plain text turns back to the text model; on by default.',
      hintTool: 'Pixel-level vision tools such as vision_describe / vision_ground; turning this off disables them.',
      hintAutoWrapProviders: 'Recommended on. The plugin discovers routes enabled in Settings → Models and creates an additional same-name “+ Auto Vision” model group. Choose that new group from the lower-right chat model selector when sending images; the original group is never changed. Model and wrapper changes hot-update without a restart.',
      hintRewriteImages:
        'Replaces image blocks in the model input with text: a recorded vision description when one exists, ' +
        'otherwise an attachment marker — a text-only model never receives image content it cannot handle.',
      hintDownscale: 'Images beyond the pixel budget are resized before the vision call, cutting latency and cost; on by default.',
      hintCache: 'Caches vision answers (keyed by image content + question); on by default.',
      hintFreeFallback: 'Keeps the built-in anonymous OVH vision chain as the final fallback after your user-selected vision models; no signup or API key required. On by default.',
      hintStealth:
        'Only affects the official DeepSeek route: takes it over while the model picker looks exactly like stock. Requires the ' +
        'official llm-deepseek row to be disabled in your profile patch layer (cordis.patch.yml); while the ' +
        'stock row is present the plugin falls back to the visible auto-vision wrapper entry. Custom routes like opencode ' +
        'are auto-wrapped by default; use the manual wrapper section below only when you want to restrict their scope. ' +
        'Restart dsh after changing stealth/profile takeover.',
      stealthOfficialDeadHint:
        'Notice: the official DeepSeek row is currently disabled (profile patch layer), so this plugin keeps ' +
        'serving the deepseek-official route even with stealth mode off — otherwise the DeepSeek models would ' +
        'vanish from the picker. To restore the fully official route, re-enable the llm-deepseek row in ' +
        'cordis.patch.yml first, then restart.',
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
      textHintWrapperRoute: 'The auto-vision entry route shown in the model picker.',
      textHintChainRoute: 'The fallback chain mount route (vision tools call real providers directly, not through it).',
      textWrappedProviders: 'Manual model wrappers (optional)',
      groupWrappers: 'Limit auto-vision scope manually (optional)',
      textHintWrappedProviders: 'Usually leave this alone. Use it only after disabling automatic creation, or when only selected models should appear in a “+ Auto Vision” group: one `provider` wraps all models, while `provider/model1,model2` limits the set. Applies immediately; no restart.',
      wrapHint: 'Usually no configuration is needed: enabled models from Settings → Models are discovered and wrapped automatically. Add rows here only to restrict one provider’s auto-vision scope, or after turning off automatic creation above. Empty model = every model on that route. The original model group always remains untouched. Applies immediately; no restart.',
      wrapAllModels: 'All models (empty = wrap all)',
      addWrapper: '+ Add manual wrapper',
      textProviders: 'Vision backend chain',
      textProvidersHint: 'One genuinely image-capable "provider/model" per line, top-down failover. Do not put text-only models here. Empty clears the override.',
      textTextProvider: 'Text model',
      textTextProviderHint: 'Format "provider/model".',
      presentingImage: 'Preparing image…',
      presentedImage: 'Image',
      openPresentedImage: 'Open original image',
      openNamedImage: 'Open original image: {name}',
      loadingPresentedImage: 'Loading image…',
      retryPresentedImage: 'Load failed, click to retry',
      imagePreviewDialog: 'Image preview',
      closeImagePreview: 'Close preview',
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

    function filterVisionBackendGroups(groups, capabilities) {
      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}
      return (Array.isArray(groups) ? groups : [])
        .map((group) => {
          const models = (group && Array.isArray(group.models) ? group.models : []).filter((model) => {
            if (!model || typeof model.id !== 'string') return false
            // The built-in backend is defined by this plugin and always
            // declares image input. Keeping it visible while the capability
            // request is still loading avoids a blank default editor.
            if (group.id === 'vision-http') return false
            return !!(caps[group.id] && caps[group.id][model.id] && caps[group.id][model.id].image === true)
          })
          return { ...group, models }
        })
        .filter((group) => group && group.models.length > 0)
    }

    // ── field specs ──────────────────────────────────────────────────────────
    const TOGGLE_KEYS = ['routing', 'tool', 'autoWrapProviders', 'stealth']
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
      '.vr-quickstart{margin:12px 0 2px;padding:12px 14px;border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;background:var(--dsw-alias-bg-module-platform);display:flex;flex-direction:column;gap:5px}' +
      '.vr-quickstart-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:650;line-height:1.5}' +
      '.vr-quickstart-body,.vr-quickstart-live{margin:0;font-size:12px;line-height:1.6}' +
      '.vr-quickstart-body{color:var(--dsw-alias-label-secondary)}' +
      '.vr-quickstart-live{color:var(--dsw-alias-brand-primary)}' +
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
      '.vr-stealth-notice{color:var(--dsw-alias-label-warning,var(--dsw-alias-label-secondary))}' +
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
      '.vr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
      '.vr-onboarding-backdrop{position:fixed;inset:0;z-index:10000;background:#0006;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}' +
      '.vr-onboarding-dialog{position:relative;width:min(480px,100%);box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 18px 60px #0005;padding:22px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}' +
      '.vr-onboarding-title{margin:0;padding-right:32px;font-size:18px;font-weight:700;line-height:1.4}' +
      '.vr-onboarding-text{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1.65}' +
      '.vr-onboarding-example{display:flex;align-items:center;gap:9px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);padding:10px 12px;font-size:13px}' +
      '.vr-onboarding-example-label{color:var(--dsw-alias-label-tertiary)}' +
      '.vr-onboarding-example-value{font-weight:650;color:var(--dsw-alias-brand-primary)}' +
      '.vr-onboarding-close{position:absolute;top:12px;right:12px;appearance:none;border:0;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:22px;line-height:1;cursor:pointer;padding:5px 8px;border-radius:8px}' +
      '.vr-onboarding-close:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}' +
      '.vr-onboarding-steps{display:flex;flex-direction:column;gap:8px}' +
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
      '@media(max-width:640px){.vr-onboarding-backdrop{align-items:flex-end;padding:0}.vr-onboarding-dialog{width:100%;border-radius:16px 16px 0 0;padding:20px 18px max(20px,env(safe-area-inset-bottom))}.vr-guide-prompt{left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));width:auto}}'

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

    const ONBOARDING_STORAGE_KEY = 'dsh-vision-router:onboarding:model-guide-v2'
    const VISION_GUIDE_STORAGE_KEY = 'dsh-vision-router:guide:vision-backend-v1'
    const VISION_GUIDE_EVENT = 'dsh-vision-router:vision-settings-guide'
    let visionGuidePrompt
    let visionGuideActiveMemory = false

    function readVisionGuideActive() {
      try {
        if (window.localStorage && window.localStorage.getItem(VISION_GUIDE_STORAGE_KEY) === 'active') return true
      } catch {
        // Fall through to page-memory state when storage access is blocked.
      }
      return visionGuideActiveMemory
    }
    function writeVisionGuideActive(active) {
      visionGuideActiveMemory = active === true
      try {
        if (!window.localStorage) return
        if (active) window.localStorage.setItem(VISION_GUIDE_STORAGE_KEY, 'active')
        else window.localStorage.removeItem(VISION_GUIDE_STORAGE_KEY)
      } catch {
        // Page-memory state still keeps the guide functional for this load.
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

    function installOnboarding(t) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      try {
        if (window.localStorage && window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === 'seen') return
      } catch {
        // Privacy/storage restrictions should not prevent the guidance itself.
      }

      let overlay
      let timer
      const remember = () => {
        try {
          if (window.localStorage) window.localStorage.setItem(ONBOARDING_STORAGE_KEY, 'seen')
        } catch {
          // Best effort: the dialog can still be dismissed for this page load.
        }
      }
      const onKeyDown = (event) => {
        if (event && event.key === 'Escape') dismiss()
      }
      const dismiss = () => {
        remember()
        document.removeEventListener('keydown', onKeyDown)
        if (overlay) overlay.remove()
        overlay = undefined
      }

      timer = window.setTimeout(() => {
        timer = undefined
        if (!document.body) return

        overlay = document.createElement('div')
        overlay.className = 'vr-onboarding-backdrop'
        overlay.setAttribute('role', 'presentation')

        const dialog = document.createElement('div')
        dialog.className = 'vr-onboarding-dialog'
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        dialog.setAttribute('aria-labelledby', 'vr-onboarding-title')

        const title = document.createElement('h2')
        title.id = 'vr-onboarding-title'
        title.className = 'vr-onboarding-title'
        title.textContent = t('onboardingTitle')

        const body = document.createElement('p')
        body.className = 'vr-onboarding-text'
        body.textContent = t('onboardingBody')

        const steps = document.createElement('div')
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
        }

        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'vr-onboarding-close'
        close.setAttribute('aria-label', t('onboardingClose'))
        close.textContent = '×'
        close.addEventListener('click', dismiss)

        const actions = document.createElement('div')
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

        dialog.append(title, body, steps, close, actions)
        overlay.appendChild(dialog)
        document.body.appendChild(overlay)
        document.addEventListener('keydown', onKeyDown)
        primary.focus()
      }, 650)

      return () => {
        if (timer !== undefined) window.clearTimeout(timer)
        document.removeEventListener('keydown', onKeyDown)
        if (overlay) overlay.remove()
      }
    }

    const LABEL_KEY = {
      routing: 'toggleRouting',
      reverseRouting: 'toggleReverseRouting',
      tool: 'toggleTool',
      autoWrapProviders: 'toggleAutoWrapProviders',
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
      autoWrapProviders: 'hintAutoWrapProviders',
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
      const [testState, setTestState] = useState({ status: 'idle' })
      const [updateState, setUpdateState] = useState({ status: 'idle', result: undefined })
      const [selfUpdateState, setSelfUpdateState] = useState({ status: 'idle', result: undefined })
      const [guideActive, setGuideActive] = useState(() => readVisionGuideActive())
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [catalog, setCatalog] = useState({ status: 'idle', groups: [], error: undefined })
      const [visionCaps, setVisionCaps] = useState({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })
      const catalogReady = catalog.status === 'ready' && catalog.groups.length > 0
      const visionGroups = filterVisionBackendGroups(catalog.groups, visionCaps.capabilities)
      const visionModelsFor = (providerId) => {
        const group = visionGroups.find((entry) => entry.id === providerId)
        return group && Array.isArray(group.models) ? group.models : []
      }
      const visionProviderVisible = (providerId) =>
        typeof providerId === 'string' && visionGroups.some((entry) => entry.id === providerId)
      const visionModelVisible = (providerId, modelId) =>
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
      const loadVisionCapabilities = () => {
        if (visionCaps.status === 'loading' || visionCaps.status === 'ready') return
        setVisionCaps({ status: 'loading', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })
        fetch('/_dsh/vision-router/model-capabilities')
          .then(async (response) => {
            const body = await response.json().catch(() => undefined)
            if (!response.ok) {
              throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
            }
            return body
          })
          .then(
            (body) =>
              setVisionCaps({
                status: 'ready',
                capabilities: body && body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {},
                builtinFallback: body && Array.isArray(body.builtinFallback) ? body.builtinFallback : [],
                anonymousRpmPerModel: body && Number.isFinite(body.anonymousRpmPerModel) ? body.anonymousRpmPerModel : 2,
                error: undefined,
              }),
            (error) =>
              setVisionCaps({
                status: 'error',
                capabilities: {},
                builtinFallback: [],
                anonymousRpmPerModel: 2,
                error: error && error.message ? error.message : String(error),
              }),
          )
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
          if (catalogReady) return Array.isArray(value) ? value.filter((row) => row && row.provider !== 'vision-http') : []
          return providersToText(value)
        }
        if (key === 'textProvider') {
          if (catalogReady) {
            return value && typeof value === 'object' ? value : { provider: '', model: '' }
          }
          return textProviderToText(value)
        }
        if (key === 'proxyHosts') return Array.isArray(value) ? value.join('\n') : ''
        if (key === 'wrappedProviders') {
          if (catalogReady) {
            // Expand the persisted { provider, models[] } entries into one
            // editor row per selected model ('' = wrap all models).
            const rows = []
            for (const entry of Array.isArray(value) ? value : []) {
              if (!entry || typeof entry.provider !== 'string' || entry.provider === '') continue
              const models = Array.isArray(entry.models) ? entry.models : []
              if (models.length === 0) rows.push({ provider: entry.provider, model: '' })
              else for (const model of models) rows.push({ provider: entry.provider, model })
            }
            return rows
          }
          if (!Array.isArray(value)) return ''
          return value
            .map((entry) =>
              entry && entry.provider
                ? entry.models && entry.models.length > 0
                  ? `${entry.provider}/${entry.models.join(',')}`
                  : entry.provider
                : '',
            )
            .join('\n')
        }
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
            if (visionCaps.status === 'ready' && filled.some((row) => !visionModelVisible(row.provider, row.model))) {
              return undefined
            }
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
        if (key === 'wrappedProviders') {
          if (catalogReady) {
            // Merge the editor rows back into { provider, models[] }: one
            // entry per provider; a row without a model means wrap all of the
            // provider's models and wins over any specific selections.
            const rows = Array.isArray(text) ? text : []
            const merged = new Map() // provider -> null (all) | Set(model ids)
            for (const row of rows) {
              if (row === undefined || row === null || typeof row !== 'object') return undefined
              const provider = typeof row.provider === 'string' ? row.provider.trim() : ''
              const model = typeof row.model === 'string' ? row.model.trim() : ''
              if (provider === '') {
                // the empty template row is fine only without a model picked
                if (model !== '') return undefined
                continue
              }
              if (!merged.has(provider)) merged.set(provider, new Set())
              const set = merged.get(provider)
              if (set === null) continue
              if (model === '') merged.set(provider, null)
              else set.add(model)
            }
            const cleaned = [...merged.entries()].map(([provider, set]) => ({
              provider,
              models: set === null ? [] : [...set],
            }))
            return cleaned.length > 0 ? { value: cleaned } : { clear: true }
          }
          const list = []
          for (const raw of String(text ?? '').split('\n')) {
            const line = raw.trim()
            if (line === '') continue
            const slash = line.indexOf('/')
            const provider = (slash === -1 ? line : line.slice(0, slash)).trim()
            if (provider === '') return undefined
            const models =
              slash === -1
                ? []
                : line
                    .slice(slash + 1)
                    .split(',')
                    .map((model) => model.trim())
                    .filter((model) => model !== '')
            if (slash !== -1 && models.length === 0) return undefined
            list.push({ provider, models })
          }
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

      const runTestConnection = async () => {
        if (testState.status === 'running') return
        setTestState({ status: 'running' })
        try {
          const response = await fetch('/_dsh/vision-router/test-connection')
          const result = await response.json().catch(() => undefined)
          setTestState({ status: 'done', result })
        } catch (error) {
          setTestState({ status: 'done', result: { ok: false, error: error && error.message ? error.message : String(error) } })
        }
      }

      const runUpdateCheck = async (force = false) => {
        if (updateState.status === 'running') return
        setUpdateState({ status: 'running', result: updateState.result })
        try {
          const response = await fetch(
            '/_dsh/vision-router/update-check' + (force ? '?force=1' : ''),
            { cache: 'no-store' },
          )
          const result = await response.json().catch(() => undefined)
          if (!response.ok) {
            throw new Error(result && result.error ? result.error : `HTTP ${response.status}`)
          }
          setUpdateState({ status: 'done', result })
        } catch (error) {
          setUpdateState({
            status: 'done',
            result: {
              ok: false,
              error: error && error.message ? error.message : String(error),
            },
          })
        }
      }

      const runSelfUpdate = async () => {
        if (selfUpdateState.status === 'running') return
        const checked = updateState.result
        const auto = checked && checked.autoUpdate
        if (!checked || checked.ok !== true || checked.updateAvailable !== true || !auto || !auto.token) return
        if (typeof window.confirm === 'function' && !window.confirm(t('updateConfirm'))) return
        setSelfUpdateState({ status: 'running', result: undefined })
        try {
          const response = await fetch('/_dsh/vision-router/self-update', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'x-dsh-vision-router-update-token': auto.token },
          })
          const result = await response.json().catch(() => undefined)
          if (!response.ok) {
            throw new Error(result && result.error ? result.error : `HTTP ${response.status}`)
          }
          setSelfUpdateState({ status: 'done', result })
        } catch (error) {
          setSelfUpdateState({
            status: 'error',
            result: { ok: false, error: error && error.message ? error.message : String(error) },
          })
        }
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

      const groupOptions = catalog.groups.filter((group) => group.id !== 'vision-http').map((group) =>
        h('option', { value: group.id, key: group.id },
          (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id)),
      )
      const visionGroupOptions = visionGroups.map((group) =>
        h('option', { value: group.id, key: group.id },
          (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id)),
      )
      const modelsOf = (providerId) => {
        const group = catalog.groups.find((entry) => entry.id === providerId)
        return group && Array.isArray(group.models) ? group.models : []
      }
      // The wire catalog carries no per-model modality fields, so the wrappers
      // editor filters by route id: it offers only TEXT routes to wrap and
      // drops the plugin's own image-capable routes (wrapper, twins, the
      // vision-http backend, the vision chain). deepseek-official stays: it is
      // the pre-filled default row, served by the built-in wrapper.
      const wrapExcludedRoutes = () => {
        const chainValue = readValue(snapshot, 'chainRoute')
        const wrapperValue = readValue(snapshot, 'wrapperRoute')
        return new Set([
          'vision-http',
          typeof chainValue === 'string' && chainValue !== '' ? chainValue : 'vision-chain',
          typeof wrapperValue === 'string' && wrapperValue !== '' ? wrapperValue : 'deepseek-vision',
        ])
      }
      const wrapGroupOptions = catalog.groups
        .filter((group) => {
          if (group.id === 'deepseek-official') return true
          if (wrapExcludedRoutes().has(group.id)) return false
          if (group.id.endsWith('-vision')) return false
          return true
        })
        .map((group) =>
          h('option', { value: group.id, key: group.id },
            (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id)),
        )
      const finishGuide = () => {
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
        const value = format('providers')
        const rows = Array.isArray(value) && value.length > 0 ? value : [{ provider: '', model: '' }]
        const invalidRows =
          visionCaps.status === 'ready'
            ? rows.filter((row) => row && row.provider && row.model && !visionModelVisible(row.provider, row.model))
            : []
        const updateChain = (index, next) => {
          const list = rows.map((row) => ({ ...row }))
          list[index] = next
          setDraft('providers', list)
        }
        const removeChain = (index) => {
          const list = rows.filter((_row, i) => i !== index)
          setDraft('providers', list.length > 0 ? list : [{ provider: '', model: '' }])
        }
        return h('div', {
          className: 'vr-field' + (guideActive ? ' vr-guide-target' : ''),
          id: 'vr-vision-backend-chain',
          'data-vr-guide-target': 'vision-backend',
          tabIndex: guideActive ? -1 : undefined,
        },
          guideCallout(),
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('chainLabel')),
            overriddenBadge('providers'),
          ),
          rows.map((row, index) =>
            h('div', { className: 'vr-chain-row', key: index },
              h('select', {
                className: 'vr-input vr-select', value: visionProviderVisible(row.provider) ? row.provider : '', disabled: !writable,
                onChange: (event) => updateChain(index, { provider: event.target.value, model: '' }),
              },
                h('option', { value: '' }, t('selectProvider')),
                visionGroupOptions,
              ),
              h('select', {
                className: 'vr-input vr-select', value: visionModelVisible(row.provider, row.model) ? row.model : '',
                disabled: !writable || !visionProviderVisible(row.provider),
                onChange: (event) => updateChain(index, { provider: row.provider, model: event.target.value }),
              },
                h('option', { value: '' }, visionProviderVisible(row.provider) ? t('selectModel') : t('pickProviderFirst')),
                visionModelsFor(row.provider).map((model) =>
                  h('option', { value: model.id, key: model.id },
                    (model.name && model.name !== model.id ? model.name + ' (' + model.id + ')' : model.id)),
                ),
              ),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: !writable, title: t('removeTitle'),
                onClick: () => removeChain(index),
              }, t('remove')),
            ),
          ),
          invalidRows.length > 0
            ? h('p', { className: 'vr-invalid' },
                t('chainInvalidCurrent') + ' ' + invalidRows.map((row) => row.provider + '/' + row.model).join('、'))
            : null,
          h('button', {
            type: 'button', className: 'vr-btn', disabled: !writable,
            onClick: () => setDraft('providers', [...rows, { provider: '', model: '' }]),
          }, t('addFallback')),
          h('p', { className: 'vr-hint' }, t('chainHint')),
        )
      }
      const builtinFallbackPanel = () => {
        const list = Array.isArray(visionCaps.builtinFallback) ? visionCaps.builtinFallback : []
        const enabled = format('freeFallback') !== false
        const primary = list[0] && list[0].model ? list[0].model : 'Qwen3.5-397B-A17B'
        const count = list.length > 0 ? list.length : 5
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('span', { className: 'vr-label' }, t('builtinFallbackLabel')),
            h('span', { className: 'vr-badge' }, enabled ? t('builtinFallbackEnabled') : t('builtinFallbackDisabled')),
          ),
          h('p', { className: 'vr-hint' }, t('builtinFallbackBody', { count, primary })),
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
                  (model.name && model.name !== model.id ? model.name + ' (' + model.id + ')' : model.id)),
              ),
            ),
          ),
          h('p', { className: 'vr-hint' }, t('textModelHint')),
        )
      }
      const wrappersEditor = () => {
        const value = format('wrappedProviders')
        const rows = Array.isArray(value) && value.length > 0 ? value : [{ provider: '', model: '' }]
        const updateWrap = (index, next) => {
          const list = rows.map((row) => ({ ...row }))
          list[index] = next
          setDraft('wrappedProviders', list)
        }
        const removeWrap = (index) => {
          const list = rows.filter((_row, i) => i !== index)
          setDraft('wrappedProviders', list.length > 0 ? list : [{ provider: '', model: '' }])
        }
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('textWrappedProviders')),
            overriddenBadge('wrappedProviders'),
          ),
          rows.map((row, index) =>
            h('div', { className: 'vr-chain-row', key: index },
              h('select', {
                className: 'vr-input vr-select', value: row.provider ?? '', disabled: !writable,
                onChange: (event) => updateWrap(index, { provider: event.target.value, model: '' }),
              },
                h('option', { value: '' }, t('selectProvider')),
                wrapGroupOptions,
              ),
              h('select', {
                className: 'vr-input vr-select', value: row.model ?? '',
                disabled: !writable || !row.provider,
                onChange: (event) => updateWrap(index, { provider: row.provider, model: event.target.value }),
              },
                h('option', { value: '' }, row.provider ? t('wrapAllModels') : t('pickProviderFirst')),
                modelsOf(row.provider).map((model) =>
                  h('option', { value: model.id, key: model.id },
                    (model.name && model.name !== model.id ? model.name + ' (' + model.id + ')' : model.id)),
                ),
              ),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: !writable, title: t('removeTitle'),
                onClick: () => removeWrap(index),
              }, t('remove')),
            ),
          ),
          h('button', {
            type: 'button', className: 'vr-btn', disabled: !writable,
            onClick: () => setDraft('wrappedProviders', [...rows, { provider: '', model: '' }]),
          }, t('addWrapper')),
          h('p', { className: 'vr-hint' }, t('wrapHint')),
        )
      }

      // Render-phase kick: whenever the body is open and the catalog was never
      // fetched (including after a remount that reset the state), start the
      // fetch. React supports setState during render for the same component,
      // and the status flips to 'loading' so this cannot loop. The same kick
      // runs the cheap test-connection probe once so the stealth keep-alive
      // notice (official row disabled) can render without a button click.
      if (open && catalog.status === 'idle') {
        loadCatalog()
      }
      if (open && visionCaps.status === 'idle') {
        loadVisionCapabilities()
      }
      if (open && testState.status === 'idle') {
        runTestConnection()
      }
      if (open && updateState.status === 'idle') {
        runUpdateCheck(false)
      }

      const updatePanel = () => {
        const result = updateState.result
        const auto = result && result.autoUpdate
        let status
        let failedUpdate = false
        if (updateState.status === 'running') {
          status = t('updateChecking')
        } else if (result && result.ok === true) {
          if (result.updateAvailable === true) {
            status = t('updateAvailable', { current: result.currentVersion, latest: result.latestVersion })
          } else if (result.aheadOfRegistry === true) {
            status = t('updateAhead', { current: result.currentVersion, latest: result.latestVersion })
          } else {
            status = t('updateCurrent', { current: result.currentVersion })
          }
        } else if (updateState.status === 'done') {
          failedUpdate = true
          status = t('updateFailed', { error: result && result.error ? result.error : 'unknown' })
        }
        let selfUpdateStatus
        let selfUpdateFailed = false
        if (selfUpdateState.status === 'running') {
          selfUpdateStatus = t('updateRunning')
        } else if (selfUpdateState.status === 'done' && selfUpdateState.result && selfUpdateState.result.ok === true) {
          selfUpdateStatus = t('updateSuccess', {
            latest: selfUpdateState.result.targetVersion || (result && result.latestVersion) || '',
          })
        } else if (selfUpdateState.status === 'error') {
          selfUpdateFailed = true
          selfUpdateStatus = t('updateActionFailed', {
            error: selfUpdateState.result && selfUpdateState.result.error ? selfUpdateState.result.error : 'unknown',
          })
        }
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('span', { className: 'vr-label' }, t('updateTitle')),
            h('button', {
              type: 'button', className: 'vr-btn',
              disabled: updateState.status === 'running' || selfUpdateState.status === 'running',
              onClick: () => runUpdateCheck(true),
            }, updateState.status === 'running' ? t('updateChecking') : t('checkUpdate')),
          ),
          status ? h('p', { className: failedUpdate ? 'vr-failed' : 'vr-hint' }, status) : null,
          result && result.ok === true && result.updateAvailable === true
            ? h('div', { className: 'vr-catalog-error' },
                h('p', { className: 'vr-hint' }, auto && auto.supported === true ? t('updateInstallHint') : t('updateAutoUnavailable')),
                auto && auto.supported === true && auto.token
                  ? h('button', {
                      type: 'button', className: 'vr-btn vr-btn-save',
                      disabled: selfUpdateState.status === 'running',
                      onClick: runSelfUpdate,
                    }, selfUpdateState.status === 'running'
                      ? t('updateRunning')
                      : t('updateNow', { latest: result.latestVersion }))
                  : null,
                result.releasesUrl
                  ? h('button', {
                      type: 'button', className: 'vr-btn',
                      disabled: selfUpdateState.status === 'running',
                      onClick: () => window.open(result.releasesUrl, '_blank', 'noopener,noreferrer'),
                    }, t('updateReleaseNotes'))
                  : null,
                selfUpdateStatus
                  ? h('p', { className: selfUpdateFailed ? 'vr-failed' : 'vr-hint' }, selfUpdateStatus)
                  : null,
              )
            : null,
        )
      }

      const stealthNotice = () => {
        if (testState.status !== 'done') return null
        const state = testState.result && testState.result.stealth
        if (!state || state.active !== true || state.reason !== 'official-unavailable') return null
        return h('p', { className: 'vr-hint vr-stealth-notice' }, t('stealthOfficialDeadHint'))
      }

      return h('li', { className: 'vr-card' + (open ? ' vr-card-open' : '') },
        h('button', {
          type: 'button', className: 'vr-header', 'aria-expanded': open,
          onClick: () => {
            if (!open) {
              loadCatalog()
              loadVisionCapabilities()
              runUpdateCheck(false)
            }
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
              h('div', { className: 'vr-quickstart' },
                h('div', { className: 'vr-quickstart-title' }, t('quickStartTitle')),
                h('p', { className: 'vr-quickstart-body' }, t('quickStartBody')),
                h('p', { className: 'vr-quickstart-live' }, t('quickStartLive')),
                h('div', { className: 'vr-quickstart-actions' },
                  h('button', {
                    type: 'button', className: 'vr-btn',
                    onClick: () => startVisionSettingsGuide(t),
                  }, t('quickStartGuide')),
                ),
              ),
              updatePanel(),
              TOGGLE_KEYS.map((key) => toggleField(key)),
              stealthNotice(),
              h('div', { className: 'vr-group' },
                h('p', { className: 'vr-group-title' }, t('groupWrappers')),
                catalogReady
                  ? wrappersEditor()
                  : textField('wrappedProviders', t('textWrappedProviders'), t('textHintWrappedProviders'), true),
              ),
              h('p', { className: 'vr-hint' }, t('defaultChainNote')),
              visionCaps.status === 'loading'
                ? h('p', { className: 'vr-hint' }, t('visionCapsLoading'))
                : visionCaps.status === 'error'
                  ? h('p', { className: 'vr-hint vr-stealth-notice' }, t('visionCapsError'))
                  : visionCaps.status === 'ready'
                    ? h('p', { className: 'vr-hint' }, t('visionCapsFiltered'))
                    : null,
              catalogReady
                ? chainEditor()
                : h('div', {
                    className: guideActive ? 'vr-guide-target' : '',
                    id: 'vr-vision-backend-chain',
                    'data-vr-guide-target': 'vision-backend',
                    tabIndex: guideActive ? -1 : undefined,
                  },
                    guideCallout(),
                    textField('providers', t('textProviders'), t('textProvidersHint'), true),
                  ),
              builtinFallbackPanel(),
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
                testState.status !== 'idle'
                  ? h('p', {
                      className: testState.result && testState.result.ok ? 'vr-hint' : 'vr-failed',
                      style: { margin: 0 },
                    },
                      testState.status === 'running'
                        ? t('testConnecting')
                        : testState.result && testState.result.ok
                          ? `${t('testOk')}（${typeof testState.result.latencyMs === 'number' ? testState.result.latencyMs + 'ms' : 'ok'}）`
                          : `${t('testFailed')}：${testState.result && testState.result.error ? testState.result.error : 'unknown'}`)
                  : null,
                h('button', {
                  type: 'button', className: 'vr-btn', disabled: testState.status === 'running',
                  onClick: runTestConnection,
                }, t('testConnection')),
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

    const ARTIFACT_TOOL_KEYS = [
      'vision_crop',
      'vision_pixel_diff',
      'vision_trace',
      'vision_extract_foreground',
      'vision_html_screenshot',
      'vision_long_screenshot_ocr',
      'vision_ground',
    ]
    const ARTIFACT_PATH_KEYS = ['path', 'annotatedPath', 'markdownPath', 'manifestPath', 'heatmapPath', 'reportPath']

    function textOf(block) {
      if (!block) return undefined
      if (typeof block === 'string') return block
      if (typeof block.text === 'string') return block.text
      if (Array.isArray(block.content)) {
        return block.content.map((child) => textOf(child)).filter((part) => part !== undefined).join('\n')
      }
      if (block.result !== undefined && block.result !== null) return textOf(block.result)
      return undefined
    }

    function ArtifactCard(props) {
      const { toolName, block, openFile } = props
      const raw = textOf(block)
      let parsed
      if (raw !== undefined && raw !== '') {
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = undefined
        }
      }
      const paths =
        parsed && typeof parsed === 'object'
          ? ARTIFACT_PATH_KEYS.filter((key) => typeof parsed[key] === 'string' && parsed[key] !== '')
          : []
      const facts =
        parsed && typeof parsed === 'object'
          ? Object.entries(parsed)
              .filter(([key]) => !ARTIFACT_PATH_KEYS.includes(key) && key !== 'text')
              .slice(0, 6)
          : []
      if (paths.length === 0 && facts.length === 0) {
        return React.createElement(
          'div',
          { style: { fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', padding: '4px 0' } },
          raw ?? '',
        )
      }
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' } },
        facts.map(([key, value]) =>
          React.createElement(
            'div',
            { key, style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 8 } },
            React.createElement('span', { style: { minWidth: 90, color: 'var(--dsw-alias-label-tertiary)' } }, key),
            React.createElement('span', { style: { fontFamily: 'monospace' } }, typeof value === 'object' ? JSON.stringify(value) : String(value)),
          ),
        ),
        paths.map((key) =>
          React.createElement(
            'button',
            {
              key,
              type: 'button',
              onClick: () => (typeof openFile === 'function' ? openFile(parsed[key]) : undefined),
              style: {
                alignSelf: 'flex-start',
                font: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
                color: 'var(--dsw-alias-brand-primary, #4c8bf5)',
                background: 'none',
                border: 'none',
                padding: 0,
              },
            },
            `打开 ${key}: ${parsed[key]}`,
          ),
        ),
      )
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: 'vision-router' })
      const presentedImageUrls = new Map()
      const createdImageUrls = new Set()
      const loadPresentedImage = (sessionId, attachment) => {
        const key = `${String(sessionId)}:${String(attachment.attachmentId)}`
        const cached = presentedImageUrls.get(key)
        if (cached !== undefined) return cached
        const pending = (async () => {
          const binding = ctx.sessions.binding(sessionId)
          if (binding === undefined) throw new Error(`vision_present: unknown session ${String(sessionId)}`)
          const result = await binding.session.readAttachment(attachment.attachmentId)
          if (!result.ok) {
            throw new Error(`vision_present: ${result.error.code}: ${result.error.message}`)
          }
          const ref = result.value.attachment
          const data = result.value.data
          if (typeof URL.createObjectURL === 'function') {
            const url = URL.createObjectURL(new Blob([data], { type: ref.mediaType }))
            createdImageUrls.add(url)
            return url
          }
          let binary = ''
          const chunk = 0x8000
          for (let offset = 0; offset < data.length; offset += chunk) {
            binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
          }
          return `data:${ref.mediaType};base64,${btoa(binary)}`
        })().catch((error) => {
          presentedImageUrls.delete(key)
          throw error
        })
        presentedImageUrls.set(key, pending)
        return pending
      }
      // Follow the app language: register our dictionaries and re-read them
      // whenever the user switches the locale in Settings → General.
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vision-router: card locale')
      const t = ctx.locale.bind(NS)
      const VisionPresentCard = (props) => {
        const { block, sessionId } = props
        const content = block && Array.isArray(block.content) ? block.content : []
        const images = content
          .filter((item) => item && item.type === 'image' && item.attachment)
          .map((item) => ({ attachment: item.attachment }))
        if (images.length === 0) {
          return React.createElement(
            'div',
            { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '4px 0' } },
            t('presentingImage'),
          )
        }
        let parsed
        const raw = textOf(block)
        if (raw) {
          try { parsed = JSON.parse(raw) } catch { parsed = undefined }
        }
        const labels = {
          image: t('presentedImage'),
          open: t('openPresentedImage'),
          openNamed: (name) => t('openNamedImage', { name }),
          loading: t('loadingPresentedImage'),
          loadFailed: t('retryPresentedImage'),
          lightbox: { dialog: t('imagePreviewDialog'), close: t('closeImagePreview') },
        }
        return React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: '4px 0' } },
          parsed && typeof parsed.label === 'string' && parsed.label !== 'image'
            ? React.createElement(
                'div',
                { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                parsed.label,
              )
            : null,
          React.createElement(ImageGallery, {
            images,
            align: 'start',
            labels,
            load: (attachment) => loadPresentedImage(sessionId, attachment),
          }),
        )
      }
      ctx.effect(
        () => () => {
          for (const url of createdImageUrls) URL.revokeObjectURL(url)
          createdImageUrls.clear()
          presentedImageUrls.clear()
        },
        'vision-router: presented image URL cache',
      )
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
      ctx.effect(() => installVisionSettingsGuide(t), 'vision-router: model selection guide')
      ctx.effect(() => installOnboarding(t), 'vision-router: first-run onboarding')
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
      ctx.effect(
        () =>
          ctx.slots.inject('tool.call.toolview', function* () {
            yield ctx.slots.register(
              { name: 'tool.call.toolview', key: 'vision_present', inject: () => ({}) },
              VisionPresentCard,
            )
            for (const key of ARTIFACT_TOOL_KEYS) {
              yield ctx.slots.register(
                { name: 'tool.call.toolview', key, inject: () => ({}) },
                ArtifactCard,
              )
            }
          }),
        'vision-router: artifact tool cards',
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots', 'locale', 'sessions']
    exports.unwrapModelsResult = unwrapModelsResult
    exports.filterVisionBackendGroups = filterVisionBackendGroups
    return module.exports
  },
})

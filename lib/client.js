// dsh-vision-router browser half: a first-class 设置 > Vision Router page plus
// the legacy 设置 > 插件 configuration card, both editing the same host-owned
// `vision-router` settings namespace. Self-contained by hand (no bundler in
// this repo): the client module system wraps it in a CJS factory and the kernel
// adopts { apply, inject } as a client plugin.
window.__ModuleLoader__.load({
  id: 'dsh-vision-router',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useMemo, useEffect } = React
    const { ImageGallery } = require('@deepseek-ai/dsh-client-ui-attachment')
    const { useSettings } = require('@deepseek-ai/dsh-client-ui-settings')
    // ── locale dictionaries (follow the app's language setting) ─────────────
    const NS = 'vision-router'
    const zh = {
      nav: 'Vision Router · 图片识别',
      desc: '聊天模型负责思考与回答，识图模型负责看图片；两者可以独立设置',
      quickStartTitle: '聊天和看图分别设置',
      quickStartBody: '聊天模型负责思考和回答，识图模型负责看图片。发图片时，在聊天页选择带「+ 自动识图」的模型即可。',
      quickStartLive: '只想更换识图模型？直接修改下面的「识图模型」，不会影响当前聊天模型。',
      quickStartGuide: '重新查看新手引导',
      onboardingTitle: 'Vision Router 已准备好 🎉',
      onboardingBody: '第一次使用只需要记住：聊天模型负责回答，识图模型负责看图。跟着下面 3 步设置即可。',
      onboardingStep1Title: '1 · 选择聊天模型',
      onboardingStep1Body: '在聊天页右下角选择你平时使用的模型。需要发图片时，请选择带「+ 自动识图」的版本。',
      onboardingStep2Title: '2 · 选择识图模型',
      onboardingStep2Body: '打开「设置 → Vision Router」，在「识图模型」里选择。它只负责读取图片，不会替换你的聊天模型。',
      onboardingStep3Title: '3 · 设置备用模型',
      onboardingStep3Body: '可以添加多个识图模型；前一个不可用时会自动尝试下一个。全部失败后，还可以使用内置免费兜底。',
      onboardingGuide: '带我设置识图模型',
      onboardingLater: '稍后',
      onboardingClose: '关闭',
      guideStep1Title: '第 1 步 · 选择聊天模型',
      guideStep1Body: '聊天页右下角、输入框旁的模型选择器已经被高亮。选择你平时使用的聊天模型；发图片时请选择带「+ 自动识图」的版本。选好后点击「下一步」。',
      guideStepNext: '下一步',
      guidePromptTitle: '第 2 步 · 选择识图模型',
      guidePromptGearBody: '点击侧边栏左下角被高亮圈出的「设置」齿轮打开设置面板；也可以直接点「下一步」帮你打开。',
      guidePromptNavBody: '在设置面板左侧点击被高亮的「Vision Router」入口（或点「下一步」自动进入）。进入后，我会自动定位到「识图模型」。',
      guidePromptCancel: '结束引导',
      guideChainTitle: '第 3 步 · 设置备用模型',
      guideChainBody: '这里的识图模型会从上到下依次尝试。可以添加多个备用模型，也可以全部留空；内置 OVH 免费模型会在最后自动兜底。选好后点击页面底部「保存」。',
      guideDone: '完成引导',
      pending: '未保存',
      readOnly: '当前设置提供方只读。',
      overridden: '已覆盖',
      reset: '恢复默认',
      toggleInstantDescribe: '即时本地识图',
      hintInstantDescribe: '开启后（需同时开启至少一个本地视觉后端），图片轮第一轮直接用本地模型识别图片块；若同时开启「结构化预识别（1+x）」，则由 1+x 首遍识别接管，本开关不会额外再跑一遍；Ollama 失败会继续尝试 LM Studio。一次贴多张图时并发识别（上限 3，本地推理受显存限制），单张失败自动跳过、不影响其余；整体失败则回退为工具提示标记。会话日志仍保留原图。',
      groupLocalOllama: '本地视觉 · Ollama / LM Studio',
      localVisionHeroHint: '这里只配置 Ollama / LM Studio 本地视觉后端；自动首遍识别统一由上方「结构化预识别（1+x）」控制，无需额外开关。',
      localVisionOff: '未开启',
      localVisionOn: '已开启',
      localVisionStylePlainShort: '平铺',
      localVisionStyleStructuredShort: '结构化',
      localVisionInstantShort: '即时识别',
      localOllamaEnabled: '本地 Ollama 识别',
      localOllamaBaseURL: 'Ollama 地址（OpenAI 兼容）',
      localOllamaModel: 'Ollama 模型名',
      localOllamaTemperature: '温度 temperature',
      localOllamaTopP: 'top_p',
      localRequestFormat: '请求协议',
      localFormatOpenAI: 'OpenAI（/chat/completions）',
      localFormatAnthropic: 'Anthropic（/messages）',
      localTemperaturePlaceholder: '留空=服务端默认；建议 0.5',
      localTopPPlaceholder: '留空=服务端默认；建议 0.8',
      localLmStudioModelPlaceholder: '填写 Developer 页或 /v1/models 中的模型标识',
      localLmStudioModelRequired: '启用 LM Studio 时必须填写真实模型标识。',
      localModelRequiredShort: '模型待填写',
      hintLocalOllama: '开启后 local-ollama 排在视觉链最前（隐私 / 零费用 / 离线）；Ollama 未运行时自动跳过并降级到云链，不影响任何调用。默认关闭。',
      localLmStudioEnabled: '本地 LM Studio 识别',
      localLmStudioBaseURL: 'LM Studio 地址（OpenAI 兼容）',
      localLmStudioModel: 'LM Studio 模型名',
      localLmStudioTemperature: '温度 temperature',
      localLmStudioTopP: 'top_p',
      hintLocalLmStudio: '与 Ollama 同层级的本地后端：LM Studio 的兼容端点（默认 http://localhost:1234/v1）。模型名必须填写 Developer 页或 /v1/models 返回的真实模型标识。启用后 local-lmstudio 排在 local-ollama 之后、云链之前；未运行时自动跳过降级。默认关闭。',
      localDescribeStyle: '本地识别输出风格',
      localDescribeStylePlain: '平铺描述',
      localDescribeStyleStructured: '结构化（cite初步判断 格式）',
      hintLocalDescribeStyle: '仅影响本地识别（即时识图 / 截图识图）的输出格式；结构化对截图分析（GUI / 文档 / 聊天记录）质量更高。',
      invalidProviders: '每行需为「provider/model」，例如 openrouter/qwen3-vl-235b',
      invalidTextProvider: '格式为「provider/model」，例如 deepseek-official/deepseek-v4-pro',
      invalidTimeout: '需为有效整数',
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
      chainLabel: '识图模型',
      chainHint: '选择 Vision Router 用来读取图片的模型。将按从上到下的顺序尝试，失败时自动切换到下一个。',
      addFallback: '+ 添加备用识图模型',
      remove: '移除',
      removeTitle: '移除这一行',
      textModelLabel: '文字回退模型',
      textModelHint: '通常无需设置；留空即使用默认聊天模型。',
      defaultChainNote: '这里设置负责看图的模型，不会改变聊天页选择的聊天模型。你的模型按顺序尝试；内置 OVH 免费模型固定作为最后兜底。',
      catalogLoading: '正在加载模型目录（与「设置 > 模型」同源）…',
      catalogUnavailable: '连接服务不可用（拿不到模型目录），退回手动输入。',
      catalogTimeout: '目录请求超时（15 秒）',
      catalogEmpty: '模型目录为空：',
      catalogErrorEnvelope: '模型目录接口返回失败',
      catalogError: '模型目录不可用（',
      catalogFallback: '），模型字段已退回手动输入。',
      catalogPartialFailure: '部分已配置供应商的模型目录加载失败：{detail}。这些供应商可能仍会显示在「设置 → 模型」中，但暂时不会出现在这里。',
      visionCapsLoading: '正在读取模型图片能力声明（仅用于提示，不影响可选模型）…',
      visionCapsError: '视觉能力元数据暂时不可用；模型仍可选择，实际可用性将由供应商已注册的 DSH adapter 在调用时验证。',
      visionCapsFiltered: '模型能力声明只用于提示，不再作为准入条件；未声明图片能力或标成仅文本的生成式模型也可选择，调用失败会自动回退。',
      visionCapabilityUndeclaredWarning: '此模型暂未附图片能力声明，不影响使用：调用时会实际尝试，失败后自动切换下一个模型。',
      visionCapabilityTextOnlyWarning: '此模型被标记为仅文本，仍可直接使用：调用时自动验证图片能力，不支持会自动切换下一个模型。',
      visionCapabilityUnknownWarning: '此模型的图片能力会在调用时自动验证，无需额外配置；失败会自动切换下一个模型。',
      visionCapsEmptyTitle: '没有可选的用户视觉模型',
      visionCapsEmptyBody: '检测到 {count} 个用户模型，但它们都没有被 DSH 明确标记为支持图片，因此已被安全隐藏。',
      visionCapsHiddenPrefix: '被隐藏的模型：',
      visionCapsReasonMissingImage: '未声明 image',
      visionCapsReasonUnverified: '无法验证图片能力',
      visionCapsHiddenMore: '另有 {count} 个模型未显示',
      visionCapsMissingImageHint: '如果这里有你刚在「设置 → 模型 → 添加自定义提供方」中添加的视觉模型：可以在高级设置「额外视觉模型」的下拉里选中它直接启用；或按 DSH 的方式在 $DSH_HOME/settings.yaml 为该模型补上 input: [text, image]（或为整个提供方补 defaultInput: [text, image]）。DSH 当前 Web 表单不会写入这个字段。',
      visionCapsRetry: '重新检测模型',
      chainInvalidCurrent: '当前保存的后端已不在可调用模型目录中，或属于非生成式/递归路由，运行时会跳过：',
      retryCatalog: '重试加载目录',
      advanced: '高级设置',
      groupPerformance: '性能',
      groupCompatibility: '兼容性',
      groupCost: '成本',
      groupNetwork: '网络',
      groupDeveloper: '开发者设置',
      groupDiagnostics: '版本与诊断',
      developerHint: '这些选项用于路由覆盖、能力标记和兼容调试；一般无需修改。',
      groupTextModel: '文字回退模型',
      textModelGroupHint: '通常无需设置。仅在开启「整轮交给视觉模型」且需要把纯文字消息切回聊天模型时使用。',
      groupBehavior: '识图行为',
      groupParams: '性能与超时',
      groupVisionOverrides: '视觉能力覆盖',
      extraVisionModelsLabel: '额外视觉模型标记',
      extraVisionModelsHint: '这个设置不再用于“解锁”下拉或允许调用；所有可调用生成式模型本来就能被选择。只有当你希望把某个未声明图片能力的模型明确标记为视觉模型时才需要填写。实际调用仍优先走 DSH adapter；只有明确的 http(s) OpenAI Chat Completions 渠道才可能使用直连兼容兜底。',
      groupRoutes: '路由名称',
      groupProxy: '网络',
      proxyLabel: '代理地址',
      proxyHint: '如 http://127.0.0.1:10808 或 socks5h://127.0.0.1:10808；留空关闭。修改即时生效。',
      proxyHostsLabel: '走代理的域名（每行一个）',
      proxyHostsHint: '仅这些域名经代理，其余直连；留空清除覆盖。修改即时生效。',
      saveFailed: '保存失败：部分配置未写入。未写入的修改已保留，请重试。',
      discard: '放弃修改',
      testConnection: '测试连接',
      testConnecting: '测试中…',
      testOk: '连接正常',
      testFailed: '连接失败',
      openLogFolder: '打开日志文件夹',
      openLogFolderFailed: '无法打开日志文件夹',
      updateTitle: '版本更新',
      checkUpdate: '检查更新',
      updateChecking: '检查中…',
      updateAvailable: '发现新版本 v{latest}（当前 v{current}）',
      updateCurrent: '已是最新版本 v{current}',
      updateAhead: '当前 v{current} 高于 registry 最新 v{latest}；可能是源码或预发布构建，不会建议降级。',
      updateFailed: '更新检查失败：{error}',
      updateNoDiagnostic: '更新检查接口未返回可诊断的错误详情',
      updateInvalidResponse: '更新检查接口返回了无效响应',
      updateInstallHint: '已安全识别当前 DSH CLI，可直接用这套 DSH 更新插件；完成后需要重启 DSH 才会加载新版本。',
      updateAutoUnavailable: '当前 DSH CLI 无法被安全识别，因此不执行自动更新。请沿用你原来安装 DSH / 插件的方式手动更新。',
      updateNow: '一键更新到 v{latest}',
      updateRunning: '正在更新…',
      updateConfirm: '将通过当前正在运行的 DSH 更新 Vision Router。更新完成后需要重启 DSH。继续吗？',
      updateSuccess: '更新命令已完成（目标 v{latest}）。请重启 DSH；重启后新版本才会生效。',
      updateError: '更新失败：{error}',
      packageName: '包名',
      installedVersion: '当前版本',
      diagnosticNote: '如果你是源码安装或预发布构建，当前版本可能高于 npm registry。',
      copyDiagnostics: '复制诊断信息',
      copiedDiagnostics: '已复制',
      copyDiagnosticsFailed: '复制失败',
      compatibilityTitle: '兼容性',
      localVisionTitle: '本地视觉',
      remoteSettingsTitle: '远程设置',
      remoteSettingsDesc: '允许受信任的 DSH 页面读取并修改经过审核的 Vision Router 安全设置。网络、代理、文件路径、本地后端和凭据相关字段仍然只能在本机修改。',
      allowRemoteSettingsLabel: '允许远程修改安全设置',
      allowRemoteSettingsHint: '关闭时远程页面只能看到“未授权”；开启后仅允许修改明确列入安全白名单的偏好设置。',
      settingsModeRemote: '远程设置模式',
      settingsModeLocal: '本机设置模式',
      settingsRemoteDisabled: '远程设置未授权。请在运行 DSH 的设备上开启「允许远程修改安全设置」。',
      settingsRemoteReadonly: '远程设置当前只读。',
      settingsRemoteUnavailable: '远程设置连接不可用。',
      settingsRemoteRetry: '重试',
      settingsRemoteBadge: '远程',
      settingsLocalBadge: '本机',
      providersLabel: '识图模型链',
      routingLabel: '启用视觉路由',
      reverseRoutingLabel: '反向路由',
      toolLabel: '启用视觉工具',
      structuredVisionBootstrapLabel: '结构化预识别（1+x）',
      structuredVisionBootstrapHint: '开启后先做 1 遍结构化预识别，再让模型按问题决定是否继续调用视觉工具；bootstrap 那一遍不计入后续深挖次数。',
      selectVisionDepth: '看图深度',
      visionDepthFast: '快速（最多再细看 1 次）',
      visionDepthStandard: '标准（细看 1-2 次，默认）',
      visionDepthDeep: '细致（细看 2-4 次）',
      visionDepthCustom: '自定义（自己填次数上限）',
      hintVisionDepth: '选择看图时的精细度：快速最省（最多再细看 1 次）、标准为默认（细看 1-2 次）、细致看得最细（细看 2-4 次）。档位只限制「再细看几次」，具体看什么由模型按你的问题决定。',
      labelVisionDepthMaxCalls: '自定义深挖次数上限',
      hintVisionDepthMaxCalls: '选择「自定义」后填写次数上限（1-100）；留空或填 0 = 不限制深挖次数。bootstrap 预识别那遍不计入，失败的调用也不占次数；切回快速/标准/细致后保留已填值但不生效。',
      guidanceOverridesLabel: '识图引导覆盖',
      guidanceOverridesHint: '按视觉类型覆盖默认的深挖提示。留空使用内置引导。',
      guidanceOverrideKind: '类型',
      guidanceOverrideText: '引导文本',
      guidanceOverrideAdd: '+ 添加引导',
      guidanceOverrideRemove: '移除',
      guidanceOverrideKindPlaceholder: '例如 document / ui / code',
      guidanceOverrideTextPlaceholder: '填写这个类型的识图引导…',
      progressiveToolsLabel: '渐进式视觉工具',
      progressiveToolsHint: '按需暴露视觉工具以减少长会话里的工具 schema 变化。默认关闭以保持兼容。',
      autoActivateOnImageLabel: '图片消息自动激活',
      autoActivateOnImageHint: '收到图片时自动激活视觉工具。',
      extraVisionModelsLabelShort: '额外视觉模型',
      rewriteImagesLabel: '改写图片消息',
      downscaleLabel: '大图自动缩放',
      cacheLabel: '识图缓存',
      freeFallbackLabel: '免费兜底',
      freeCloudFirstLabel: '免费云模型优先',
      autoWrapProvidersLabel: '自动包装聊天模型',
      wrappedProvidersLabel: '指定包装的 Provider',
      timeoutMsLabel: '单次视觉请求超时（ms）',
      visionTaskTimeoutMsLabel: '一次识图任务总时限（ms）',
      ocrTimeoutMsLabel: 'OCR 总时限（ms）',
      downscaleMaxPixelsLabel: '最大像素数',
      cacheTtlSecondsLabel: '缓存有效期（秒）',
      cacheMaxEntriesLabel: '缓存条目上限',
      legacyMovedTitle: 'Vision Router 设置已移动',
      legacyMovedBody: '主设置入口现在位于「设置 → Vision Router」。此处仅保留兼容入口，不再维护第二份可编辑表单。',
      legacyOpen: '打开 Vision Router 设置',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      reload: '重新读取',
      unknownError: '未知错误',
    }

    const en = {
      nav: 'Vision Router · Image Vision',
      desc: 'Your chat model reasons and answers; vision models read images. Configure them independently.',
      quickStartTitle: 'Configure chat and vision separately',
      quickStartBody: 'Your chat model handles reasoning and answers. Vision Router only reads images. When sending images, choose a chat model with “+ Auto Vision”.',
      quickStartLive: 'Only changing the vision model? Edit “Vision models” below; your current chat model is unaffected.',
      quickStartGuide: 'Show setup guide again',
      onboardingTitle: 'Vision Router is ready 🎉',
      onboardingBody: 'For first use, remember one thing: the chat model answers, the vision model sees. Follow these 3 steps.',
      onboardingStep1Title: '1 · Pick a chat model',
      onboardingStep1Body: 'Use the model picker next to the chat input. When sending an image, choose the version with “+ Auto Vision”.',
      onboardingStep2Title: '2 · Pick a vision model',
      onboardingStep2Body: 'Open Settings → Vision Router and choose “Vision models”. This only changes image reading, not your chat model.',
      onboardingStep3Title: '3 · Add fallbacks',
      onboardingStep3Body: 'Add several vision models if you want; they are tried top to bottom. The built-in free fallback remains last.',
      onboardingGuide: 'Guide me through setup',
      onboardingLater: 'Later',
      onboardingClose: 'Close',
      guideStep1Title: 'Step 1 · Pick a chat model',
      guideStep1Body: 'The chat model picker next to the input is highlighted. Pick your normal chat model; when sending an image use a “+ Auto Vision” version. Then press Next.',
      guideStepNext: 'Next',
      guidePromptTitle: 'Step 2 · Pick a vision model',
      guidePromptGearBody: 'Click the highlighted Settings gear in the lower-left sidebar; or press Next and I can open Settings for you.',
      guidePromptNavBody: 'In Settings, click the highlighted Vision Router entry (or press Next to open it automatically). I will then focus the “Vision models” field.',
      guidePromptCancel: 'End guide',
      guideChainTitle: 'Step 3 · Add fallbacks',
      guideChainBody: 'Vision models are tried top to bottom. You may add multiple fallbacks or leave them empty; the built-in OVH free models remain last. Press Save when done.',
      guideDone: 'Finish guide',
      pending: 'Unsaved',
      readOnly: 'The current settings provider is read-only.',
      overridden: 'Overridden',
      reset: 'Reset',
      toggleInstantDescribe: 'Instant local vision',
      hintInstantDescribe: 'When enabled (with at least one local vision backend enabled), image turns are described locally on the first pass. If Structured pre-scan (1+x) is also enabled, 1+x owns the first pass and this switch does not run an extra pass. Ollama failures fall through to LM Studio. Multiple images run concurrently (cap 3, subject to local VRAM); one failure does not block the rest. If all fail, Vision Router falls back to its normal tool hint. Original images remain in the session log.',
      groupLocalOllama: 'Local vision · Ollama / LM Studio',
      localVisionHeroHint: 'Configure Ollama / LM Studio vision backends here. The automatic first pass is controlled by “Structured pre-scan (1+x)” above; no extra switch is needed.',
      localVisionOff: 'Off',
      localVisionOn: 'On',
      localVisionStylePlainShort: 'Plain',
      localVisionStyleStructuredShort: 'Structured',
      localVisionInstantShort: 'Instant',
      localOllamaEnabled: 'Local Ollama vision',
      localOllamaBaseURL: 'Ollama URL (OpenAI compatible)',
      localOllamaModel: 'Ollama model',
      localOllamaTemperature: 'Temperature',
      localOllamaTopP: 'top_p',
      localRequestFormat: 'Request protocol',
      localFormatOpenAI: 'OpenAI (/chat/completions)',
      localFormatAnthropic: 'Anthropic (/messages)',
      localTemperaturePlaceholder: 'Blank = server default; suggested 0.5',
      localTopPPlaceholder: 'Blank = server default; suggested 0.8',
      localLmStudioModelPlaceholder: 'Use the exact model id from Developer or /v1/models',
      localLmStudioModelRequired: 'A real model id is required when LM Studio is enabled.',
      localModelRequiredShort: 'Model required',
      hintLocalOllama: 'When enabled, local-ollama is first in the vision chain (private / free / offline). If Ollama is unavailable it is skipped automatically and cloud fallbacks continue. Off by default.',
      localLmStudioEnabled: 'Local LM Studio vision',
      localLmStudioBaseURL: 'LM Studio URL (OpenAI compatible)',
      localLmStudioModel: 'LM Studio model',
      localLmStudioTemperature: 'Temperature',
      localLmStudioTopP: 'top_p',
      hintLocalLmStudio: 'Local LM Studio OpenAI-compatible endpoint (default http://localhost:1234/v1). The model id must match Developer or /v1/models. It is tried after local Ollama and before cloud models; if unavailable it is skipped. Off by default.',
      localDescribeStyle: 'Local vision output style',
      localDescribeStylePlain: 'Plain description',
      localDescribeStyleStructured: 'Structured (citeinitial assessment)',
      hintLocalDescribeStyle: 'Only affects local vision output (instant vision / screenshot vision). Structured output is more useful for GUI, documents, and chat screenshots.',
      invalidProviders: 'Each line must be provider/model, e.g. openrouter/qwen3-vl-235b',
      invalidTextProvider: 'Use provider/model, e.g. deepseek-official/deepseek-v4-pro',
      invalidTimeout: 'Enter a valid integer',
      invalidGeneric: 'Invalid input',
      selectProvider: 'Select provider…',
      selectModel: 'Select model…',
      pickProviderFirst: 'Pick a provider first',
      freeTag: ' (free)',
      builtinFreeTag: ' (built-in free model)',
      builtinFallbackLabel: 'Built-in free fallback (automatic)',
      builtinFallbackEnabled: 'Enabled',
      builtinFallbackDisabled: 'Disabled',
      builtinFallbackBody: 'The anonymous OVHcloud vision chain has {count} models, starting with {primary}. The anonymous limit is 2 requests/minute per IP per model; five models have independent limits, so the theoretical aggregate is about 10/minute. It is always tried after your configured models and requires no account or key.',
      chainLabel: 'Vision models',
      chainHint: 'Choose the models Vision Router uses to read images. They are tried from top to bottom and automatically fall back on failure.',
      addFallback: '+ Add fallback vision model',
      remove: 'Remove',
      removeTitle: 'Remove this row',
      textModelLabel: 'Text fallback model',
      textModelHint: 'Usually unnecessary; leave blank to use the default chat model.',
      defaultChainNote: 'These models read images and do not change the chat model selected in chat. Your models are tried in order; built-in OVH free models remain the final fallback.',
      catalogLoading: 'Loading the model catalog (same source as Settings > Models)…',
      catalogUnavailable: 'Connection service unavailable; falling back to manual input.',
      catalogTimeout: 'Catalog request timed out (15s)',
      catalogEmpty: 'Model catalog is empty: ',
      catalogErrorEnvelope: 'Model catalog returned an error',
      catalogError: 'Model catalog unavailable (',
      catalogFallback: '); model fields switched to manual input.',
      catalogPartialFailure: 'Some configured providers failed to load their model catalog: {detail}. They may still appear in Settings → Models but are temporarily absent here.',
      visionCapsLoading: 'Reading image capability metadata (advisory only)…',
      visionCapsError: 'Vision capability metadata is temporarily unavailable. Models are still selectable; DSH adapters validate actual image support at call time.',
      visionCapsFiltered: 'Capability declarations are advisory only. Models without an image declaration, or even models marked text-only, remain selectable and will fall back automatically if the call fails.',
      visionCapabilityUndeclaredWarning: 'This model has no image declaration. That does not block it: Vision Router will try it and fall back automatically on failure.',
      visionCapabilityTextOnlyWarning: 'This model is marked text-only but can still be selected. Actual image support is checked at call time; failures fall back automatically.',
      visionCapabilityUnknownWarning: 'Image support will be checked at call time; no extra setup is required.',
      visionCapsEmptyTitle: 'No user vision model is available',
      visionCapsEmptyBody: 'Detected {count} user models, but none are explicitly marked image-capable, so they were hidden for safety.',
      visionCapsHiddenPrefix: 'Hidden models: ',
      visionCapsReasonMissingImage: 'image not declared',
      visionCapsReasonUnverified: 'image capability unverified',
      visionCapsHiddenMore: '{count} more model(s) hidden',
      visionCapsMissingImageHint: 'If this is a custom vision model you just added under Settings → Models → Custom provider: pick it in the advanced “Extra vision models” selector; or add input: [text, image] for that model in $DSH_HOME/settings.yaml (or defaultInput: [text, image] for the provider). The current DSH Web form does not write this field.',
      visionCapsRetry: 'Retry model scan',
      chainInvalidCurrent: 'The currently saved backend is no longer callable, or is a non-generative / recursive route, and will be skipped at runtime: ',
      retryCatalog: 'Retry catalog',
      advanced: 'Advanced settings',
      groupPerformance: 'Performance',
      groupCompatibility: 'Compatibility',
      groupCost: 'Cost',
      groupNetwork: 'Network',
      groupDeveloper: 'Developer',
      groupDiagnostics: 'Version & diagnostics',
      developerHint: 'These options are for route overrides, capability markers, and compatibility debugging. Most users should leave them unchanged.',
      groupTextModel: 'Text fallback model',
      textModelGroupHint: 'Usually unnecessary. Only used when whole-turn vision routing is enabled and plain-text turns should return to the chat model.',
      groupBehavior: 'Vision behavior',
      groupParams: 'Performance & timeouts',
      groupVisionOverrides: 'Vision capability overrides',
      extraVisionModelsLabel: 'Extra vision model markers',
      extraVisionModelsHint: 'This no longer unlocks the selector or permits calls; every callable generative model is selectable already. Use this only to explicitly mark a model whose image capability is undeclared. Calls still prefer registered DSH adapters; only explicit http(s) OpenAI Chat Completions channels may use the direct-compatible fallback.',
      groupRoutes: 'Route names',
      groupProxy: 'Network',
      proxyLabel: 'Proxy URL',
      proxyHint: 'For example http://127.0.0.1:10808 or socks5h://127.0.0.1:10808. Leave blank to disable. Takes effect immediately.',
      proxyHostsLabel: 'Proxy hosts (one per line)',
      proxyHostsHint: 'Only these hosts use the proxy; others connect directly. Leave blank to clear the override. Takes effect immediately.',
      saveFailed: 'Save failed: some settings did not persist. Unsaved edits were kept; please retry.',
      discard: 'Discard changes',
      testConnection: 'Test connection',
      testConnecting: 'Testing…',
      testOk: 'Connection OK',
      testFailed: 'Connection failed',
      openLogFolder: 'Open log folder',
      openLogFolderFailed: 'Could not open log folder',
      updateTitle: 'Updates',
      checkUpdate: 'Check for updates',
      updateChecking: 'Checking…',
      updateAvailable: 'New version v{latest} available (current v{current})',
      updateCurrent: 'You are on the latest version v{current}',
      updateAhead: 'Current v{current} is newer than registry v{latest}; likely a source/pre-release build, so no downgrade is suggested.',
      updateFailed: 'Update check failed: {error}',
      updateNoDiagnostic: 'Update check returned no diagnostic details',
      updateInvalidResponse: 'Update check returned an invalid response',
      updateInstallHint: 'The running DSH CLI was identified safely, so Vision Router can update itself through that exact DSH installation. Restart DSH afterward to load the new version.',
      updateAutoUnavailable: 'The current DSH CLI could not be identified safely, so automatic update is disabled. Use the same DSH/plugin installation method you originally used.',
      updateNow: 'Update to v{latest}',
      updateRunning: 'Updating…',
      updateConfirm: 'Vision Router will be updated through the currently running DSH installation. Restart DSH afterward. Continue?',
      updateSuccess: 'Update command completed (target v{latest}). Restart DSH to load the new version.',
      updateError: 'Update failed: {error}',
      packageName: 'Package',
      installedVersion: 'Installed version',
      diagnosticNote: 'Source installs and pre-release builds may report a version newer than npm registry.',
      copyDiagnostics: 'Copy diagnostics',
      copiedDiagnostics: 'Copied',
      copyDiagnosticsFailed: 'Copy failed',
      compatibilityTitle: 'Compatibility',
      localVisionTitle: 'Local vision',
      remoteSettingsTitle: 'Remote settings',
      remoteSettingsDesc: 'Allow trusted DSH pages to read and update reviewed safe Vision Router preferences. Network, proxy, file-path, local-backend, and credential-related settings remain local-only.',
      allowRemoteSettingsLabel: 'Allow remote safe-setting changes',
      allowRemoteSettingsHint: 'When off, remote pages only see “not authorized”. When on, they may edit only preferences explicitly listed in the safe allow-list.',
      settingsModeRemote: 'Remote settings mode',
      settingsModeLocal: 'Local settings mode',
      settingsRemoteDisabled: 'Remote settings are not authorized. Enable “Allow remote safe-setting changes” on the device running DSH.',
      settingsRemoteReadonly: 'Remote settings are currently read-only.',
      settingsRemoteUnavailable: 'Remote settings connection is unavailable.',
      settingsRemoteRetry: 'Retry',
      settingsRemoteBadge: 'Remote',
      settingsLocalBadge: 'Local',
      providersLabel: 'Vision model chain',
      routingLabel: 'Enable vision routing',
      reverseRoutingLabel: 'Reverse routing',
      toolLabel: 'Enable vision tools',
      structuredVisionBootstrapLabel: 'Structured pre-scan (1+x)',
      structuredVisionBootstrapHint: 'Run one structured pre-scan first, then let the model decide whether to use more vision tools. The bootstrap pass does not count toward the deep-dive quota.',
      selectVisionDepth: 'Vision depth',
      visionDepthFast: 'Quick (at most 1 more look)',
      visionDepthStandard: 'Standard (1-2 looks, default)',
      visionDepthDeep: 'Thorough (2-4 looks)',
      visionDepthCustom: 'Custom (set your own cap)',
      hintVisionDepth: 'How thoroughly to look after the structured pre-scan: Quick is cheapest (at most 1 more look), Standard is the default (1-2 looks), Thorough looks the closest (2-4 looks). The tier only caps how many extra looks are allowed; what the model looks for is driven by your question.',
      labelVisionDepthMaxCalls: 'Custom deep-dive call cap',
      hintVisionDepthMaxCalls: 'Pick "Custom" first, then enter a cap (1-100). Empty or 0 = no cap. The bootstrap pre-scan does not count, and failed calls do not consume the quota; switching back to Quick/Standard/Thorough keeps the saved value but makes it inactive.',
      guidanceOverridesLabel: 'Vision guidance overrides',
      guidanceOverridesHint: 'Override the default deep-dive guidance by visual kind. Leave empty to use built-in guidance.',
      guidanceOverrideKind: 'Kind',
      guidanceOverrideText: 'Guidance text',
      guidanceOverrideAdd: '+ Add guidance',
      guidanceOverrideRemove: 'Remove',
      guidanceOverrideKindPlaceholder: 'e.g. document / ui / code',
      guidanceOverrideTextPlaceholder: 'Guidance for this visual kind…',
      progressiveToolsLabel: 'Progressive vision tools',
      progressiveToolsHint: 'Expose vision tools on demand to reduce tool-schema churn in long conversations. Off by default for compatibility.',
      autoActivateOnImageLabel: 'Auto-activate on image',
      autoActivateOnImageHint: 'Automatically activate vision tools when an image arrives.',
      extraVisionModelsLabelShort: 'Extra vision models',
      rewriteImagesLabel: 'Rewrite image messages',
      downscaleLabel: 'Auto-downscale large images',
      cacheLabel: 'Vision cache',
      freeFallbackLabel: 'Free fallback',
      freeCloudFirstLabel: 'Prefer free cloud models',
      autoWrapProvidersLabel: 'Auto-wrap chat providers',
      wrappedProvidersLabel: 'Providers to wrap',
      timeoutMsLabel: 'Per-call vision timeout (ms)',
      visionTaskTimeoutMsLabel: 'Per-task vision timeout (ms)',
      ocrTimeoutMsLabel: 'OCR timeout (ms)',
      downscaleMaxPixelsLabel: 'Max pixels',
      cacheTtlSecondsLabel: 'Cache TTL (seconds)',
      cacheMaxEntriesLabel: 'Max cache entries',
      legacyMovedTitle: 'Vision Router settings moved',
      legacyMovedBody: 'The main settings entry is now Settings → Vision Router. This legacy entry remains for compatibility and does not maintain a second editable form.',
      legacyOpen: 'Open Vision Router settings',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      reload: 'Reload',
      unknownError: 'Unknown error',
    }

    function browserLocale() {
      const lang = String(document.documentElement.lang || navigator.language || '').toLowerCase()
      return lang.startsWith('zh') ? 'zh' : 'en'
    }
    const strings = browserLocale() === 'zh' ? zh : en
    function t(key, params) {
      let text = strings[key] ?? zh[key] ?? key
      if (params && typeof params === 'object') {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }

    const PERFORMANCE_TOGGLE_KEYS = ['downscale', 'cache']
    const COMPATIBILITY_TOGGLE_KEYS = ['rewriteImages', 'autoWrapProviders']
    const COST_TOGGLE_KEYS = ['freeFallback', 'freeCloudFirst']
    const DEVELOPER_TOGGLE_KEYS = ['stealth']
    const LOCAL_TOGGLE_KEYS = ['instantDescribe']
    const PRIVACY_TOGGLE_KEYS = ['desktopScreenshot']
    const TOGGLE_KEYS = ['routing', 'reverseRouting', 'tool', 'structuredVisionBootstrap', 'progressiveTools', 'autoActivateOnImage']
    const ADVANCED_TOGGLE_KEYS = [...PERFORMANCE_TOGGLE_KEYS, ...COMPATIBILITY_TOGGLE_KEYS, ...COST_TOGGLE_KEYS, ...DEVELOPER_TOGGLE_KEYS]
    const ALL_TOGGLE_KEYS = [...TOGGLE_KEYS, ...ADVANCED_TOGGLE_KEYS, ...LOCAL_TOGGLE_KEYS, ...PRIVACY_TOGGLE_KEYS]
    const NUMBER_KEYS = ['timeoutMs', 'visionTaskTimeoutMs', 'ocrTimeoutMs', 'downscaleMaxPixels', 'cacheTtlSeconds', 'cacheMaxEntries']
    // 识图深度组的数字字段（跟随结构化预识别开关显示在主设置区，不进高级设置）。
    const DEPTH_NUMBER_KEYS = ['visionDepthMaxCalls']
    const NUMBER_META = {
      timeoutMs: { min: 1000 },
      visionTaskTimeoutMs: { min: 1000 },
      ocrTimeoutMs: { min: 1000 },
      downscaleMaxPixels: { min: 1000 },
      cacheTtlSeconds: { min: 0 },
      cacheMaxEntries: { min: 1 },
      visionDepthMaxCalls: { min: 0, max: 100 },
    }
    const TEXT_KEYS = ['wrapperRoute', 'chainRoute']
    const SELECT_KEYS = ['visionDepth']
    const LABEL_KEY = {
      instantDescribe: 'toggleInstantDescribe',
      desktopScreenshot: 'desktopScreenshotLabel',
      routing: 'routingLabel',
      reverseRouting: 'reverseRoutingLabel',
      tool: 'toolLabel',
      structuredVisionBootstrap: 'structuredVisionBootstrapLabel',
      progressiveTools: 'progressiveToolsLabel',
      autoActivateOnImage: 'autoActivateOnImageLabel',
      rewriteImages: 'rewriteImagesLabel',
      downscale: 'downscaleLabel',
      cache: 'cacheLabel',
      freeFallback: 'freeFallbackLabel',
      freeCloudFirst: 'freeCloudFirstLabel',
      autoWrapProviders: 'autoWrapProvidersLabel',
      stealth: 'stealthLabel',
      timeoutMs: 'timeoutMsLabel',
      visionTaskTimeoutMs: 'visionTaskTimeoutMsLabel',
      ocrTimeoutMs: 'ocrTimeoutMsLabel',
      downscaleMaxPixels: 'downscaleMaxPixelsLabel',
      cacheTtlSeconds: 'cacheTtlSecondsLabel',
      cacheMaxEntries: 'cacheMaxEntriesLabel',
      wrapperRoute: 'wrapperRouteLabel',
      chainRoute: 'chainRouteLabel',
      visionDepth: 'selectVisionDepth',
      visionDepthMaxCalls: 'labelVisionDepthMaxCalls',
      guidanceOverrides: 'guidanceOverridesLabel',
      extraVisionModels: 'extraVisionModelsLabel',
      allowRemoteSettings: 'allowRemoteSettingsLabel',
    }
    const HINT_KEY = {
      instantDescribe: 'hintInstantDescribe',
      desktopScreenshot: 'desktopScreenshotHint',
      routing: 'routingHint',
      reverseRouting: 'reverseRoutingHint',
      tool: 'toolHint',
      structuredVisionBootstrap: 'structuredVisionBootstrapHint',
      progressiveTools: 'progressiveToolsHint',
      autoActivateOnImage: 'autoActivateOnImageHint',
      rewriteImages: 'rewriteImagesHint',
      downscale: 'downscaleHint',
      cache: 'cacheHint',
      freeFallback: 'freeFallbackHint',
      freeCloudFirst: 'freeCloudFirstHint',
      autoWrapProviders: 'autoWrapProvidersHint',
      stealth: 'stealthHint',
      timeoutMs: 'numHintTimeoutMs',
      visionTaskTimeoutMs: 'numHintVisionTaskTimeoutMs',
      ocrTimeoutMs: 'numHintOcrTimeoutMs',
      downscaleMaxPixels: 'numHintDownscaleMaxPixels',
      cacheTtlSeconds: 'numHintCacheTtlSeconds',
      cacheMaxEntries: 'numHintCacheMaxEntries',
      wrapperRoute: 'textHintWrapperRoute',
      chainRoute: 'textHintChainRoute',
      visionDepth: 'hintVisionDepth',
      visionDepthMaxCalls: 'hintVisionDepthMaxCalls',
      guidanceOverrides: 'guidanceOverridesHint',
      extraVisionModels: 'extraVisionModelsHint',
      allowRemoteSettings: 'allowRemoteSettingsHint',
    }

    function formatProviders(value) {
      if (!Array.isArray(value)) return ''
      return value.map((entry) => {
        if (!entry || typeof entry !== 'object') return ''
        const provider = typeof entry.provider === 'string' ? entry.provider : ''
        const model = typeof entry.model === 'string' ? entry.model : ''
        return provider && model ? `${provider}/${model}` : ''
      }).filter(Boolean).join('\n')
    }
    function parseProviderLine(line) {
      const idx = String(line).indexOf('/')
      if (idx <= 0) return undefined
      const provider = String(line).slice(0, idx).trim()
      const model = String(line).slice(idx + 1).trim()
      if (provider === '' || model === '') return undefined
      return { provider, model }
    }
    function parseNumber(text, min, max) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return { clear: true }
      const parsed = Number(trimmed)
      return Number.isInteger(parsed) && parsed >= min && (max === undefined || parsed <= max)
        ? { value: parsed }
        : undefined
    }

    function VisionRouterCard({ legacy = false }) {
      const settings = useSettings(NS)
      const descriptor = settings && settings.descriptor
      const [draft, setDraft] = useState(Object.create(null))
      const [errors, setErrors] = useState(Object.create(null))
      const [saving, setSaving] = useState(false)
      const [saveStatus, setSaveStatus] = useState('')
      const [advancedOpen, setAdvancedOpen] = useState(false)
      const [localOpen, setLocalOpen] = useState(false)
      const [catalog, setCatalog] = useState(null)
      const [catalogError, setCatalogError] = useState('')
      const [catalogLoading, setCatalogLoading] = useState(false)
      const [visionCaps, setVisionCaps] = useState(null)
      const [visionCapsError, setVisionCapsError] = useState('')
      const [visionCapsLoading, setVisionCapsLoading] = useState(false)
      const [updateState, setUpdateState] = useState({ status: 'idle' })
      const [connectionState, setConnectionState] = useState({ status: 'idle' })
      const [diagnosticCopied, setDiagnosticCopied] = useState(false)
      const [showOnboarding, setShowOnboarding] = useState(false)
      const [remoteState, setRemoteState] = useState({ status: 'idle' })
      const remoteMode = !!(settings && settings.remote)
      const value = descriptor && descriptor.value && typeof descriptor.value === 'object' ? descriptor.value : {}
      const base = descriptor && descriptor.base && typeof descriptor.base === 'object' ? descriptor.base : {}
      const writable = !!(settings && settings.writable)
      const revision = descriptor && Number.isInteger(descriptor.revision) ? descriptor.revision : 0

      useEffect(() => {
        if (!descriptor) return
        setDraft(Object.create(null))
        setErrors(Object.create(null))
      }, [revision])

      function currentValue(key) {
        return Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : value[key]
      }
      function format(key) {
        const current = currentValue(key)
        if (key === 'providers') return formatProviders(current)
        if (NUMBER_KEYS.includes(key) || DEPTH_NUMBER_KEYS.includes(key)) return typeof current === 'number' ? String(current) : ''
        if (ALL_TOGGLE_KEYS.includes(key) || key === 'allowRemoteSettings') return current === true
        if (key === 'guidanceOverrides') return Array.isArray(current) ? current : []
        if (key === 'extraVisionModels' || key === 'wrappedProviders') return Array.isArray(current) ? current : []
        if (SELECT_KEYS.includes(key)) {
          return current === 'fast' || current === 'standard' || current === 'deep' || current === 'custom' ? current : 'standard'
        }
        return typeof current === 'string' ? current : ''
      }
      function parse(key, text) {
        if (key === 'providers') {
          const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
          const parsed = lines.map(parseProviderLine)
          if (parsed.some((entry) => entry === undefined)) return undefined
          return { value: parsed.map((entry) => ({ ...entry, fallbacks: [] })) }
        }
        if (NUMBER_KEYS.includes(key) || DEPTH_NUMBER_KEYS.includes(key)) {
          const meta = NUMBER_META[key] || { min: 0 }
          return parseNumber(text, meta.min, meta.max)
        }
        if (ALL_TOGGLE_KEYS.includes(key) || key === 'allowRemoteSettings') return { value: text === true }
        if (key === 'guidanceOverrides') return { value: Array.isArray(text) ? text : [] }
        if (key === 'extraVisionModels' || key === 'wrappedProviders') return { value: Array.isArray(text) ? text : [] }
        if (SELECT_KEYS.includes(key)) {
          return text === 'fast' || text === 'standard' || text === 'deep' || text === 'custom' ? { value: text } : undefined
        }
        return { value: String(text ?? '') }
      }
      function updateDraft(key, raw) {
        const parsed = parse(key, raw)
        if (parsed === undefined) {
          setErrors((previous) => ({ ...previous, [key]: true }))
          return
        }
        setErrors((previous) => {
          const next = { ...previous }
          delete next[key]
          return next
        })
        setDraft((previous) => ({ ...previous, [key]: parsed.clear ? undefined : parsed.value }))
      }

      const dirtyKeys = useMemo(() => Object.keys(draft), [draft])
      const dirty = dirtyKeys.length > 0

      async function save() {
        if (!writable || saving || dirtyKeys.length === 0) return
        setSaving(true)
        setSaveStatus('')
        try {
          const ops = dirtyKeys.map((key) => draft[key] === undefined
            ? { op: 'unset', path: [key] }
            : { op: 'set', path: [key], value: draft[key] })
          await settings.mutate(ops, revision)
          setDraft(Object.create(null))
          setSaveStatus(t('saved'))
        } catch (error) {
          setSaveStatus(t('saveFailed'))
        } finally {
          setSaving(false)
        }
      }

      function fieldShell(label, hint, body, error, key) {
        const overridden = descriptor && descriptor.user && Object.prototype.hasOwnProperty.call(descriptor.user, key)
        return React.createElement('div', { style: { marginBottom: 14 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 13 } }, label),
            overridden ? React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, t('overridden')) : null,
          ),
          body,
          hint ? React.createElement('div', { style: { fontSize: 12, opacity: 0.65, marginTop: 5, lineHeight: 1.45 } }, hint) : null,
          error ? React.createElement('div', { style: { fontSize: 12, color: '#d33', marginTop: 4 } }, t('invalidGeneric')) : null,
        )
      }
      function textField(key, label, hint, multiline = false) {
        const props = {
          value: format(key),
          disabled: !writable,
          onChange: (event) => updateDraft(key, event.target.value),
          style: {
            width: '100%', boxSizing: 'border-box', border: '1px solid rgba(127,127,127,.28)',
            borderRadius: 8, padding: '8px 10px', font: 'inherit', background: 'transparent', color: 'inherit',
          },
        }
        const body = multiline
          ? React.createElement('textarea', { ...props, rows: 4 })
          : React.createElement('input', { ...props, type: 'text' })
        return fieldShell(label, hint, body, errors[key], key)
      }
      function toggleField(key, label, hint) {
        const body = React.createElement('label', { style: { display: 'flex', gap: 9, alignItems: 'center', cursor: writable ? 'pointer' : 'default' } },
          React.createElement('input', {
            type: 'checkbox', checked: format(key), disabled: !writable,
            onChange: (event) => updateDraft(key, event.target.checked),
          }),
          React.createElement('span', null, format(key) ? t('localVisionOn') : t('localVisionOff')),
        )
        return fieldShell(label, hint, body, errors[key], key)
      }
      function selectField(key, label, hint, options) {
        const body = React.createElement('select', {
          value: format(key), disabled: !writable,
          onChange: (event) => updateDraft(key, event.target.value),
          style: {
            width: '100%', boxSizing: 'border-box', border: '1px solid rgba(127,127,127,.28)', borderRadius: 8,
            padding: '8px 10px', background: 'transparent', color: 'inherit', font: 'inherit',
          },
        }, options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)))
        return fieldShell(label, hint, body, errors[key], key)
      }

      function guidanceOverridesEditor() {
        const rows = format('guidanceOverrides')
        return fieldShell(
          t('guidanceOverridesLabel'), t('guidanceOverridesHint'),
          React.createElement('div', null,
            rows.map((row, index) => React.createElement('div', { key: index, style: { display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 8, marginBottom: 8 } },
              React.createElement('input', {
                type: 'text', value: row && typeof row.kind === 'string' ? row.kind : '', disabled: !writable,
                placeholder: t('guidanceOverrideKindPlaceholder'),
                onChange: (event) => {
                  const next = rows.map((item, i) => i === index ? { ...(item || {}), kind: event.target.value } : item)
                  updateDraft('guidanceOverrides', next)
                },
                style: { border: '1px solid rgba(127,127,127,.28)', borderRadius: 8, padding: '8px 10px', background: 'transparent', color: 'inherit' },
              }),
              React.createElement('input', {
                type: 'text', value: row && typeof row.text === 'string' ? row.text : '', disabled: !writable,
                placeholder: t('guidanceOverrideTextPlaceholder'),
                onChange: (event) => {
                  const next = rows.map((item, i) => i === index ? { ...(item || {}), text: event.target.value } : item)
                  updateDraft('guidanceOverrides', next)
                },
                style: { border: '1px solid rgba(127,127,127,.28)', borderRadius: 8, padding: '8px 10px', background: 'transparent', color: 'inherit' },
              }),
              React.createElement('button', {
                type: 'button', disabled: !writable,
                onClick: () => updateDraft('guidanceOverrides', rows.filter((_, i) => i !== index)),
              }, t('remove')),
            )),
            React.createElement('button', {
              type: 'button', disabled: !writable,
              onClick: () => updateDraft('guidanceOverrides', [...rows, { kind: '', text: '' }]),
            }, t('guidanceOverrideAdd')),
          ), false, 'guidanceOverrides',
        )
      }

      function localBackendCard(title, enabledKey, baseURLKey, modelKey, temperatureKey, topPKey, formatKey, hint) {
        return React.createElement('div', { style: { border: '1px solid rgba(127,127,127,.2)', borderRadius: 10, padding: 12, marginBottom: 10 } },
          toggleField(enabledKey, title, hint),
          textField(baseURLKey, t(baseURLKey === 'localOllama.baseURL' ? 'localOllamaBaseURL' : 'localLmStudioBaseURL'), '', false),
          textField(modelKey, t(modelKey === 'localOllama.model' ? 'localOllamaModel' : 'localLmStudioModel'), '', false),
        )
      }

      if (!descriptor) {
        return React.createElement('div', { style: { padding: 18, opacity: 0.7 } }, remoteMode ? t('settingsRemoteUnavailable') : t('catalogLoading'))
      }

      if (legacy) {
        return React.createElement('div', { style: { padding: 12 } },
          React.createElement('div', { style: { fontWeight: 700, marginBottom: 6 } }, t('legacyMovedTitle')),
          React.createElement('div', { style: { fontSize: 13, opacity: 0.72, marginBottom: 10 } }, t('legacyMovedBody')),
          React.createElement('button', {
            type: 'button',
            onClick: () => {
              try {
                if (window.__visionRouterOpenSettings) window.__visionRouterOpenSettings()
              } catch {}
            },
          }, t('legacyOpen')),
        )
      }

      return React.createElement('div', { style: { padding: 18, maxWidth: 980 } },
        React.createElement('div', { style: { marginBottom: 18 } },
          React.createElement('div', { style: { fontWeight: 750, fontSize: 20, marginBottom: 4 } }, t('nav')),
          React.createElement('div', { style: { opacity: 0.7, lineHeight: 1.5 } }, t('desc')),
        ),
        remoteMode ? React.createElement('div', { style: { border: '1px solid rgba(127,127,127,.25)', borderRadius: 10, padding: 12, marginBottom: 16 } },
          React.createElement('strong', null, t('settingsModeRemote')), ' · ', t('remoteSettingsDesc')) : null,
        React.createElement('div', { style: { border: '1px solid rgba(127,127,127,.18)', borderRadius: 12, padding: 14, marginBottom: 14 } },
          React.createElement('div', { style: { fontWeight: 700, marginBottom: 8 } }, t('chainLabel')),
          React.createElement('div', { style: { opacity: 0.68, fontSize: 12, marginBottom: 10 } }, t('chainHint')),
          textField('providers', t('providersLabel'), t('chainHint'), true),
        ),
        React.createElement('div', { style: { border: '1px solid rgba(127,127,127,.18)', borderRadius: 12, padding: 14, marginBottom: 14 } },
          toggleField('structuredVisionBootstrap', t('structuredVisionBootstrapLabel'), t('structuredVisionBootstrapHint')),
          format('structuredVisionBootstrap')
            ? React.createElement(React.Fragment, null,
                SELECT_KEYS.map((key) => selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), [
                  { value: 'fast', label: t('visionDepthFast') },
                  { value: 'standard', label: t('visionDepthStandard') },
                  { value: 'deep', label: t('visionDepthDeep') },
                  { value: 'custom', label: t('visionDepthCustom') },
                ])),
                format('visionDepth') === 'custom'
                  ? DEPTH_NUMBER_KEYS.map((key) => textField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), false))
                  : null,
                guidanceOverridesEditor(),
              )
            : null,
        ),
        React.createElement('div', { style: { border: '1px solid rgba(127,127,127,.18)', borderRadius: 12, padding: 14, marginBottom: 14 } },
          toggleField('routing', t('routingLabel'), ''),
          toggleField('tool', t('toolLabel'), ''),
          toggleField('progressiveTools', t('progressiveToolsLabel'), t('progressiveToolsHint')),
          toggleField('autoActivateOnImage', t('autoActivateOnImageLabel'), t('autoActivateOnImageHint')),
        ),
        React.createElement('div', { style: { marginTop: 18, display: 'flex', gap: 8, alignItems: 'center' } },
          React.createElement('button', { type: 'button', disabled: !writable || !dirty || saving || Object.keys(errors).length > 0, onClick: save }, saving ? t('saving') : t('save')),
          React.createElement('button', { type: 'button', disabled: !dirty || saving, onClick: () => { setDraft(Object.create(null)); setErrors(Object.create(null)); setSaveStatus('') } }, t('discard')),
          saveStatus ? React.createElement('span', { style: { fontSize: 12, opacity: 0.72 } }, saveStatus) : null,
        ),
      )
    }

    function apply(ctx) {
      const openCanonical = () => {
        try {
          if (ctx && ctx.settings && typeof ctx.settings.open === 'function') return ctx.settings.open('vision-router')
        } catch {}
        try {
          const event = new CustomEvent('dsh:settings:open', { detail: { section: 'vision-router' } })
          window.dispatchEvent(event)
        } catch {}
      }
      window.__visionRouterOpenSettings = openCanonical

      const canonical = () => React.createElement(VisionRouterCard, { legacy: false })
      const legacy = () => React.createElement(VisionRouterCard, { legacy: true })

      // One form implementation, two presentation surfaces. The legacy plugin
      // card intentionally only opens the canonical first-class settings page;
      // it never owns a second draft or settings namespace.
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.slots.inject('settings.section', {
            id: 'vision-router',
            title: strings.nav,
            render: canonical,
          })
          ctx.slots.inject('settings.plugin.item', {
            id: 'vision-router',
            title: strings.nav,
            render: legacy,
          })
        }
      } catch {}
    }

    module.exports.apply = apply
    module.exports.inject = ['@deepseek-ai/dsh-client-ui-settings']
    return module.exports
  },
})

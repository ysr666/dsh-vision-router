// dsh-vision-router browser half: one first-class Settings > Vision Router page
// backed by the host-owned `vision-router` settings namespace. Self-contained
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
      nav: 'Vision Router · 图片识别',
      settingsNav: 'Vision Router',
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
      guidePromptNavBody: '在设置面板左侧点击被高亮的「Vision Router」入口（或点「下一步」自动进入）。我会直接定位到「识图模型」。',
      guidePromptCancel: '结束引导',
      guideChainTitle: '第 3 步 · 设置备用模型',
      guideChainBody: '这里的识图模型会从上到下依次尝试。可以添加多个备用模型，也可以全部留空；内置 OVH 免费模型会在最后自动兜底。选好后点击页面底部「保存」。',
      guideDone: '完成引导',
      pending: '未保存',
      readOnly: '当前设置提供方只读。',
      remoteSettingsDisabledTitle: '远程设置未启用',
      remoteSettingsDisabledBody: '出于安全考虑，远程修改默认关闭。请先在运行 DSH 的机器上通过回环地址打开「设置 → Vision Router → 高级设置 → 网络」，启用「允许可信 Host 远程修改设置」。',
      remoteSettingsUnavailableTitle: '远程设置通道不可用',
      remoteSettingsUnavailableBody: '无法连接 Vision Router 的远程设置通道。请确认插件已更新，并且当前远程地址已按 DSH 的方式配置为 trusted host。',
      remoteSettingsRetry: '重试',
      remoteSettingsInitializingTitle: '远程设置正在初始化',
      remoteSettingsInitializingBody: 'Vision Router 设置命名空间尚未就绪，页面会自动重试。',
      remoteSettingsProxyBody: '远程设置路由返回 404。若使用 Nginx/Caddy/其他反向代理，请同时转发 /vision-router-settings/* 到 DSH。',
      remoteSafeScopeHint: '远程页面只允许修改低风险偏好；网络、凭据、本地后端、产物目录、桌面截图和宿主路由等设置只能在 DSH 本机修改。',
      settingsConflict: '设置已被另一端修改。已刷新最新配置，请确认你的修改后重新保存。',
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
      localDescribeStyleStructured: '结构化（【初步判断】格式）',
      hintLocalDescribeStyle: '仅影响本地识别（即时识图 / 截图识图）的输出格式；结构化对截图分析（GUI / 文档 / 聊天记录）质量更高。',
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
      chainLabel: '识图模型',
      chainHint: '选择 Vision Router 用来读取图片的模型。将按从上到下的顺序尝试，失败时自动切换到下一个。',
      addFallback: '+ 添加备用识图模型',
      remove: '移除',
      removeTitle: '移除这一行',
      textModelLabel: '文字回退模型',
      textModelHint: '通常无需设置；留空即使用默认聊天模型。',
      defaultChainNote:
        '这里设置负责看图的模型，不会改变聊天页选择的聊天模型。你的模型按顺序尝试；内置 OVH 免费模型固定作为最后兜底。',
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
      textModelGroupHint:
        '通常无需设置。仅在开启「整轮交给视觉模型」且需要把纯文字消息切回聊天模型时使用。',
      groupBehavior: '识图行为',
      groupParams: '性能与超时',
      groupVisionOverrides: '视觉能力覆盖',
      extraVisionModelsLabel: '额外视觉模型标记',
      extraVisionModelsHint:
        '这个设置不再用于“解锁”下拉或允许调用；所有可调用生成式模型本来就能被选择。' +
        '只有当你希望把某个未声明图片能力的模型明确标记为视觉模型时才需要填写。' +
        '实际调用仍优先走 DSH adapter；只有明确的 http(s) OpenAI Chat Completions 渠道才可能使用直连兼容兜底。',
      groupRoutes: '路由名称',
      groupProxy: '网络',
      proxyLabel: '代理地址',
      proxyHint: '如 http://127.0.0.1:10808 或 socks5h://127.0.0.1:10808；留空关闭。修改即时生效。',
      allowRemoteSettingsLabel: '允许可信 Host 远程修改设置',
      allowRemoteSettingsHint: '默认关闭。仅在你信任能访问该 DSH 实例的客户端时开启；trustedHosts 不是身份认证。远程端仅能修改明确列入白名单的低风险偏好，网络、凭据、本地后端、产物目录、桌面截图和宿主路由始终只能在本机修改。',
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
      updateSuccessVerified: '更新命令已完成（目标 v{latest}，已确认安装 v{installed}）。请重启 DSH；重启后新版本才会生效。',
      updateActionFailed: '一键更新失败：{error}',
      updateReleaseNotes: '查看更新说明',
      updateRegistryFallback: '当前配置的 registry 不可用，已自动改用 npm 官方源完成检查。',
      updateReleaseFallback: 'npm registry 检查失败，已通过 GitHub Releases 获取最新版本号；安装仍需 npm registry 可访问。',
      updateManualUnknownTarget: '无法确认最新版本，因此不会生成 @latest 或普通 update 命令。请先打开 Releases 确认最新版本号，再把下方 <version> 替换为该版本。',
      updateManualTitle: '手动更新',
      updateManualSource: '源码仓库 / pnpm DSH：',
      updateManualNpx: '普通 npm / npx DSH：',
      updateManualAgeHint: '上方只会使用已确认的具体版本号；若无法确认版本，则只提供 <version> 模板。pnpm 11 默认会在新版本发布 24 小时内静默拦截 @latest / 普通 update（minimumReleaseAge 策略，但命令仍可能显示成功），所以这里不再推荐这两种模糊更新方式。',
      updateProject: '项目主页',
      updateReleases: 'Releases',
      save: '保存',
      saving: '保存中…',
      renderFailed: '设置卡渲染失败：',
      toggleRouting: '整轮交给视觉模型',
      toggleReverseRouting: '纯文字消息仍使用聊天模型',
      toggleTool: '识图工具',
      toggleStructuredVisionBootstrap: '结构化预识别（1+x，实验）',
      toggleAutoWrapProviders: '自动创建「+ 自动识图」模型组',
      toggleRewriteImages: '保护纯文字模型',
      toggleDownscale: '图片自动压缩',
      toggleCache: '识图答案缓存',
      toggleFreeFallback: '内置免费兜底',
      toggleFreeCloudFirst: '云端免费优先',
      toggleDesktopScreenshot: '桌面截图识图',
      toggleStealth: '隐身模式',
      hintRouting:
        '默认关闭。开启后，发送图片的整轮对话会直接由视觉模型处理，而不是由当前聊天模型调用识图工具。' +
        '用于兼容旧版行为，一般无需开启；开启后只使用上方识图模型链中的后端。',
      hintReverseRouting: '仅在「整轮交给视觉模型」开启时生效；纯文字消息继续交给聊天模型处理。',
      hintTool: '允许聊天模型按需查看、定位、裁剪和比较图片。推荐保持开启。',
      hintStructuredVisionBootstrap: '默认关闭。开启后，每个图片任务会先做一次不读取具体任务目标的结构化预识别，再由聊天模型根据原问题至少追加一次验证或深挖识图调用（1+x，x≥1）。启用的 Ollama / LM Studio 会和其他视觉后端一样参与这条识图链，不需要另开「即时识图」。准确性更高，但会增加至少一次视觉调用；若后续需要 OCR，自动模式会优先使用视觉模型。需保持「识图工具」开启。',
      hintAutoWrapProviders: '自动为已启用的聊天模型创建带「+ 自动识图」的版本。原模型不受影响，推荐保持开启。',
      hintRewriteImages: '避免把无法读取的原始图片直接发送给纯文字模型。推荐保持开启。',
      hintDownscale: '超过像素预算的图片先缩放再送视觉模型，降低延迟与成本；默认开启。',
      hintCache: '缓存识图答案（按图片内容 + 问题）；默认开启。',
      hintFreeFallback: '当你选择的识图模型都不可用时，自动尝试内置 OVH 免费模型。免注册、免 API Key。',
      hintFreeCloudFirst:
        '默认关闭。开启后，云端后端先尝试内置 OVH 免费模型（免注册、免 API Key），' +
        '你配置的付费端点仅在免费模型全部失败后作为兜底，尽量把云端识别成本降到零。' +
        '本地后端不受影响，仍在最前。关闭时保持既有顺序（付费在前、免费补全在后）。',
      hintDesktopScreenshot: '允许模型按需截取桌面屏幕用于识图。默认关闭；开启后才提供 vision_screenshot 工具。macOS 在保存开启时会立即触发一次屏幕录制授权检查；如果已经授权，系统不会重复弹窗。',
      hintStealth:
        '只作用于官方 DeepSeek 路由：接管后模型选择器保持原样。需在 profile 补丁层 ' +
        '（cordis.patch.yml）禁用官方 llm-deepseek 行后才真正接管；官方行还在时 ' +
        '插件自动回退为选择器里的「自动识图」包装路由。opencode 等自定义路由与隐身模式无关，' +
        '它们默认由「自动创建 + 自动识图模型组」处理；只有要限制范围时才用下方手动包装。改动后需重启 dsh 生效。',
      stealthOfficialDeadHint:
        '提示：检测到官方 DeepSeek 行当前被禁用（profile 补丁层），所以即使关闭隐身模式，' +
        '本插件仍会接管 deepseek-official 路由，否则 DeepSeek 模型会从选择器消失。' +
        '如需完全恢复官方原生行，请先把 cordis.patch.yml 里 llm-deepseek 的 disabled 改回 false 再重启。',
      numTimeoutMs: '单次识图请求超时（毫秒）',
      numVisionTaskTimeoutMs: '识图任务最长时间（毫秒）',
      numOcrTimeoutMs: 'OCR 最长时间（毫秒）',
      numDownscaleMaxPixels: '图片像素上限',
      numCacheTtlSeconds: '缓存有效期（秒）',
      numCacheMaxEntries: '最大缓存数量',
      selectVisionDepth: '看图深度',
      groupDeepDive: '识图深度（可选）',
      guidanceOverridesLabel: '自定义识图引导（可选）',
      guidanceOverridesHint: '一般不需要设置。识图时默认按图片类型自动使用内置引导；你可以为某个图片类型（如文档、界面、人物）写一句自己的引导语，让视觉模型按你的要求细看。例如选「document（文档）」，填「重点关注合同条款与签名」。',
      guidanceOverridePlaceholder: '输入自定义引导语（留空 = 使用内置）',
      addGuidanceOverride: '+ 添加一条自定义引导',
      selectKind: '选择图片类型…',
      visionDepthFast: '快速（优先整体判断）',
      visionDepthStandard: '标准（按需查证，默认）',
      visionDepthDeep: '细致（主动交叉验证）',
      hintVisionDepth: '看图深度只决定识图策略，不限制调用次数：快速优先整体判断，标准按问题需要查证，细致会主动做更多局部检查与交叉验证。如需限制调用次数，请启用下方「限制深挖次数」。',
      depthCapTitle: '限制深挖次数',
      depthCapHint: '默认关闭，不限制视觉证据调用次数。启用后可设置本轮最多允许多少次成功的深挖证据调用；bootstrap 预识别不计入，失败或空证据调用不占次数。',
      depthCapValueLabel: '最多深挖次数',
      depthCapInvalid: '请输入 1–100 之间的整数。',
      numHintTimeoutMs: '单个视觉请求超时；默认 120000。',
      numHintVisionTaskTimeoutMs: '一次识图任务（含全部 provider、回退与重试）共享的总时限；默认 45000。认证失败/限流会立即熔断对应后端。',
      numHintOcrTimeoutMs: '一次 OCR 任务的总时限；本地 tesseract 最多用 12 秒，视觉模型回退只用剩余部分；默认 30000。',
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
      textProviders: '识图模型',
      textProvidersHint: '每行一个识图模型，从上到下依次尝试；留空则只使用内置免费兜底。',
      textTextProvider: '文字回退模型',
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
      nav: 'Vision Router · Image understanding',
      settingsNav: 'Vision Router',
      desc: 'Your chat model thinks and answers; the vision model reads images. Configure them independently.',
      quickStartTitle: 'Chat and image understanding are separate',
      quickStartBody: 'Your chat model handles reasoning and answers; the vision model reads images. When sending images, choose a model marked “+ Auto Vision” in chat.',
      quickStartLive: 'To change only image understanding, edit “Vision model” below. Your current chat model will not change.',
      quickStartGuide: 'Show beginner guide again',
      onboardingTitle: 'Vision Router is ready 🎉',
      onboardingBody: 'For first use, remember one thing: the chat model answers, and the vision model reads images. Follow these 3 steps.',
      onboardingStep1Title: '1 · Choose your chat model',
      onboardingStep1Body: 'Choose the model you normally use from the lower-right chat selector. For images, choose its “+ Auto Vision” version.',
      onboardingStep2Title: '2 · Choose the vision model',
      onboardingStep2Body: 'Open Settings → Vision Router and choose it under “Vision model”. It only reads images and does not replace your chat model.',
      onboardingStep3Title: '3 · Add fallback models',
      onboardingStep3Body: 'Add more than one vision model if you want. If one fails, Vision Router tries the next; the built-in free fallback remains available at the end.',
      onboardingGuide: 'Guide me through vision setup',
      onboardingLater: 'Later',
      onboardingClose: 'Close',
      guideStep1Title: 'Step 1 · Choose your chat model',
      guideStep1Body: 'The model selector next to the chat input in the lower-right corner is now highlighted. For image turns, pick a group marked “+ Auto Vision”; the model inside still handles chat, reasoning, and tool calls. Click “Next” when done.',
      guideStepNext: 'Next',
      guidePromptTitle: 'Step 2 · Choose the vision model',
      guidePromptGearBody: 'Click the highlighted Settings gear at the bottom-left of the sidebar, or press “Next” and I will open it for you.',
      guidePromptNavBody: 'In Settings, click the highlighted “Vision Router” entry (or press “Next”). I will take you directly to “Vision model”.',
      guidePromptCancel: 'End guide',
      guideChainTitle: 'Step 3 · Add fallback models',
      guideChainBody: 'Vision models are tried from top to bottom. You may add several fallbacks or leave them empty; the built-in OVH free model remains the final fallback. Save when done.',
      guideDone: 'Finish guide',
      pending: 'Unsaved',
      readOnly: 'The active settings provider is read-only.',
      remoteSettingsDisabledTitle: 'Remote settings are disabled',
      remoteSettingsDisabledBody: 'Remote writes are off by default. On the machine running DSH, open the loopback UI and enable “Allow trusted-host remote settings” under Settings → Vision Router → Advanced settings → Network.',
      remoteSettingsUnavailableTitle: 'Remote settings channel unavailable',
      remoteSettingsUnavailableBody: 'Vision Router could not reach its scoped remote-settings channel. Update the plugin and make sure this remote address is configured as a DSH trusted host.',
      remoteSettingsRetry: 'Retry',
      remoteSettingsInitializingTitle: 'Remote settings are initializing',
      remoteSettingsInitializingBody: 'The Vision Router settings namespace is not ready yet. This page will retry automatically.',
      remoteSettingsProxyBody: 'The remote-settings route returned 404. If DSH is behind Nginx, Caddy, or another reverse proxy, also forward /vision-router-settings/* to DSH.',
      remoteSafeScopeHint: 'Remote pages can change low-risk preferences only. Network, credentials, local backends, artifact paths, desktop capture, and host routing remain loopback-only.',
      settingsConflict: 'Settings changed on another client. The latest values were refreshed; review your draft and save again.',
      overridden: 'Overridden',
      reset: 'Reset',
      toggleInstantDescribe: 'Instant local image recognition',
      hintInstantDescribe: 'When on (and at least one local vision backend is enabled), image blocks are recognized locally on the first model step — the model understands the image immediately without calling a vision tool first. If Ollama fails, LM Studio is tried next. Multiple images are recognized concurrently (up to 3 — local inference is VRAM-bound); a failing image is skipped without affecting the rest; total failure falls back to the tool-hint marker. The session log keeps the original image.',
      groupLocalOllama: 'Local vision · Ollama / LM Studio',
      localVisionHeroHint: 'This section only configures Ollama / LM Studio backends. The automatic first visual pass is controlled solely by “Structured pre-scan (1+x)” above; no extra switch is needed.',
      localVisionOff: 'Off',
      localVisionOn: 'On',
      localVisionStylePlainShort: 'plain',
      localVisionStyleStructuredShort: 'structured',
      localVisionInstantShort: 'instant',
      localOllamaEnabled: 'Local Ollama recognition',
      localOllamaBaseURL: 'Ollama base URL (OpenAI-compatible)',
      localOllamaModel: 'Ollama model name',
      localOllamaTemperature: 'Temperature',
      localOllamaTopP: 'Top-p',
      localRequestFormat: 'Request protocol',
      localFormatOpenAI: 'OpenAI (/chat/completions)',
      localFormatAnthropic: 'Anthropic (/messages)',
      localTemperaturePlaceholder: 'Blank = server default; suggested 0.5',
      localTopPPlaceholder: 'Blank = server default; suggested 0.8',
      localLmStudioModelPlaceholder: 'Model identifier from Developer or /v1/models',
      localLmStudioModelRequired: 'Enter a real model identifier before enabling LM Studio.',
      localModelRequiredShort: 'model required',
      hintLocalOllama: 'When enabled, local-ollama heads the vision chain (private / free / offline); when Ollama is down it is skipped automatically and the chain falls through to the cloud. Off by default.',
      localLmStudioEnabled: 'Local LM Studio recognition',
      localLmStudioBaseURL: 'LM Studio base URL (OpenAI-compatible)',
      localLmStudioModel: 'LM Studio model name',
      localLmStudioTemperature: 'Temperature',
      localLmStudioTopP: 'Top-p',
      hintLocalLmStudio: 'A local backend on the same level as Ollama: LM Studio\'s compatible endpoint (default http://localhost:1234/v1). Model must be the real identifier shown in Developer or returned by /v1/models. When enabled, local-lmstudio sits after local-ollama and before the cloud chain; when LM Studio is down it is skipped automatically. Off by default.',
      localDescribeStyle: 'Local recognition output style',
      localDescribeStylePlain: 'Plain description',
      localDescribeStyleStructured: 'Structured (【初步判断】format)',
      hintLocalDescribeStyle: 'Affects only local recognition output (instant image recognition / screenshot recognition); structured is better for screenshot analysis (GUI / documents / chat logs).',
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
      chainLabel: 'Vision model',
      chainHint: 'Choose the models Vision Router uses to read images. They are tried from top to bottom, with automatic failover.',
      addFallback: '+ Add fallback vision model',
      remove: 'Remove',
      removeTitle: 'Remove this row',
      textModelLabel: 'Text fallback model',
      textModelHint: 'Usually unnecessary; leave empty to use the default chat model.',
      defaultChainNote:
        'These models read images and do not change the chat model selected in the composer. Your models are tried in order; the built-in OVH free model remains the final fallback.',
      catalogLoading: 'Loading the model catalog (same source as Settings → Models)…',
      catalogUnavailable: 'Connection service unavailable (no model catalog); falling back to free-text input.',
      catalogTimeout: 'Catalog request timed out (15s)',
      catalogEmpty: 'Model catalog is empty: ',
      catalogErrorEnvelope: 'The model catalog endpoint failed',
      catalogError: 'Model catalog unavailable (',
      catalogFallback: '); model fields fell back to free-text input.',
      catalogPartialFailure: 'Some configured providers failed to load their model catalog: {detail}. They may still appear in Settings → Models, but are temporarily unavailable here.',
      visionCapsLoading: 'Reading model image-capability metadata (advisory only; it does not hide selectable models)…',
      visionCapsError: 'Vision capability metadata is temporarily unavailable; models remain selectable and the registered DSH adapter will verify actual support when called.',
      visionCapsFiltered: 'Capability metadata is advisory, not an admission gate. Generative models with undeclared or text-only metadata remain selectable and failures automatically fall through.',
      visionCapabilityUndeclaredWarning: 'This model has no image-capability declaration, but it stays usable: Vision Router tries it on the call and falls through automatically on failure.',
      visionCapabilityTextOnlyWarning: 'This model is marked text-only, but you can still use it: image support is verified on the call and failures fall through automatically.',
      visionCapabilityUnknownWarning: 'Image capability is verified automatically on the call — no extra setup needed; failures fall through to the next model.',
      visionCapsEmptyTitle: 'No selectable user vision models',
      visionCapsEmptyBody: 'DSH reported {count} user models, but none are explicitly marked as accepting images, so Vision Router hid them safely.',
      visionCapsHiddenPrefix: 'Hidden models:',
      visionCapsReasonMissingImage: 'image input not declared',
      visionCapsReasonUnverified: 'image capability could not be verified',
      visionCapsHiddenMore: '{count} more models not shown',
      visionCapsMissingImageHint: 'If one of these is a vision model you just added through Settings → Models → Add custom provider: select it in the “Extra vision models” dropdown under Advanced to enable it directly; or follow the DSH way and add input: [text, image] to that model in $DSH_HOME/settings.yaml (or defaultInput: [text, image] to the provider). The current DSH Web form does not write this field.',
      visionCapsRetry: 'Re-detect models',
      chainInvalidCurrent: 'This saved backend is no longer callable, or is a non-generative/recursive route, so runtime will skip it: ',
      retryCatalog: 'Retry catalog',
      advanced: 'Advanced settings',
      groupPerformance: 'Performance',
      groupCompatibility: 'Compatibility',
      groupCost: 'Cost',
      groupNetwork: 'Network',
      groupDeveloper: 'Developer settings',
      groupDiagnostics: 'Version & diagnostics',
      developerHint: 'These controls are for route overrides, capability labels, and compatibility debugging. Most users can leave them alone.',
      groupTextModel: 'Text fallback model',
      textModelGroupHint:
        'Usually unnecessary. Used only when whole-turn vision routing is enabled and plain text should return to the chat model.',
      groupBehavior: 'Image behavior',
      groupParams: 'Performance & timeouts',
      groupVisionOverrides: 'Vision capability overrides',
      extraVisionModelsLabel: 'Extra vision capability labels',
      extraVisionModelsHint:
        'This setting no longer unlocks the picker or admission: every callable generative model is selectable already. ' +
        'Use it only when you want to explicitly label an undeclared model as visual. ' +
        'Runtime still tries the DSH adapter first; only a confirmed http(s) OpenAI Chat Completions channel may use the direct compatibility bridge.',
      groupRoutes: 'Route names',
      groupProxy: 'Network',
      proxyLabel: 'Proxy URL',
      proxyHint: 'e.g. http://127.0.0.1:10808 or socks5h://127.0.0.1:10808; empty disables. Applies immediately.',
      allowRemoteSettingsLabel: 'Allow trusted-host remote settings',
      allowRemoteSettingsHint: 'Off by default. Enable only when you trust clients that can reach this DSH instance; trustedHosts is not authentication. Remote clients can change only explicitly allow-listed low-risk preferences; network, credentials, local backends, artifact paths, desktop capture, and host routing remain loopback-only.',
      proxyHostsLabel: 'Proxied hosts (one per line)',
      proxyHostsHint: 'Only these hosts go through the proxy; everything else stays direct. Empty clears the override. Applies immediately.',
      saveFailed: 'Save failed: some changes were not written. Unwritten changes were kept; please retry.',
      discard: 'Discard',
      testConnection: 'Test connection',
      testConnecting: 'Testing…',
      testOk: 'Connected',
      testFailed: 'Connection failed',
      openLogFolder: 'Open logs folder',
      openLogFolderFailed: 'Could not open logs folder',
      updateTitle: 'Updates',
      checkUpdate: 'Check for updates',
      updateChecking: 'Checking…',
      updateAvailable: 'Update available: v{latest} (current v{current})',
      updateCurrent: 'Up to date: v{current}',
      updateAhead: 'Current v{current} is ahead of registry v{latest}; this may be a source or prerelease build, so no downgrade is suggested.',
      updateFailed: 'Update check failed: {error}',
      updateNoDiagnostic: 'The update-check endpoint returned no diagnostic error details',
      updateInvalidResponse: 'The update-check endpoint returned an invalid response',
      updateInstallHint: 'The current DSH CLI was verified, so Vision Router can update through this same DSH installation. Restart DSH after the update to load the new plugin bundle.',
      updateAutoUnavailable: 'The current DSH CLI could not be verified safely, so automatic update is disabled. Update through the same DSH/plugin installation path you originally used.',
      updateNow: 'Update to v{latest}',
      updateRunning: 'Updating…',
      updateConfirm: 'Vision Router will update through the DSH CLI that is currently running. You will need to restart DSH afterward. Continue?',
      updateSuccess: 'The update command completed (target v{latest}). Restart DSH to load the new version.',
      updateSuccessVerified: 'The update command completed (target v{latest}, installed v{installed} verified). Restart DSH to load the new version.',
      updateActionFailed: 'One-click update failed: {error}',
      updateReleaseNotes: 'View release notes',
      updateRegistryFallback: 'The configured registry failed; the check succeeded through the official npm registry.',
      updateReleaseFallback: 'npm registry checks failed, so the latest version was resolved from GitHub Releases; installation still requires an accessible npm registry.',
      updateManualUnknownTarget: 'The latest version could not be confirmed, so no @latest or plain update command is generated. Open Releases first, confirm the newest version, then replace <version> in the template below.',
      updateManualTitle: 'Manual update',
      updateManualSource: 'DSH source checkout / pnpm:',
      updateManualNpx: 'Normal npm / npx DSH:',
      updateManualAgeHint: 'The command above only uses a confirmed exact version; if no version can be confirmed, the UI shows a <version> template instead. pnpm 11 can silently withhold @latest / plain update for releases younger than 24h (minimumReleaseAge) even while reporting success, so those ambiguous update forms are no longer recommended here.',
      updateProject: 'Project',
      updateReleases: 'Releases',
      save: 'Save',
      saving: 'Saving…',
      renderFailed: 'Settings card failed to render: ',
      toggleRouting: 'Send the whole image turn to the vision model',
      toggleReverseRouting: 'Keep text-only messages on the chat model',
      toggleTool: 'Vision tools',
      toggleStructuredVisionBootstrap: 'Structured pre-scan (1+x, experimental)',
      toggleAutoWrapProviders: 'Auto-create “+ Auto Vision” model groups',
      toggleRewriteImages: 'Protect text-only models',
      toggleDownscale: 'Auto downscale',
      toggleCache: 'Vision answer cache',
      toggleFreeFallback: 'Built-in free fallback',
      toggleFreeCloudFirst: 'Free cloud first',
      toggleDesktopScreenshot: 'Desktop screenshot vision',
      toggleStealth: 'Stealth mode',
      hintRouting:
        'Off by default. When enabled, the entire image turn is handled directly by the vision model instead of ' +
        'the current chat model calling vision tools. This preserves legacy behavior and is usually unnecessary; ' +
        'only the vision models configured above participate.',
      hintReverseRouting: 'Only applies when whole-turn vision routing is enabled; plain text messages continue to use the chat model.',
      hintTool: 'Lets the chat model inspect, locate, crop, and compare images as needed. Recommended on.',
      hintStructuredVisionBootstrap: 'Off by default. Each image task first gets one task-independent structured visual baseline with no task goal passed into the pre-scan, then the chat model must make at least one evidence or deepening vision call for the original request (1+x, x>=1). Enabled Ollama / LM Studio backends participate in this same vision chain; there is no separate instant-recognition switch. This improves evidence quality but adds at least one visual call. If OCR is needed, auto mode prefers vision-model OCR. Keep Vision tools enabled.',
      hintAutoWrapProviders: 'Automatically creates a “+ Auto Vision” version of enabled chat models. Original model groups stay unchanged. Recommended on.',
      hintRewriteImages: 'Prevents raw image content from being sent to a text-only model that cannot read it. Recommended on.',
      hintDownscale: 'Images beyond the pixel budget are resized before the vision call, cutting latency and cost; on by default.',
      hintCache: 'Caches vision answers (keyed by image content + question); on by default.',
      hintFreeFallback: 'If your selected vision models fail, automatically try the built-in OVH free models. No signup or API key required.',
      hintFreeCloudFirst:
        'Off by default. When enabled, cloud backends try the built-in OVH free models first (no signup, no API key), ' +
        'and your paid endpoints only act as a fallback after every free model fails, keeping cloud vision at zero cost. ' +
        'Local backends are unaffected and stay first. When off, the existing order is preserved (paid first, free appended last).',
      hintDesktopScreenshot: 'Lets the model capture the desktop on demand for image understanding. Off by default; vision_screenshot is exposed only when enabled. On macOS, saving the enabled setting immediately triggers a screen-recording permission check; if permission was already granted, macOS will not prompt again.',
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
      numTimeoutMs: 'Single vision request timeout (ms)',
      numVisionTaskTimeoutMs: 'Vision task maximum time (ms)',
      numOcrTimeoutMs: 'OCR maximum time (ms)',
      numDownscaleMaxPixels: 'Image pixel limit',
      numCacheTtlSeconds: 'Cache TTL (seconds)',
      numCacheMaxEntries: 'Maximum cached answers',
      selectVisionDepth: 'Vision depth',
      groupDeepDive: 'Deep-dive guidance (optional)',
      guidanceOverridesLabel: 'Custom vision guidance (optional)',
      guidanceOverridesHint: 'Usually nothing to set here. Vision uses built-in guidance per image type by default; you can write a custom guidance line for a specific type (e.g. document, UI, person) so the vision model looks the way you want. Example: pick "document（文档）" and enter "Focus on contract clauses and signatures."',
      guidanceOverridePlaceholder: 'Enter custom guidance (empty = built-in)',
      addGuidanceOverride: '+ Add a custom guidance line',
      selectKind: 'Select image type…',
      visionDepthFast: 'Quick (overall-first)',
      visionDepthStandard: 'Standard (evidence as needed, default)',
      visionDepthDeep: 'Thorough (proactive cross-checking)',
      hintVisionDepth: 'Vision depth chooses the inspection strategy, not a call-count limit: Quick stays overall-first, Standard verifies evidence as needed, and Thorough proactively inspects details and cross-checks important claims. To cap calls, enable “Limit deep-dive calls” below.',
      depthCapTitle: 'Limit deep-dive calls',
      depthCapHint: 'Off by default, so visual evidence calls are unlimited. Enable this to cap successful deep-evidence calls for the turn. The bootstrap pre-scan does not count, and failed or empty-evidence calls do not consume the cap.',
      depthCapValueLabel: 'Maximum deep-dive calls',
      depthCapInvalid: 'Enter an integer from 1 to 100.',
      numHintTimeoutMs: 'Per vision-call deadline; default 120000.',
      numHintVisionTaskTimeoutMs: 'One vision task (all providers, fallbacks and retries) shares this wall-clock budget; default 45000. Auth failures and rate limits trip their backend immediately.',
      numHintOcrTimeoutMs: 'Total budget for one OCR task: tesseract gets at most 12s, the vision fallback only the remainder; default 30000.',
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
      textProviders: 'Vision model',
      textProvidersHint: 'One vision model per line, tried from top to bottom. Leave empty to rely on the built-in free fallback.',
      textTextProvider: 'Text fallback model',
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

    function catalogFailureDetail(failures, limit = 300) {
      if (!Array.isArray(failures) || failures.length === 0) return ''
      return failures
        .map((failure) => {
          const label =
            failure && typeof failure.name === 'string' && failure.name !== ''
              ? failure.name
              : failure && typeof failure.id === 'string'
                ? failure.id
                : ''
          const message =
            failure && typeof failure.message === 'string' && failure.message !== ''
              ? failure.message
              : 'unknown catalog error'
          return (label ? label + ': ' : '') + message
        })
        .join('; ')
        .slice(0, limit)
    }

    function catalogStateFromValue(value, t) {
      const groups = value && Array.isArray(value.groups) ? value.groups : []
      const failures = value && Array.isArray(value.failures) ? value.failures : []
      if (groups.length === 0 && failures.length > 0) {
        return {
          status: 'error',
          groups: [],
          failures,
          error: t('catalogEmpty') + catalogFailureDetail(failures),
        }
      }
      return { status: 'ready', groups, failures, error: undefined }
    }

    function subscribeCatalogInvalidations(remote, onInvalidate) {
      if (!remote || typeof remote.$on !== 'function' || typeof onInvalidate !== 'function') return () => {}
      const disposers = [
        remote.$on('llm/adapters-updated', onInvalidate),
        remote.$on('settings/document-updated', onInvalidate),
        remote.$on('credentials/updated', onInvalidate),
      ].filter((dispose) => typeof dispose === 'function')
      return () => {
        for (const dispose of disposers) dispose()
      }
    }

    function filterVisionBackendGroups(groups, capabilities) {
      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}
      return (Array.isArray(groups) ? groups : [])
        .filter((group) =>
          group &&
          typeof group.id === 'string' &&
          group.id !== 'vision-http' &&
          group.id !== 'vision-chain' &&
          !group.id.endsWith('-vision'),
        )
        .map((group) => {
          const models = (Array.isArray(group.models) ? group.models : []).filter((model) => {
            if (!model || typeof model.id !== 'string' || model.id === '') return false
            const capability = caps[group.id] && caps[group.id][model.id]
            // Missing/negative image metadata is advisory. Only a positive
            // structural rejection (non-generative endpoint, generated wrapper,
            // missing adapter) removes an entry from the picker.
            return !(capability && capability.attemptable === false)
          })
          return { ...group, models }
        })
        .filter((group) => group.models.length > 0)
    }

    // Retained for the optional capability-label override editor. These models
    // are no longer hidden from the backend chain; they merely lack a positive
    // image declaration/inference and can be explicitly relabelled by experts.
    function collectFilteredVisionBackends(groups, capabilities) {
      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}
      const uncertain = []
      for (const group of filterVisionBackendGroups(groups, caps)) {
        for (const model of Array.isArray(group.models) ? group.models : []) {
          const capability = caps[group.id] && caps[group.id][model.id]
          if (capability && capability.attemptable === false) continue
          if (capability && capability.image === true) continue
          uncertain.push({
            provider: group.id,
            model: model.id,
            reason: capability && typeof capability.reason === 'string' ? capability.reason : undefined,
            missingImageDeclaration:
              !!capability && capability.reason === 'model metadata does not declare image input',
          })
        }
      }
      return uncertain
    }

    function visionCapabilityWarningKey(capability, status) {
      if (status === 'loading' || status === 'idle') return undefined
      if (status === 'error' || !capability) return 'visionCapabilityUnknownWarning'
      if (capability.attemptable === false || capability.image === true) return undefined
      const modalities = Array.isArray(capability.inputModalities) ? capability.inputModalities : []
      return modalities.length > 0 && !modalities.includes('image')
        ? 'visionCapabilityTextOnlyWarning'
        : 'visionCapabilityUndeclaredWarning'
    }

    // ── field specs ──────────────────────────────────────────────────────────
    const TOGGLE_KEYS = ['autoWrapProviders', 'tool', 'structuredVisionBootstrap', 'routing']
    const PERFORMANCE_TOGGLE_KEYS = ['downscale', 'cache']
    const COMPATIBILITY_TOGGLE_KEYS = ['reverseRouting', 'rewriteImages', 'freeFallback']
    const COST_TOGGLE_KEYS = ['freeCloudFirst']
    const DEVELOPER_TOGGLE_KEYS = ['stealth']
    const LOCAL_TOGGLE_KEYS = ['instantDescribe']
    const PRIVACY_TOGGLE_KEYS = ['desktopScreenshot']
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
    const LOCAL_PROVIDER_DEFAULTS = {
      localOllama: {
        baseURL: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5vl',
      },
      localLmStudio: {
        baseURL: 'http://localhost:1234/v1',
        model: '',
      },
    }

    /** Keep every supported local-provider field during settings UI round-trips. */
    function normalizeLocalProviderDraft(value, defaults) {
      const input = value && typeof value === 'object' ? value : {}
      return {
        enabled: input.enabled === true,
        baseURL:
          typeof input.baseURL === 'string' && input.baseURL !== ''
            ? input.baseURL
            : defaults.baseURL,
        model:
          typeof input.model === 'string' && input.model !== ''
            ? input.model
            : defaults.model,
        format: input.format === 'anthropic' ? 'anthropic' : 'openai',
        temperature:
          typeof input.temperature === 'number' && Number.isFinite(input.temperature)
            ? input.temperature
            : undefined,
        top_p:
          typeof input.top_p === 'number' && Number.isFinite(input.top_p)
            ? input.top_p
            : undefined,
      }
    }

    function parseLocalProviderDraft(value, defaults) {
      const input = value && typeof value === 'object' ? value : {}
      const temperature =
        typeof input.temperature === 'number' && Number.isFinite(input.temperature)
          ? Math.min(2, Math.max(0, input.temperature))
          : undefined
      const topP =
        typeof input.top_p === 'number' && Number.isFinite(input.top_p)
          ? Math.min(1, Math.max(0, input.top_p))
          : undefined
      return {
        enabled: input.enabled === true,
        baseURL:
          typeof input.baseURL === 'string' && input.baseURL.trim() !== ''
            ? input.baseURL.trim()
            : defaults.baseURL,
        model:
          typeof input.model === 'string' && input.model.trim() !== ''
            ? input.model.trim()
            : defaults.model,
        format: input.format === 'anthropic' ? 'anthropic' : 'openai',
        ...(temperature === undefined ? {} : { temperature }),
        ...(topP === undefined ? {} : { top_p: topP }),
      }
    }

    function readValue(snapshot, key) {
      const value = snapshot && snapshot.value
      return value && typeof value === 'object' ? value[key] : undefined
    }
    function userHas(snapshot, key) {
      const user = snapshot && snapshot.user
      return !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, key)
    }

    /** Compare the JSON-shaped values accepted by SettingsScope. */
    function jsonValueEqual(left, right) {
      if (left === right) return true
      if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
      if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
        return left.every((value, index) => jsonValueEqual(value, right[index]))
      }
      const leftKeys = Object.keys(left)
      const rightKeys = Object.keys(right)
      if (leftKeys.length !== rightKeys.length) return false
      return leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(right, key) && jsonValueEqual(left[key], right[key]),
      )
    }

    /**
     * Canonicalize only the schema-defaulted shape of `providers`.
     * SettingsScope may materialize a missing `fallbacks` as [] on readback;
     * treating those two shapes as equivalent avoids a false save failure
     * without weakening deep comparison for any other settings field.
     */
    function canonicalizeProviders(value) {
      if (!Array.isArray(value)) return value
      return value.map((row) => {
        if (!row || typeof row !== 'object') return row
        return {
          ...row,
          fallbacks: row.fallbacks === undefined ? [] : row.fallbacks,
        }
      })
    }

    function settingsValueEqual(key, left, right) {
      if (key === 'providers') {
        return jsonValueEqual(canonicalizeProviders(left), canonicalizeProviders(right))
      }
      return jsonValueEqual(left, right)
    }

    function canonicalizeSettingsRun(key, run) {
      if (key === 'providers' && run && !run.clear) {
        return { ...run, value: canonicalizeProviders(run.value) }
      }
      return run
    }

    function settingsSaveErrorMessage(error) {
      return error && error.message ? error.message : String(error)
    }

    /**
     * Write a settings plan and verify the raw user layer after every settled
     * operation. SettingsScope intentionally resolves after a rejected Host
     * mutation once its recovery read finishes, so Promise settlement alone is
     * not evidence that a write landed.
     */
    async function commitSettingsPlan(scope, plan, drafts = {}) {
      const failures = []
      const landedFields = []
      const inspectReadback = (item) => {
        let snapshot
        try {
          snapshot = scope.getSnapshot()
        } catch (error) {
          return { error: {
            field: item.key,
            operation: item.run.clear ? 'unset' : 'set',
            reason: 'readback-error',
            detail: settingsSaveErrorMessage(error),
          } }
        }
        const user = snapshot && snapshot.user
        const stored = !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, item.key)
        const ok = item.run.clear
          ? !stored
          : stored && settingsValueEqual(item.key, user[item.key], item.run.value)
        return { ok, stored }
      }
      const writeItem = async (item) => {
        if (item.run.clear) await scope.unset(item.key)
        else await scope.set(item.key, item.run.value)
      }
      for (const item of plan) {
        const operation = item.run.clear ? 'unset' : 'set'
        let success = false
        let terminalFailure
        for (let attempt = 0; attempt < 2 && !success; attempt++) {
          try {
            await writeItem(item)
          } catch (error) {
            terminalFailure = {
              field: item.key,
              operation,
              reason: error && error.code === 'settings-conflict' ? 'settings-conflict' : 'write-error',
              detail: settingsSaveErrorMessage(error),
            }
            break
          }

          let check = inspectReadback(item)
          if (check.error) {
            terminalFailure = check.error
            break
          }
          if (check.ok) {
            success = true
            break
          }

          if (attempt === 0 && typeof scope.load === 'function') {
            try {
              await scope.load()
            } catch {
              // The idempotent retry below is still safe.
            }
            check = inspectReadback(item)
            if (check.error) {
              terminalFailure = check.error
              break
            }
            if (check.ok) {
              success = true
              break
            }
          }

          terminalFailure = {
            field: item.key,
            operation,
            reason: 'readback-mismatch',
            detail: item.run.clear
              ? 'field remained present in the user layer'
              : check.stored
                ? 'stored user-layer value differs from the requested value'
                : 'field is absent from the user layer',
          }
        }
        if (success) landedFields.push(item.key)
        else failures.push(terminalFailure ?? {
          field: item.key,
          operation,
          reason: 'readback-mismatch',
          detail: 'write did not become visible in the user layer',
        })
      }
      const landed = failures.length === 0
      const nextDrafts = landedFields.length === 0 ? drafts : { ...drafts }
      for (const field of landedFields) delete nextDrafts[field]
      return {
        landed,
        failed: !landed,
        landedFields,
        nextDrafts,
        failures,
      }
    }

    const REMOTE_SETTINGS_CHANNEL = '/vision-router-settings'
    const REMOTE_SETTINGS_TIMEOUT_MS = 10000

    function remoteSettingsError(message, code, details) {
      const error = new Error(message)
      if (code) error.code = code
      if (details !== undefined) error.details = details
      return error
    }

    function createRemoteSettingsScope(getConnection, options = {}) {
      const listeners = new Set()
      const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(10, Number(options.timeoutMs)) : REMOTE_SETTINGS_TIMEOUT_MS
      const retryDelays = Array.isArray(options.initRetryDelays) ? options.initRetryDelays : [250, 500, 1000, 1500, 2000]
      let disposed = false
      let readPromise
      let readController
      let readGeneration = 0
      let writeTail = Promise.resolve()
      let initRetryTimer
      let initRetryIndex = 0
      const controllers = new Set()
      let snapshot = Object.freeze({
        status: 'loading', value: undefined, base: undefined, user: undefined,
        revision: undefined, writable: false, mode: 'remote', remoteDisabled: false,
        remoteReason: undefined, remoteError: undefined, remoteErrorCode: undefined,
      })

      const publish = (next) => {
        if (disposed) return
        snapshot = Object.freeze(next)
        for (const listener of [...listeners]) {
          try { listener() } catch { /* isolate subscribers */ }
        }
      }
      const clearInitRetry = () => {
        if (initRetryTimer !== undefined) clearTimeout(initRetryTimer)
        initRetryTimer = undefined
      }
      const unavailable = (options = {}) => publish({
        status: 'unavailable', value: undefined, base: undefined, user: undefined,
        revision: undefined, writable: false, mode: 'remote',
        remoteDisabled: options.reason === 'permission-disabled',
        remoteReason: options.reason,
        remoteError: options.error,
        remoteErrorCode: options.errorCode,
      })
      const scheduleInitRetry = () => {
        if (disposed || initRetryTimer !== undefined || initRetryIndex >= retryDelays.length) return
        const delay = Math.max(0, Number(retryDelays[initRetryIndex++]) || 0)
        initRetryTimer = setTimeout(() => {
          initRetryTimer = undefined
          void startRead(true)
        }, delay)
      }
      const accept = (payload, generation) => {
        if (disposed || generation !== readGeneration) return
        if (!payload || payload.enabled !== true) {
          const reason = payload && typeof payload.reason === 'string' ? payload.reason : 'permission-disabled'
          unavailable({ reason })
          if (reason === 'namespace-unavailable') scheduleInitRetry()
          else { clearInitRetry(); initRetryIndex = 0 }
          return
        }
        const view = payload.view
        if (!view || typeof view.value !== 'object' || view.value === null || Array.isArray(view.value)
            || !Number.isInteger(view.revision) || view.revision < 0) {
          throw remoteSettingsError('Vision Router remote settings returned an invalid view', 'invalid-view')
        }
        clearInitRetry()
        initRetryIndex = 0
        publish({
          status: 'ready', value: view.value, base: view.base, user: view.user,
          revision: view.revision, writable: payload.writable === true, mode: 'remote',
          remoteDisabled: false, remoteReason: 'enabled', remoteError: undefined, remoteErrorCode: undefined,
        })
      }
      const call = async (endpoint, payload, kind) => {
        const connection = typeof getConnection === 'function' ? getConnection() : undefined
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          throw remoteSettingsError('DSH Connection RPC is unavailable', 'connection-unavailable')
        }
        const controller = new AbortController()
        controllers.add(controller)
        if (kind === 'read') readController = controller
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
        try {
          const result = await connection.rpc.call(REMOTE_SETTINGS_CHANNEL, endpoint, payload, controller.signal)
          if (!result || result.ok !== true) {
            const message = result?.error?.message || 'Vision Router remote settings request failed'
            throw remoteSettingsError(message, result?.error?.code, result?.error?.details)
          }
          return result.value
        } catch (error) {
          if (timedOut) throw remoteSettingsError('Vision Router remote settings request timed out', 'settings-timeout')
          const message = error?.message ?? String(error)
          if (/\/vision-router-settings\/.+HTTP 404/i.test(message)) {
            throw remoteSettingsError(message, 'remote-route-missing')
          }
          throw error
        } finally {
          clearTimeout(timer)
          controllers.delete(controller)
          if (readController === controller) readController = undefined
        }
      }
      const performRead = async (generation) => {
        try {
          const payload = await call('describe', {}, 'read')
          accept(payload, generation)
        } catch (error) {
          if (disposed || generation !== readGeneration) return
          unavailable({
            reason: 'transport-unavailable',
            error: error?.message ?? String(error),
            errorCode: error?.code,
          })
        }
      }
      function startRead(restart = false) {
        if (disposed) return Promise.resolve()
        if (restart && readController) readController.abort()
        if (!restart && readPromise) return readPromise
        const generation = ++readGeneration
        const task = performRead(generation)
        readPromise = task.finally(() => {
          if (readPromise === task || generation === readGeneration) readPromise = undefined
        })
        return readPromise
      }
      const write = (op) => {
        const task = writeTail.then(async () => {
          if (disposed) return
          if (snapshot.status !== 'ready' || !Number.isInteger(snapshot.revision)) {
            await startRead(true)
            if (snapshot.status !== 'ready' || !Number.isInteger(snapshot.revision)) {
              throw remoteSettingsError('Vision Router remote settings are not ready', 'settings-unavailable')
            }
          }
          if (!snapshot.writable) throw remoteSettingsError('Vision Router settings provider is read-only', 'settings-readonly')
          try {
            const payload = await call('mutate', { ops: [op], expectedRevision: snapshot.revision }, 'write')
            // Mutate responses are authoritative and may revoke permission.
            const generation = ++readGeneration
            accept(payload, generation)
          } catch (error) {
            await startRead(true).catch(() => {})
            throw error
          }
        })
        writeTail = task.catch(() => {})
        return task
      }
      return {
        getSnapshot() { return snapshot },
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        load() { return startRead(false) },
        reload() { return startRead(true) },
        set(field, value) { return write({ op: 'set', path: [field], value }) },
        unset(field) { return write({ op: 'unset', path: [field] }) },
        async dispose() {
          disposed = true
          clearInitRetry()
          readGeneration += 1
          for (const controller of controllers) controller.abort()
          listeners.clear()
          await Promise.allSettled([readPromise, writeTail].filter(Boolean))
        },
      }
    }

    function shouldUseRemoteSettings(getConnection, locationLike) {
      try {
        const connection = typeof getConnection === 'function' ? getConnection() : undefined
        if (connection && typeof connection.isLoopback === 'boolean') return connection.isLoopback === false
      } catch { /* fall through to page authority */ }
      const location = locationLike ?? (typeof window !== 'undefined' ? window.location : undefined)
      const hostname = typeof location?.hostname === 'string' ? location.hostname.toLowerCase().replace(/^\[|\]$/g, '') : ''
      if (hostname === '') return false
      if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') return false
      if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return false
      return true
    }

    function reportSettingsSaveFailures(failures) {
      if (!Array.isArray(failures) || failures.length === 0 || typeof fetch !== 'function') return
      try {
        void fetch('/_dsh/vision-router/settings-save-diagnostics', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ failures }),
        }).catch(() => {})
      } catch {
        // Diagnostics are best-effort and must never mask the visible failure.
      }
    }

    function normalizeVisionChainRows(value) {
      if (!Array.isArray(value)) return []
      const rows = []
      for (const row of value) {
        if (!row || typeof row !== 'object') continue
        const provider = typeof row.provider === 'string' ? row.provider.trim() : ''
        const model = typeof row.model === 'string' ? row.model.trim() : ''
        if (provider === 'vision-http' || (provider === '' && model === '')) continue
        rows.push({ ...row, provider, model })
      }
      return rows
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
        list.push({ provider, model, fallbacks: [] })
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
    function parseNumber(text, min, max) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return { clear: true }
      const parsed = Number(trimmed)
      return Number.isInteger(parsed) && parsed >= min && (max === undefined || parsed <= max)
        ? { value: parsed }
        : undefined
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
      '.vr-field{content-visibility:auto;contain-intrinsic-size:auto 96px;flex-direction:column;gap:6px;padding:12px 0;display:flex}' +
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
      '.vr-update-manual{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-module-platform);padding:11px 12px;display:flex;flex-direction:column;gap:10px}' +
      '.vr-update-manual-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary);line-height:1.5}' +
      '.vr-update-command{display:flex;flex-direction:column;gap:5px;min-width:0}' +
      '.vr-update-command-label{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);line-height:1.4}' +
      '.vr-update-code{display:block;width:100%;box-sizing:border-box;overflow-x:auto;white-space:pre;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.55}' +
      '.vr-update-note{margin:0;padding:7px 9px;border-left:2px solid var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-3);border-radius:0 7px 7px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.55}' +
      '.vr-update-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:1px}' +
      '.vr-vision-empty{margin:8px 0 2px;padding:11px 12px;border:1px solid var(--dsw-alias-label-warning,var(--dsw-alias-border-l2));border-radius:9px;background:var(--dsw-alias-bg-module-platform);display:flex;flex-direction:column;gap:7px}' +
      '.vr-vision-empty-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary);margin:0}' +
      '.vr-vision-empty-list{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;word-break:break-word}' +
      '.vr-vision-empty-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.vr-subheader{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:8px 0;border:none;background:none;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary);text-align:left}' +
      '.vr-group{content-visibility:auto;contain-intrinsic-size:auto 96px;border-top:1px solid var(--dsw-alias-border-l2);padding:10px 0 2px;display:flex;flex-direction:column;gap:8px}' +
      '.vr-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin:0}' +
      '.vr-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:0;border:none;background:none;cursor:pointer;font:inherit;color:inherit;text-align:left}' +
      '.vr-group-summary{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.vr-local-group{margin:0;padding:10px 0 2px;gap:7px}' +
      '.vr-local-group-open{margin-bottom:10px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.vr-local-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary)}' +
      '.vr-local-entry-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.55}' +
      '.vr-local-body{display:flex;flex-direction:column;gap:8px;padding-top:4px}' +
      '.vr-local-row{display:grid;grid-template-columns:minmax(128px,.38fr) minmax(0,1fr);align-items:center;gap:8px 12px;min-width:0}' +
      '.vr-local-row-pair{grid-template-columns:minmax(92px,.3fr) minmax(72px,1fr) minmax(60px,.22fr) minmax(72px,1fr)}' +
      '.vr-local-label{flex:none}' +
      '.vr-select{flex:1;min-width:0;font:inherit}' +
      '.vr-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}' +
      '.vr-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}' +
      '.vr-toggle{display:flex;align-items:center;gap:10px;justify-content:space-between;width:100%}' +
      '.vr-savebar{position:sticky;top:10px;z-index:20;width:max-content;max-width:100%;margin:0 0 10px auto;padding:5px 6px;display:flex;justify-content:flex-end;align-items:center;gap:6px;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 3px 10px #00000012}' +
      '.vr-savebar .vr-pending{margin:0 4px 0 2px;font-size:12px}' +
      '.vr-savebar .vr-btn{padding:4px 10px}' +
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
      '.vr-guide-prompt{position:fixed;z-index:10002;width:min(360px,calc(100vw - 24px));box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 40px #0006;padding:14px;display:flex;flex-direction:column;gap:7px;color:var(--dsw-alias-label-primary);transition:left .22s ease,top .22s ease,opacity .18s ease,transform .18s ease}' +
      '.vr-guide-prompt-title{font-size:13px;font-weight:700;line-height:1.5}' +
      '.vr-guide-prompt-body{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}' +
      '.vr-guide-prompt-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.vr-guide-prompt-veiled{opacity:0;transform:translateY(10px);pointer-events:none}' +
      '.vr-guide-arrow{position:absolute;width:20px;height:20px;pointer-events:none}' +
      '.vr-guide-arrow::before{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:9px solid #0000}' +
      '.vr-guide-arrow::after{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:8px solid #0000}' +
      '.vr-guide-arrow-bottom{bottom:-11px;left:var(--vr-arrow-pos)}' +
      '.vr-guide-arrow-bottom::before{border-bottom-width:0;border-top-color:var(--dsw-alias-brand-primary)}' +
      '.vr-guide-arrow-bottom::after{border-bottom-width:0;border-top-color:var(--dsw-alias-bg-layer-2);margin-top:1px}' +
      '.vr-guide-arrow-top{top:-11px;left:var(--vr-arrow-pos)}' +
      '.vr-guide-arrow-top::before{border-top-width:0;border-bottom-color:var(--dsw-alias-brand-primary)}' +
      '.vr-guide-arrow-top::after{border-top-width:0;border-bottom-color:var(--dsw-alias-bg-layer-2);margin-top:-1px}' +
      '.vr-guide-arrow-left{left:-11px;top:var(--vr-arrow-pos)}' +
      '.vr-guide-arrow-left::before{border-left-width:0;border-right-color:var(--dsw-alias-brand-primary)}' +
      '.vr-guide-arrow-left::after{border-left-width:0;border-right-color:var(--dsw-alias-bg-layer-2);margin-left:1px}' +
      '.vr-guide-arrow-right{right:-11px;top:var(--vr-arrow-pos)}' +
      '.vr-guide-arrow-right::before{border-right-width:0;border-left-color:var(--dsw-alias-brand-primary)}' +
      '.vr-guide-arrow-right::after{border-right-width:0;border-left-color:var(--dsw-alias-bg-layer-2);margin-left:-1px}' +
      '.vr-guide-arrow-corner-se{bottom:-10px;right:0;transform:rotate(-45deg)}' +
      '.vr-guide-arrow-corner-sw{bottom:-10px;left:0;transform:rotate(45deg)}' +
      '.vr-guide-arrow-corner-se::before,.vr-guide-arrow-corner-sw::before{border-bottom-width:0;border-top-color:var(--dsw-alias-brand-primary)}' +
      '.vr-guide-arrow-corner-se::after,.vr-guide-arrow-corner-sw::after{border-bottom-width:0;border-top-color:var(--dsw-alias-bg-layer-2);margin-top:1px}' +
      '.vr-guide-spot{position:fixed;inset:0;z-index:10000;pointer-events:none}' +
      '.vr-guide-spot-hole{position:fixed;border-radius:14px;box-shadow:0 0 0 9999px #10101499;transition:left .22s ease,top .22s ease,width .22s ease,height .22s ease}' +
      '.vr-guide-spot-ring{position:fixed;border:2px solid var(--dsw-alias-brand-primary);border-radius:16px;animation:vr-guide-pulse 1.6s ease-in-out infinite;transition:left .22s ease,top .22s ease,width .22s ease,height .22s ease}' +
      '@keyframes vr-guide-pulse{0%,100%{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,#0000),0 0 18px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,#0000)}50%{box-shadow:0 0 0 9px color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,#0000),0 0 30px color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,#0000)}}' +
      '.vr-guide-target{border:2px solid var(--dsw-alias-brand-primary)!important;border-radius:12px;padding:12px!important;margin:8px -12px!important;background:var(--dsw-alias-bg-module-platform);animation:vr-guide-target-pulse 1.6s ease-in-out infinite}' +
      '@keyframes vr-guide-target-pulse{0%,100%{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,#0000)}50%{box-shadow:0 0 0 9px color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,#0000)}}' +
      '.vr-guide-callout{border-radius:9px;background:var(--dsw-alias-bg-layer-3);padding:10px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:5px;margin-bottom:4px}' +
      '.vr-guide-callout-title{font-size:13px;font-weight:700;color:var(--dsw-alias-brand-primary)}' +
      '.vr-guide-callout-body{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}' +
      '@media(prefers-reduced-motion:reduce){.vr-guide-spot-ring,.vr-guide-target{animation:none}.vr-guide-prompt{transition:none}}' +
      '@media(max-width:640px){.vr-local-row,.vr-local-row-pair{grid-template-columns:minmax(0,1fr)}.vr-local-row-pair .vr-local-label:not(:first-child){margin-top:4px}.vr-local-options{align-items:flex-start}}' +
      '@media(max-width:640px){.vr-onboarding-backdrop{align-items:flex-end;padding:0}.vr-onboarding-dialog{width:100%;border-radius:16px 16px 0 0;padding:20px 18px max(20px,env(safe-area-inset-bottom))}.vr-guide-arrow{display:none}.vr-guide-prompt{left:12px!important;right:12px!important;bottom:max(12px,env(safe-area-inset-bottom))!important;top:auto!important;width:auto}}'

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
    // Durable onboarding suppression survives DSH Desktop's random Web port
    // (#78). Only the disposition is durable; the active walkthrough step is
    // deliberately session-only so a half-finished guide never resumes from a
    // stale settings snapshot on the next launch.
    const ONBOARDING_SETTINGS_KEY = 'onboardingSeen'
    const LEGACY_VISION_GUIDE_STORAGE_KEY = 'dsh-vision-router:guide:vision-backend-v2'
    const LEGACY_VISION_GUIDE_SETTINGS_KEY = 'visionGuideStep'
    const VISION_GUIDE_EVENT = 'dsh-vision-router:vision-settings-guide'

    const GUIDE_STATE = Object.freeze({
      IDLE: 'idle',
      OVERVIEW: 'overview',
      CHAT_MODEL: 'chat-model',
      SETTINGS: 'settings',
      VISION_MODEL: 'vision-model',
    })
    const GUIDE_EVENT = Object.freeze({
      SHOW_OVERVIEW: 'show-overview',
      START: 'start',
      LATER: 'later',
      DISMISS: 'dismiss',
      NEXT: 'next',
      TARGET_READY: 'target-ready',
      SETTINGS_CLOSED: 'settings-closed',
      CANCEL: 'cancel',
      COMPLETE: 'complete',
    })

    let guideSessionState = GUIDE_STATE.IDLE
    let guideTranslator
    let onboardingSeenMemory = false
    let onboardingAutoPresented = false
    let legacyGuideCleanupDone = false
    let visionGuidePrompt
    let visionGuideSpotlight
    let guideSyncFrame
    let guideRuntimeDispose
    let guidePanelCloseCancel
    let guideSettingsPanelSeen = false
    const GUIDE_RESOLVE_THROTTLE_MS = 250
    let visionGuideResolved = {
      state: GUIDE_STATE.IDLE,
      step: undefined,
      phase: undefined,
      panelOpen: false,
      target: undefined,
      at: 0,
    }

    // Installed by apply(): a narrow, defensive view of the settings scope.
    // Hidden onboarding durability is best-effort and idempotent. Guide
    // progress no longer flows through this channel at all (#207).
    let settingsPersistence
    function installSettingsPersistence(scope) {
      const pending = new Map()
      const issued = new Map()
      let flushing = false
      const readSnapshot = () => {
        try {
          return scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined
        } catch {
          return undefined
        }
      }
      const readSection = () => {
        const snapshot = readSnapshot()
        return snapshot && snapshot.value ? snapshot.value : undefined
      }
      const sameMutation = (left, operation, value) =>
        !!left && left.operation === operation && (operation === 'unset' || jsonValueEqual(left.value, value))
      const alreadyStored = (field, operation, value) => {
        const snapshot = readSnapshot()
        const user = snapshot && snapshot.user
        const stored = !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, field)
        return operation === 'unset' ? !stored : stored && jsonValueEqual(user[field], value)
      }
      const queue = (field, operation, value) => {
        if (alreadyStored(field, operation, value)) {
          pending.delete(field)
          issued.set(field, { operation, value })
          return
        }
        const previous = pending.get(field)
        if (sameMutation(previous, operation, value)) return
        // A rejected hidden-state write is never subscribe-retried forever
        // (#155). A genuinely different mutation can still be attempted.
        if (sameMutation(issued.get(field), operation, value)) return
        pending.set(field, { operation, value, attempted: false })
        void flush()
      }
      const landed = (field, entry) => {
        const snapshot = readSnapshot()
        const user = snapshot && snapshot.user
        const stored = !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, field)
        return entry.operation === 'unset' ? !stored : stored && jsonValueEqual(user[field], entry.value)
      }
      const flush = async () => {
        if (flushing) return
        const snapshot = readSnapshot()
        if (!snapshot || snapshot.status !== 'ready' || !snapshot.writable) return
        const work = [...pending.entries()].filter(([, entry]) => !entry.attempted)
        if (work.length === 0) return
        flushing = true
        try {
          for (const [field, entry] of work) {
            if (pending.get(field) !== entry) continue
            entry.attempted = true
            issued.set(field, { operation: entry.operation, value: entry.value })
            try {
              if (entry.operation === 'unset') {
                if (typeof scope.unset !== 'function') continue
                await scope.unset(field)
              } else {
                if (typeof scope.set !== 'function') continue
                await scope.set(field, entry.value)
              }
            } catch {
              continue
            }
            if (pending.get(field) === entry && landed(field, entry)) pending.delete(field)
          }
        } finally {
          flushing = false
          if ([...pending.values()].some((entry) => !entry.attempted)) void flush()
        }
      }
      settingsPersistence = {
        get(field) {
          const section = readSection()
          return section ? section[field] : undefined
        },
        set(field, value) {
          queue(field, 'set', value)
        },
        unset(field) {
          queue(field, 'unset')
        },
        snapshot() {
          return readSnapshot()
        },
        subscribe(listener) {
          try {
            if (!scope || typeof scope.subscribe !== 'function') return undefined
            return scope.subscribe(() => {
              void flush()
              listener()
            })
          } catch {
            return undefined
          }
        },
      }
      void flush()
      return settingsPersistence
    }

    // Tri-state by construction: "unknown" is not silently collapsed into
    // "unseen" while the settings snapshot is still loading. This removes the
    // old fixed 650ms guess and the late/flashy first-run race (#207).
    function readOnboardingDisposition() {
      if (onboardingSeenMemory) return 'seen'
      try {
        if (window.localStorage && window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === 'seen') {
          onboardingSeenMemory = true
          if (settingsPersistence) settingsPersistence.set(ONBOARDING_SETTINGS_KEY, true)
          return 'seen'
        }
      } catch {
        // Continue to the profile-backed source of truth.
      }
      const snapshot =
        settingsPersistence && typeof settingsPersistence.snapshot === 'function'
          ? settingsPersistence.snapshot()
          : undefined
      if (!snapshot || snapshot.status !== 'ready') return 'unknown'
      try {
        return settingsPersistence.get(ONBOARDING_SETTINGS_KEY) === true ? 'seen' : 'unseen'
      } catch {
        return 'unknown'
      }
    }
    function readOnboardingSeen() {
      return readOnboardingDisposition() === 'seen'
    }
    function rememberOnboardingSeen() {
      onboardingSeenMemory = true
      try {
        if (settingsPersistence) settingsPersistence.set(ONBOARDING_SETTINGS_KEY, true)
      } catch {
        // The current page still remains authoritative.
      }
      try {
        if (window.localStorage) window.localStorage.setItem(ONBOARDING_STORAGE_KEY, 'seen')
      } catch {
        // Best-effort downgrade marker only.
      }
    }
    function clearLegacyGuidePersistence() {
      if (legacyGuideCleanupDone) return
      const snapshot =
        settingsPersistence && typeof settingsPersistence.snapshot === 'function'
          ? settingsPersistence.snapshot()
          : undefined
      if (!snapshot || snapshot.status !== 'ready') return
      legacyGuideCleanupDone = true
      // v1.2-v1.6 persisted the current walkthrough step. New lifecycle state
      // is session-owned, so remove the stale field once and never read it.
      try {
        if (settingsPersistence) settingsPersistence.unset(LEGACY_VISION_GUIDE_SETTINGS_KEY)
      } catch {
        // Stale legacy data is harmless because the new runtime ignores it.
      }
      try {
        if (window.localStorage) window.localStorage.removeItem(LEGACY_VISION_GUIDE_STORAGE_KEY)
      } catch {
        // Best effort.
      }
    }

    function guideTransition(state, event) {
      const type = event && event.type
      if (type === GUIDE_EVENT.SHOW_OVERVIEW) return GUIDE_STATE.OVERVIEW
      if (type === GUIDE_EVENT.COMPLETE) return GUIDE_STATE.IDLE
      if (type === GUIDE_EVENT.CANCEL) return GUIDE_STATE.IDLE
      if (state === GUIDE_STATE.IDLE) {
        return type === GUIDE_EVENT.START ? GUIDE_STATE.CHAT_MODEL : state
      }
      if (state === GUIDE_STATE.OVERVIEW) {
        if (type === GUIDE_EVENT.START) return GUIDE_STATE.CHAT_MODEL
        if (type === GUIDE_EVENT.LATER || type === GUIDE_EVENT.DISMISS) return GUIDE_STATE.IDLE
        return state
      }
      if (state === GUIDE_STATE.CHAT_MODEL) {
        if (type === GUIDE_EVENT.NEXT) return GUIDE_STATE.SETTINGS
        // Closing Settings while step 1 is active is not a guide action: the
        // user may be closing the panel specifically to reach the chat model.
        if (type === GUIDE_EVENT.SETTINGS_CLOSED) return GUIDE_STATE.CHAT_MODEL
        return state
      }
      if (state === GUIDE_STATE.SETTINGS) {
        if (type === GUIDE_EVENT.TARGET_READY) return GUIDE_STATE.VISION_MODEL
        if (type === GUIDE_EVENT.SETTINGS_CLOSED) return GUIDE_STATE.IDLE
        return state
      }
      if (state === GUIDE_STATE.VISION_MODEL) {
        if (type === GUIDE_EVENT.SETTINGS_CLOSED) return GUIDE_STATE.IDLE
        return state
      }
      return GUIDE_STATE.IDLE
    }

    function notifyVisionGuideChanged() {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
      const EventCtor = window.Event
      if (typeof EventCtor === 'function') window.dispatchEvent(new EventCtor(VISION_GUIDE_EVENT))
    }
    function readVisionGuideStep() {
      if (guideSessionState === GUIDE_STATE.CHAT_MODEL) return 'step1'
      if (guideSessionState === GUIDE_STATE.SETTINGS || guideSessionState === GUIDE_STATE.VISION_MODEL) return 'step2'
      return undefined
    }
    function guideState() {
      return guideSessionState
    }
    function cancelGuidePanelCloseCheck() {
      if (typeof guidePanelCloseCancel === 'function') guidePanelCloseCancel()
      guidePanelCloseCancel = undefined
    }
    function clearGuidePromptUI() {
      if (visionGuidePrompt) visionGuidePrompt.remove()
      visionGuidePrompt = undefined
      removeGuideSpotlight()
    }
    function removeVisionGuidePrompt() {
      clearGuidePromptUI()
    }
    function removeGuideSpotlight() {
      if (visionGuideSpotlight) {
        visionGuideSpotlight.root.remove()
        visionGuideSpotlight = undefined
      }
    }
    function stopGuideRuntime() {
      const dispose = guideRuntimeDispose
      guideRuntimeDispose = undefined
      if (typeof dispose === 'function') dispose()
      cancelGuidePanelCloseCheck()
      if (
        guideSyncFrame !== undefined &&
        typeof window !== 'undefined' &&
        typeof window.cancelAnimationFrame === 'function'
      ) {
        window.cancelAnimationFrame(guideSyncFrame)
      }
      guideSyncFrame = undefined
      clearGuidePromptUI()
      visionGuideResolved = {
        state: guideSessionState,
        step: readVisionGuideStep(),
        phase: undefined,
        panelOpen: false,
        target: undefined,
        at: 0,
      }
    }
    function stopGuideSync() {
      stopGuideRuntime()
    }
    function setGuideState(next, t) {
      if (t) guideTranslator = t
      if (next === guideSessionState) {
        if (readVisionGuideStep() !== undefined && guideTranslator) scheduleGuideSync(guideTranslator)
        return guideSessionState
      }
      guideSessionState = next
      if (next !== GUIDE_STATE.SETTINGS && next !== GUIDE_STATE.VISION_MODEL) {
        guideSettingsPanelSeen = false
        cancelGuidePanelCloseCheck()
      }
      visionGuideResolved.at = 0
      notifyVisionGuideChanged()
      if (readVisionGuideStep() === undefined) {
        stopGuideRuntime()
      } else if (guideTranslator) {
        ensureGuideRuntime(guideTranslator)
        scheduleGuideSync(guideTranslator)
      }
      return guideSessionState
    }
    function dispatchGuide(event, t) {
      return setGuideState(guideTransition(guideSessionState, event), t)
    }
    // Compatibility shim for old internal call sites/tests. It is intentionally
    // session-only: no settings/localStorage writes are allowed here.
    function writeVisionGuideStep(step) {
      if (step === 'step1') return setGuideState(GUIDE_STATE.CHAT_MODEL, guideTranslator)
      if (step === 'step2') return setGuideState(GUIDE_STATE.SETTINGS, guideTranslator)
      return setGuideState(GUIDE_STATE.IDLE, guideTranslator)
    }

    // Host UI adapter boundary. The Escape fallback is still necessary because
    // current DSH exposes no public close-settings API, but lifecycle/business
    // state never depends on the key event itself.
    function closeSettingsShell() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return false
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        return true
      } catch {
        return false
      }
    }

    // ── walkthrough spotlight: highlight the real UI targets ────────────────
    // The walkthrough overlays are plain DOM: a dimmed backdrop with a "hole"
    // over the current target (classic box-shadow spotlight), a pulsing ring
    // around it, and the prompt card anchored beside the target with an arrow
    // pointing at it. Everything is pointer-events:none except the prompt, so
    // the real controls stay clickable the whole time.
    //
    // DSH web hashes its CSS-module class names (unstable across builds), so
    // the targets are addressed through the stable surface instead: slot
    // wrappers (data-slot), data-composer-card and aria-haspopup/aria-label
    // attributes. Each step keeps a fallback chain, and when nothing matches
    // the prompt degrades to a corner card with a directional arrow.
    const GUIDE_SELECTOR_TARGETS = [
      '[data-slot="conversation.input.model"] button[aria-haspopup="menu"]',
      '[aria-label^="选择模型"], [aria-label^="Select model"]',
      '[data-composer-card] button[aria-haspopup="menu"]',
    ]
    // Settings is a modal, not a URL route: detect it purely by DOM. Exclude
    // our own onboarding dialog (also aria-modal) from the panel lookup.
    function guideSettingsPanel() {
      if (typeof document === 'undefined') return undefined
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
      return dialogs.find((dialog) => !dialog.closest || !dialog.closest('.vr-onboarding-dialog'))
    }
    // The settings modal can close by unmounting or by the host hiding it in
    // place; a panel that is gone or not visibly rendered counts as closed.
    function guideSettingsPanelOpen() {
      return guideElementUsable(guideSettingsPanel())
    }
    function guideElementUsable(el) {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false
      const rect = el.getBoundingClientRect()
      if (!rect || rect.width < 6 || rect.height < 6) return false
      const vw = window.innerWidth || 1
      const vh = window.innerHeight || 1
      return rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh
    }
    function guideFindFirstUsable(selectors) {
      if (typeof document === 'undefined') return undefined
      for (const selector of selectors) {
        let list
        try {
          list = Array.from(document.querySelectorAll(selector))
        } catch {
          continue
        }
        // Walk backwards: among ambiguous matches (e.g. several menu buttons
        // inside the composer) the trailing row holds the model seat and is
        // the safest pick.
        for (let index = list.length - 1; index >= 0; index--) {
          if (guideElementUsable(list[index])) return list[index]
        }
      }
      return undefined
    }
    // The sidebar settings gear: aria-haspopup="dialog" also appears on the
    // composer's context meter, so exclude anything inside the composer card.
    function guideGearButton() {
      if (typeof document === 'undefined') return undefined
      const list = Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]')).filter(
        (el) => !el.closest || !el.closest('[data-composer-card]'),
      )
      return list.find(guideElementUsable)
    }
    // The walkthrough has one canonical destination: the first-class
    // Vision Router settings section registered below.
    function guideVisionRouterNav() {
      const panel = guideSettingsPanel()
      if (!panel) return undefined
      const nav = panel.querySelector('nav')
      if (!nav) return undefined
      const rows = Array.from(nav.querySelectorAll('button'))
      const match = rows.find((row) =>
        /^Vision Router(?: · (?:图片识别|Image understanding))?$/.test((row.textContent || '').trim()),
      )
      return match || nav
    }
    // DOM details are isolated behind a narrow host adapter. A future DSH
    // settings/navigation API can replace these selectors without touching the
    // guide state machine.
    const guideHostUi = Object.freeze({
      settingsPanel: guideSettingsPanel,
      settingsOpen: guideSettingsPanelOpen,
      chatModelTarget: () => guideFindFirstUsable(GUIDE_SELECTOR_TARGETS),
      settingsButton: guideGearButton,
      visionRouterNav: guideVisionRouterNav,
      closeSettings: closeSettingsShell,
      openSettings() {
        const gear = guideGearButton()
        if (!gear || typeof gear.click !== 'function') return false
        gear.click()
        return true
      },
      openVisionRouter() {
        const row = guideVisionRouterNav()
        if (!row || row.tagName !== 'BUTTON' || typeof row.click !== 'function') return false
        row.click()
        return true
      },
    })

    // Presentation phase is derived from the explicit session state. DOM
    // presence may choose an anchor/fallback, but can no longer decide which
    // business step the user is in.
    function guidePhase(_step) {
      if (guideSessionState === GUIDE_STATE.IDLE) return 'none'
      if (guideSessionState === GUIDE_STATE.OVERVIEW) return 'suspend'
      if (guideSessionState === GUIDE_STATE.CHAT_MODEL) {
        return guideHostUi.chatModelTarget() ? 'selector' : 'corner'
      }
      if (guideSessionState === GUIDE_STATE.VISION_MODEL) return 'done'
      if (typeof document === 'undefined') return 'gear'
      if (document.querySelector('[data-vr-guide-target="vision-backend"]')) return 'done'
      if (guideHostUi.settingsPanel()) return 'nav'
      return 'gear'
    }
    function guideTarget(step, phase) {
      if (step === 'step1') return guideHostUi.chatModelTarget()
      if (phase === 'nav') return guideHostUi.visionRouterNav()
      return guideHostUi.settingsButton()
    }
    function ensureGuideSpotlight() {
      if (visionGuideSpotlight) return visionGuideSpotlight
      if (typeof document === 'undefined' || !document.body) return undefined
      const root = document.createElement('div')
      root.className = 'vr-guide-spot'
      root.setAttribute('aria-hidden', 'true')
      const hole = document.createElement('div')
      hole.className = 'vr-guide-spot-hole'
      const ring = document.createElement('div')
      ring.className = 'vr-guide-spot-ring'
      root.append(hole, ring)
      document.body.appendChild(root)
      visionGuideSpotlight = { root, hole, ring }
      return visionGuideSpotlight
    }
    function applyGuideSpotlight(rect) {
      const spot = ensureGuideSpotlight()
      if (!spot) return
      if (!rect) {
        spot.root.style.display = 'none'
        return
      }
      spot.root.style.display = ''
      const parts = [
        [spot.hole, 9, 14],
        [spot.ring, 5, 16],
      ]
      for (const [el, pad, radius] of parts) {
        el.style.left = Math.max(0, rect.x - pad) + 'px'
        el.style.top = Math.max(0, rect.y - pad) + 'px'
        el.style.width = rect.width + pad * 2 + 'px'
        el.style.height = rect.height + pad * 2 + 'px'
        el.style.borderRadius = radius + 'px'
      }
    }
    function guidePromptText(t, step, phase) {
      if (step === 'step1') return { title: t('guideStep1Title'), body: t('guideStep1Body') }
      return {
        title: t('guidePromptTitle'),
        body: phase === 'nav' ? t('guidePromptNavBody') : t('guidePromptGearBody'),
      }
    }
    function buildGuidePrompt(t, step, phase) {
      const prompt = document.createElement('div')
      prompt.className = 'vr-guide-prompt'
      prompt.setAttribute('role', 'dialog')
      prompt.setAttribute('aria-modal', 'false')
      prompt.dataset.vrStep = step
      prompt.dataset.vrPhase = phase
      const title = document.createElement('div')
      title.className = 'vr-guide-prompt-title'
      const body = document.createElement('p')
      body.className = 'vr-guide-prompt-body'
      const actions = document.createElement('div')
      actions.className = 'vr-guide-prompt-actions'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'vr-btn'
      cancel.textContent = t('guidePromptCancel')
      cancel.addEventListener('click', () => {
        finishVisionSettingsGuide({ remember: true })
      })
      actions.append(cancel)
      // Every step that is not the last one gets a Next button, so the two
      // floating prompts stay symmetric. Step 1's Next advances the stored
      // step; step 2's Next performs the current phase's action for the
      // user — opening the settings panel, then entering the Vision Router
      // section — so the walkthrough can be driven entirely from the prompt
      // without touching the real controls.
      const next = document.createElement('button')
      next.type = 'button'
      next.className = 'vr-btn vr-btn-save'
      next.textContent = t('guideStepNext')
      next.addEventListener('click', () => {
        if (step === 'step1') {
          dispatchGuide({ type: GUIDE_EVENT.NEXT }, t)
        } else {
          const currentPhase = guidePhase('step2')
          if (currentPhase === 'gear') guideHostUi.openSettings()
          else if (currentPhase === 'nav') guideHostUi.openVisionRouter()
        }
        clearGuidePromptUI()
        scheduleGuideSync(t)
      })
      actions.append(next)
      const arrow = document.createElement('div')
      arrow.className = 'vr-guide-arrow'
      arrow.setAttribute('aria-hidden', 'true')
      const text = guidePromptText(t, step, phase)
      title.textContent = text.title
      body.textContent = text.body
      prompt.append(title, body, actions, arrow)
      return prompt
    }
    function updateGuidePrompt(prompt, t, step, phase) {
      const text = guidePromptText(t, step, phase)
      const title = prompt.querySelector('.vr-guide-prompt-title')
      const body = prompt.querySelector('.vr-guide-prompt-body')
      if (title) title.textContent = text.title
      if (body) body.textContent = text.body
      prompt.dataset.vrStep = step
      prompt.dataset.vrPhase = phase
    }
    function guideAnchorCandidate(side, rect, pw, ph, gap) {
      if (side === 'top') return { side, left: rect.x + rect.width / 2 - pw / 2, top: rect.y - ph - gap }
      if (side === 'bottom') return { side, left: rect.x + rect.width / 2 - pw / 2, top: rect.y + rect.height + gap }
      if (side === 'right') return { side, left: rect.x + rect.width + gap, top: rect.y + rect.height / 2 - ph / 2 }
      return { side, left: rect.x - pw - gap, top: rect.y + rect.height / 2 - ph / 2 }
    }
    function anchorGuidePrompt(prompt, step, phase, rect, veil) {
      prompt.classList.toggle('vr-guide-prompt-veiled', !!veil)
      const arrow = prompt.querySelector('.vr-guide-arrow')
      const arrowSides = [
        'vr-guide-arrow-bottom',
        'vr-guide-arrow-top',
        'vr-guide-arrow-left',
        'vr-guide-arrow-right',
        'vr-guide-arrow-corner-se',
        'vr-guide-arrow-corner-sw',
      ]
      if (arrow) {
        for (const cls of arrowSides) arrow.classList.remove(cls)
        arrow.style.removeProperty('--vr-arrow-pos')
      }
      const margin = 12
      const gap = 16
      const vw = window.innerWidth || 1
      const vh = window.innerHeight || 1
      const pw = prompt.offsetWidth || 360
      const ph = prompt.offsetHeight || 160
      if (!rect) {
        // No target found: park the prompt in a corner with an arrow pointing
        // toward where the control normally lives.
        prompt.style.left = step === 'step1' ? margin + 'px' : 'auto'
        prompt.style.right = step === 'step1' ? 'auto' : margin + 'px'
        prompt.style.top = 'auto'
        prompt.style.bottom = margin + 'px'
        if (arrow) arrow.classList.add(step === 'step1' ? 'vr-guide-arrow-corner-se' : 'vr-guide-arrow-corner-sw')
        return
      }
      // The gear sits at the bottom-left: land above it first. Everywhere
      // else prefer the side so the card reads naturally left-to-right.
      const prefer = phase === 'gear' ? ['top', 'right', 'bottom', 'left'] : ['right', 'top', 'bottom', 'left']
      const clampX = (value) => Math.min(Math.max(value, margin), Math.max(margin, vw - pw - margin))
      const clampY = (value) => Math.min(Math.max(value, margin), Math.max(margin, vh - ph - margin))
      // Keep a small halo around the target clear so the prompt never sits
      // flush against (or on top of) the highlighted control.
      const halo = 10
      const hx = rect.x - halo
      const hy = rect.y - halo
      const hw = rect.width + halo * 2
      const hh = rect.height + halo * 2
      let picked
      for (const side of prefer) {
        const candidate = guideAnchorCandidate(side, rect, pw, ph, gap)
        const left = clampX(candidate.left)
        const top = clampY(candidate.top)
        // Judge coverage on the CLAMPED box: clamping next to a viewport edge
        // can push a prompt back over the target, which is exactly how step 1
        // used to hide the model selector.
        const covers = left < hx + hw && left + pw > hx && top < hy + hh && top + ph > hy
        if (!covers) {
          picked = { side, left, top }
          break
        }
      }
      if (!picked) {
        const fallback = guideAnchorCandidate(prefer[0], rect, pw, ph, gap)
        picked = { side: fallback.side, left: clampX(fallback.left), top: clampY(fallback.top) }
      }
      prompt.style.left = picked.left + 'px'
      prompt.style.top = picked.top + 'px'
      prompt.style.right = 'auto'
      prompt.style.bottom = 'auto'
      if (arrow) {
        // The arrow lives on the prompt's edge that FACES the target: a
        // prompt placed above the target shows a bottom arrow pointing down,
        // a prompt to the right of the target shows a left arrow, and so on.
        const arrowSide = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[picked.side]
        arrow.classList.add('vr-guide-arrow-' + arrowSide)
        const pos =
          picked.side === 'top' || picked.side === 'bottom'
            ? Math.min(Math.max(rect.x + rect.width / 2 - picked.left, 16), pw - 16)
            : Math.min(Math.max(rect.y + rect.height / 2 - picked.top, 16), ph - 16)
        arrow.style.setProperty('--vr-arrow-pos', pos + 'px')
      }
    }
    function refreshGuideResolution(step) {
      const now = Date.now()
      const state = guideSessionState
      const cached = visionGuideResolved
      if (
        cached.state === state &&
        cached.step === step &&
        now - cached.at < GUIDE_RESOLVE_THROTTLE_MS &&
        (cached.target === undefined || cached.target.isConnected !== false)
      ) {
        return cached
      }
      const phase = guidePhase(step)
      const settingsPhase = state === GUIDE_STATE.SETTINGS || state === GUIDE_STATE.VISION_MODEL
      const panelOpen = settingsPhase ? guideHostUi.settingsOpen() : false
      const target = phase === 'none' || phase === 'done' || phase === 'suspend' ? undefined : guideTarget(step, phase)
      visionGuideResolved = { state, step, phase, panelOpen, target, at: now }
      return visionGuideResolved
    }

    function scheduleGuideSync(t = guideTranslator) {
      if (!t || readVisionGuideStep() === undefined || typeof window === 'undefined') return
      if (guideSyncFrame !== undefined) return
      if (typeof window.requestAnimationFrame !== 'function') {
        window.setTimeout(() => syncVisionGuidePrompt(t), 0)
        return
      }
      guideSyncFrame = window.requestAnimationFrame(() => {
        guideSyncFrame = undefined
        syncVisionGuidePrompt(t)
      })
    }
    function scheduleGuidePanelCloseCheck(t = guideTranslator) {
      if (guidePanelCloseCancel || typeof window === 'undefined') return
      let cancelled = false
      const verify = () => {
        guidePanelCloseCancel = undefined
        if (cancelled) return
        const state = guideSessionState
        const settingsPhase = state === GUIDE_STATE.SETTINGS || state === GUIDE_STATE.VISION_MODEL
        if (settingsPhase && guideSettingsPanelSeen && !guideHostUi.settingsOpen()) {
          dispatchGuide({ type: GUIDE_EVENT.SETTINGS_CLOSED }, t)
        }
      }
      if (typeof window.requestAnimationFrame === 'function') {
        const id = window.requestAnimationFrame(verify)
        guidePanelCloseCancel = () => {
          cancelled = true
          if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id)
        }
      } else {
        const id = window.setTimeout(verify, 0)
        guidePanelCloseCancel = () => {
          cancelled = true
          if (typeof window.clearTimeout === 'function') window.clearTimeout(id)
        }
      }
    }

    function syncVisionGuidePrompt(t = guideTranslator) {
      if (typeof document === 'undefined' || typeof window === 'undefined' || !document.body) return
      const state = guideSessionState
      const step = readVisionGuideStep()
      if (step === undefined) {
        clearGuidePromptUI()
        return
      }
      const { phase, panelOpen, target } = refreshGuideResolution(step)
      const settingsPhase = state === GUIDE_STATE.SETTINGS || state === GUIDE_STATE.VISION_MODEL

      // Only the settings/vision states care about the Settings panel. Step 1
      // intentionally ignores a pre-existing panel, so closing Settings to get
      // back to chat can never kill the guide (#207).
      if (settingsPhase && guideSettingsPanelSeen && !panelOpen) {
        clearGuidePromptUI()
        scheduleGuidePanelCloseCheck(t)
        return
      }
      if (settingsPhase && panelOpen) {
        guideSettingsPanelSeen = true
        cancelGuidePanelCloseCheck()
      }

      if (state === GUIDE_STATE.SETTINGS && phase === 'done') {
        clearGuidePromptUI()
        dispatchGuide({ type: GUIDE_EVENT.TARGET_READY }, t)
        return
      }
      if (phase === 'none' || phase === 'done' || phase === 'suspend') {
        clearGuidePromptUI()
        return
      }

      if (!visionGuidePrompt || visionGuidePrompt.dataset.vrStep !== step) {
        if (visionGuidePrompt) visionGuidePrompt.remove()
        removeGuideSpotlight()
        visionGuidePrompt = buildGuidePrompt(t, step, phase)
        document.body.appendChild(visionGuidePrompt)
      } else if (visionGuidePrompt.dataset.vrPhase !== phase) {
        updateGuidePrompt(visionGuidePrompt, t, step, phase)
      }
      const rect =
        target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : undefined
      applyGuideSpotlight(rect)
      const menuOpen =
        phase === 'selector' &&
        typeof target !== 'undefined' &&
        typeof target.getAttribute === 'function' &&
        target.getAttribute('aria-expanded') === 'true'
      anchorGuidePrompt(visionGuidePrompt, step, phase, rect, menuOpen)
    }

    function ensureGuideRuntime(t = guideTranslator) {
      if (guideRuntimeDispose || readVisionGuideStep() === undefined) return
      if (typeof document === 'undefined' || typeof window === 'undefined' || !document.body) return
      if (t) guideTranslator = t
      const sync = () => scheduleGuideSync(guideTranslator)
      // Structural host changes must bypass the short geometry cache. With the
      // old 600ms keep-alive removed, swallowing the one mutation that opens or
      // closes Settings could otherwise leave the guide stuck forever.
      const resolveSync = () => {
        visionGuideResolved.at = 0
        scheduleGuideSync(guideTranslator)
      }
      window.addEventListener('popstate', resolveSync)
      window.addEventListener('resize', sync)
      document.addEventListener('scroll', sync, true)
      let observer
      const Observer = window.MutationObserver || globalThis.MutationObserver
      if (typeof Observer === 'function') {
        observer = new Observer(resolveSync)
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-expanded', 'aria-hidden', 'class'],
        })
      }
      guideRuntimeDispose = () => {
        window.removeEventListener('popstate', resolveSync)
        window.removeEventListener('resize', sync)
        document.removeEventListener('scroll', sync, true)
        if (observer && typeof observer.disconnect === 'function') observer.disconnect()
      }
      syncVisionGuidePrompt(guideTranslator)
    }

    function startVisionSettingsGuide(t) {
      guideTranslator = t || guideTranslator
      guideSettingsPanelSeen = false
      cancelGuidePanelCloseCheck()
      dispatchGuide({ type: GUIDE_EVENT.START }, guideTranslator)
    }
    function finishVisionSettingsGuide(options = {}) {
      const remember = options.remember === true || options.complete === true
      if (remember) rememberOnboardingSeen()
      dispatchGuide({ type: options.complete === true ? GUIDE_EVENT.COMPLETE : GUIDE_EVENT.CANCEL }, guideTranslator)
    }
    function installVisionSettingsGuide(t) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      guideTranslator = t
      if (readVisionGuideStep() !== undefined) ensureGuideRuntime(t)
      return () => {
        if (guideTranslator === t) guideTranslator = undefined
        stopGuideRuntime()
      }
    }

    let onboardingOverlay
    let onboardingOverlayAuto = false
    let onboardingKeyDown

    function dismissOnboarding(remember = true) {
      if (remember) rememberOnboardingSeen()
      if (typeof document !== 'undefined' && onboardingKeyDown) {
        document.removeEventListener('keydown', onboardingKeyDown)
      }
      onboardingKeyDown = undefined
      if (onboardingOverlay) onboardingOverlay.remove()
      onboardingOverlay = undefined
      onboardingOverlayAuto = false
      if (guideSessionState === GUIDE_STATE.OVERVIEW) {
        dispatchGuide({ type: remember ? GUIDE_EVENT.DISMISS : GUIDE_EVENT.LATER }, guideTranslator)
      }
    }
    function showOnboarding(t, options = {}) {
      if (typeof document === 'undefined' || !document.body) return
      if (onboardingOverlay) return
      guideTranslator = t || guideTranslator
      onboardingOverlayAuto = options.auto === true
      if (onboardingOverlayAuto) onboardingAutoPresented = true
      dispatchGuide({ type: GUIDE_EVENT.SHOW_OVERVIEW }, guideTranslator)

      const onKeyDown = (event) => {
        if (event && event.key === 'Escape') dismissOnboarding(true)
      }
      onboardingKeyDown = onKeyDown

      const overlay = document.createElement('div')
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
      close.addEventListener('click', () => dismissOnboarding(true))

      const actions = document.createElement('div')
      actions.className = 'vr-onboarding-actions'
      const secondary = document.createElement('button')
      secondary.type = 'button'
      secondary.className = 'vr-onboarding-secondary'
      secondary.textContent = t('onboardingLater')
      // "Later" really means later: suppress only this automatic presentation
      // for the current page; do not persist onboardingSeen.
      secondary.addEventListener('click', () => dismissOnboarding(false))
      const primary = document.createElement('button')
      primary.type = 'button'
      primary.className = 'vr-onboarding-primary'
      primary.textContent = t('onboardingGuide')
      primary.addEventListener('click', () => {
        // Starting the guide is not completion. Remove the overview without
        // writing durable state, then enter the explicit session state machine.
        dismissOnboarding(false)
        startVisionSettingsGuide(t)
      })
      actions.append(secondary, primary)

      dialog.append(title, body, steps, close, actions)
      overlay.appendChild(dialog)
      document.body.appendChild(overlay)
      document.addEventListener('keydown', onKeyDown)
      onboardingOverlay = overlay

      // Never steal focus from a field the user has already started using while
      // an asynchronous settings snapshot resolves. Manual replay may opt in.
      const focusWhenSafe = () => {
        const active = document.activeElement
        const pageIdle = !active || active === document.body || active === document.documentElement
        if ((options.focus === true || pageIdle) && typeof primary.focus === 'function') primary.focus()
      }
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(focusWhenSafe)
      } else {
        focusWhenSafe()
      }
    }
    function installOnboarding(t) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      const sync = () => {
        const disposition = readOnboardingDisposition()
        if (disposition === 'unknown') return
        clearLegacyGuidePersistence()
        if (disposition === 'seen') {
          // A late durable read may dismiss only the automatic first-run
          // overview. A user-requested replay is never killed by background IO.
          if (onboardingOverlay && onboardingOverlayAuto) dismissOnboarding(false)
          return
        }
        if (!onboardingAutoPresented && guideSessionState === GUIDE_STATE.IDLE && !onboardingOverlay) {
          showOnboarding(t, { auto: true })
        }
      }
      sync()
      const unsubscribe = settingsPersistence && settingsPersistence.subscribe(sync)
      return () => {
        if (typeof unsubscribe === 'function') unsubscribe()
        if (onboardingOverlay) dismissOnboarding(false)
      }
    }

    const LABEL_KEY = {
      routing: 'toggleRouting',
      reverseRouting: 'toggleReverseRouting',
      tool: 'toggleTool',
      structuredVisionBootstrap: 'toggleStructuredVisionBootstrap',
      autoWrapProviders: 'toggleAutoWrapProviders',
      rewriteImages: 'toggleRewriteImages',
      downscale: 'toggleDownscale',
      cache: 'toggleCache',
      freeFallback: 'toggleFreeFallback',
      freeCloudFirst: 'toggleFreeCloudFirst',
      desktopScreenshot: 'toggleDesktopScreenshot',
      stealth: 'toggleStealth',
      instantDescribe: 'toggleInstantDescribe',
      timeoutMs: 'numTimeoutMs',
      visionTaskTimeoutMs: 'numVisionTaskTimeoutMs',
      ocrTimeoutMs: 'numOcrTimeoutMs',
      downscaleMaxPixels: 'numDownscaleMaxPixels',
      cacheTtlSeconds: 'numCacheTtlSeconds',
      cacheMaxEntries: 'numCacheMaxEntries',
      wrapperRoute: 'textWrapperRoute',
      chainRoute: 'textChainRoute',
      visionDepth: 'selectVisionDepth',
      visionDepthMaxCalls: 'labelVisionDepthMaxCalls',
      guidanceOverrides: 'guidanceOverridesLabel',
      extraVisionModels: 'extraVisionModelsLabel',
      allowRemoteSettings: 'allowRemoteSettingsLabel',
    }
    const HINT_KEY = {
      routing: 'hintRouting',
      reverseRouting: 'hintReverseRouting',
      tool: 'hintTool',
      structuredVisionBootstrap: 'hintStructuredVisionBootstrap',
      autoWrapProviders: 'hintAutoWrapProviders',
      rewriteImages: 'hintRewriteImages',
      downscale: 'hintDownscale',
      cache: 'hintCache',
      freeFallback: 'hintFreeFallback',
      freeCloudFirst: 'hintFreeCloudFirst',
      desktopScreenshot: 'hintDesktopScreenshot',
      stealth: 'hintStealth',
      instantDescribe: 'hintInstantDescribe',
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
      const [failedFields, setFailedFields] = useState([])
      const [open, setOpen] = useState(props.surface === 'section')
      const [testState, setTestState] = useState({ status: 'idle' })
      const [updateState, setUpdateState] = useState({ status: 'idle', result: undefined })
      const [selfUpdateState, setSelfUpdateState] = useState({ status: 'idle', result: undefined })
      const [guideStep, setGuideStep] = useState(() => readVisionGuideStep())
      const guideTargetsVisionSettings = guideStep === 'step2'
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [showLocalVision, setShowLocalVision] = useState(false)
      const [catalog, setCatalog] = useState({ status: 'idle', groups: [], failures: [], error: undefined })
      const [visionCaps, setVisionCaps] = useState({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })
      const catalogGeneration = React.useRef(0)
      const visionCapsGeneration = React.useRef(0)
      const catalogReady = catalog.status === 'ready' && catalog.groups.length > 0
      // Keep this derived catalog stable: rebuilding it on every card render
      // invalidates the option memo and regresses large-catalog scroll smoothness.
      const visionGroups = useMemo(
        () => filterVisionBackendGroups(catalog.groups, visionCaps.capabilities),
        [catalog.groups, visionCaps.capabilities],
      )
      const hiddenVisionBackends = useMemo(
        () => collectFilteredVisionBackends(catalog.groups, visionCaps.capabilities),
        [catalog.groups, visionCaps.capabilities],
      )
      // Hooks must live at the component top level — the editor below is a
      // conditionally rendered plain function, so it must NOT call hooks
      // (a changing hook count across renders crashes React and takes the
      // whole settings card down). Derive the editor's option sets here.
      const hiddenVisionProviders = useMemo(
        () => [...new Set(hiddenVisionBackends.map((entry) => entry.provider))].sort(),
        [hiddenVisionBackends],
      )
      const hiddenVisionModelsOf = useMemo(() => {
        const byProvider = new Map()
        for (const entry of hiddenVisionBackends) {
          if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, [])
          byProvider.get(entry.provider).push(entry.model)
        }
        return byProvider
      }, [hiddenVisionBackends])
      const visionModelsFor = (providerId) => {
        const group = visionGroups.find((entry) => entry.id === providerId)
        return group && Array.isArray(group.models) ? group.models : []
      }
      const visionProviderVisible = (providerId) =>
        typeof providerId === 'string' && visionGroups.some((entry) => entry.id === providerId)
      const visionModelVisible = (providerId, modelId) =>
        typeof modelId === 'string' && visionModelsFor(providerId).some((entry) => entry.id === modelId)
      React.useEffect(() => {
        const refreshGuide = () => setGuideStep(readVisionGuideStep())
        window.addEventListener(VISION_GUIDE_EVENT, refreshGuide)
        refreshGuide()
        return () => window.removeEventListener(VISION_GUIDE_EVENT, refreshGuide)
      }, [])
      React.useEffect(() => {
        if (!guideTargetsVisionSettings) return
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
      }, [guideTargetsVisionSettings, open, catalog.status, visionCaps.status])
      React.useEffect(() => {
        const invalidate = () => {
          // Invalidate in-flight reads as well as cached ready state. Without
          // the generation bump, a pre-change request can resolve last and
          // restore the stale DeepSeek-only catalog after a provider is added.
          catalogGeneration.current += 1
          visionCapsGeneration.current += 1
          setCatalog({ status: 'idle', groups: [], failures: [], error: undefined })
          setVisionCaps({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })
        }
        const stopRemote = subscribeCatalogInvalidations(props.remote, invalidate)
        let stopConnectionReset
        try {
          if (typeof props.subscribeConnectionReset === 'function') {
            stopConnectionReset = props.subscribeConnectionReset(invalidate)
          }
        } catch {
          stopConnectionReset = undefined
        }
        return () => {
          stopRemote()
          if (typeof stopConnectionReset === 'function') stopConnectionReset()
        }
      }, [props.remote, props.subscribeConnectionReset])
      const loadCatalog = (force = false) => {
        if (!force && (catalog.status === 'loading' || catalog.status === 'ready')) return
        const generation = ++catalogGeneration.current
        setCatalog({ status: 'loading', groups: [], failures: [], error: undefined })
        try {
          const connection = props.getConnection ? props.getConnection() : undefined
          const api = connection && connection.api
          const modelsFn = api && api.llm && typeof api.llm.models === 'function' ? api.llm.models : undefined
          if (modelsFn === undefined) {
            if (generation !== catalogGeneration.current) return
            setCatalog({ status: 'error', groups: [], failures: [], error: t('catalogUnavailable') })
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
              if (generation !== catalogGeneration.current) return
              setCatalog(catalogStateFromValue(value, t))
            },
            (error) => {
              if (generation !== catalogGeneration.current) return
              setCatalog({
                status: 'error',
                groups: [],
                failures: [],
                error: error && error.message ? error.message : String(error),
              })
            },
          )
        } catch (error) {
          if (generation !== catalogGeneration.current) return
          setCatalog({
            status: 'error',
            groups: [],
            failures: [],
            error: error && error.message ? error.message : String(error),
          })
        }
      }
      const loadVisionCapabilities = (force = false, silent = false) => {
        if (!force && (visionCaps.status === 'loading' || visionCaps.status === 'ready')) return
        const generation = ++visionCapsGeneration.current
        // Silent refresh (after saving/resetting the extraVisionModels
        // override) keeps the current capabilities on screen while the new
        // snapshot is fetched — a visible loading state here blanks the
        // dropdown and the hidden-models panel, which reads as a full page
        // refresh and churns the scroll.
        if (!silent) {
          setVisionCaps({ status: 'loading', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })
        }
        fetch('/_dsh/vision-router/model-capabilities')
          .then(async (response) => {
            const body = await response.json().catch(() => undefined)
            if (!response.ok) {
              throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
            }
            return body
          })
          .then(
            (body) => {
              if (generation !== visionCapsGeneration.current) return
              setVisionCaps({
                status: 'ready',
                capabilities: body && body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {},
                builtinFallback: body && Array.isArray(body.builtinFallback) ? body.builtinFallback : [],
                anonymousRpmPerModel: body && Number.isFinite(body.anonymousRpmPerModel) ? body.anonymousRpmPerModel : 2,
                error: undefined,
              })
            },
            (error) => {
              if (generation !== visionCapsGeneration.current) return
              setVisionCaps({
                status: 'error',
                capabilities: {},
                builtinFallback: [],
                anonymousRpmPerModel: 2,
                error: error && error.message ? error.message : String(error),
              })
            },
          )
      }
      const retryVisionModels = () => {
        setCatalog({ status: 'idle', groups: [], failures: [], error: undefined })
        setVisionCaps({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })
        loadCatalog(true)
        loadVisionCapabilities(true)
      }
      let snapshot
      let renderError
      try {
        snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
      } catch (error) {
        renderError = error
      }
      const h = React.createElement
      // The model catalog can carry hundreds of models per provider (e.g.
      // openrouter), so the option vnode lists are built once per catalog /
      // selection instead of on every render, and the per-provider model
      // lists are cached by the models-array identity.
      const modelOptionCache = React.useRef(new Map())
      const modelOptionsOf = (models) => {
        if (!Array.isArray(models) || models.length === 0) return []
        let list = modelOptionCache.current.get(models)
        if (list === undefined) {
          list = models.map((model) =>
            h('option', { value: model.id, key: model.id },
              (model.name && model.name !== model.id ? model.name + ' (' + model.id + ')' : model.id)),
          )
          modelOptionCache.current.set(models, list)
        }
        return list
      }
      const groupOptions = useMemo(
        () => catalog.groups
          .filter((group) => group.id !== 'vision-http')
          .map((group) => h('option', { value: group.id, key: group.id },
            (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id))),
        [catalog.groups],
      )
      const visionGroupOptions = useMemo(
        () => visionGroups.map((group) => h('option', { value: group.id, key: group.id },
            (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id))),
        [visionGroups],
      )
      const chainRouteValue = readValue(snapshot, 'chainRoute')
      const wrapperRouteValue = readValue(snapshot, 'wrapperRoute')
      const wrapGroupOptions = useMemo(
        () => {
          const chainValue = chainRouteValue
          const wrapperValue = wrapperRouteValue
          const excluded = new Set([
            'vision-http',
            typeof chainValue === 'string' && chainValue !== '' ? chainValue : 'vision-chain',
            typeof wrapperValue === 'string' && wrapperValue !== '' ? wrapperValue : 'deepseek-vision',
          ])
          return catalog.groups
            .filter((group) => {
              if (group.id === 'deepseek-official') return true
              if (excluded.has(group.id)) return false
              if (group.id.endsWith('-vision')) return false
              return true
            })
            .map((group) => h('option', { value: group.id, key: group.id },
              (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id)))
        },
        [catalog.groups, chainRouteValue, wrapperRouteValue],
      )
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
        if (props.surface === 'section' && snapshot && snapshot.mode === 'remote' && snapshot.status === 'unavailable') {
          const disabled = snapshot.remoteReason === 'permission-disabled'
          const initializing = snapshot.remoteReason === 'namespace-unavailable'
          const proxyMissing = snapshot.remoteErrorCode === 'remote-route-missing'
          const titleKey = initializing
            ? 'remoteSettingsInitializingTitle'
            : disabled ? 'remoteSettingsDisabledTitle' : 'remoteSettingsUnavailableTitle'
          const bodyKey = initializing
            ? 'remoteSettingsInitializingBody'
            : proxyMissing ? 'remoteSettingsProxyBody'
              : disabled ? 'remoteSettingsDisabledBody' : 'remoteSettingsUnavailableBody'
          return h('li', { className: 'vr-card vr-card-open' },
            h('div', { className: 'vr-body' },
              h('div', { className: 'vr-quickstart' },
                h('div', { className: 'vr-quickstart-title' }, t(titleKey)),
                h('p', { className: 'vr-quickstart-body' }, t(bodyKey)),
                snapshot.remoteError && !disabled && !initializing && !proxyMissing
                  ? h('p', { className: 'vr-failed' }, snapshot.remoteError)
                  : null,
                h('button', {
                  type: 'button', className: 'vr-btn',
                  onClick: () => { void (typeof scope.reload === 'function' ? scope.reload() : scope.load()) },
                }, t('remoteSettingsRetry')),
              ),
            ),
          )
        }
        // Local built-in settings cards keep their existing unavailable behavior.
        return null
      }
      const writable = snapshot.writable
      const remoteMode = snapshot.mode === 'remote'
      const editBlocked = !writable || saving

      const format = (key) => {
        if (key in drafts) return drafts[key]
        const value = readValue(snapshot, key)
        if (key === 'providers') {
          if (catalogReady) return normalizeVisionChainRows(value)
          return providersToText(value)
        }
        if (key === 'textProvider') {
          if (catalogReady) {
            return value && typeof value === 'object' ? value : { provider: '', model: '' }
          }
          return textProviderToText(value)
        }
        if (key === 'proxyHosts') return Array.isArray(value) ? value.join('\n') : ''
        if (key === 'extraVisionModels') {
          if (!Array.isArray(value)) return ''
          return value
            .map((entry) =>
              entry && typeof entry === 'object'
                ? entry.provider && entry.model
                  ? `${entry.provider}/${entry.model}`
                  : ''
                : String(entry ?? '').trim(),
            )
            .filter((entry) => entry !== '')
            .join('\n')
        }
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
        if (NUMBER_KEYS.includes(key) || DEPTH_NUMBER_KEYS.includes(key)) return typeof value === 'number' ? String(value) : ''
        if (ALL_TOGGLE_KEYS.includes(key)) return value === true
        if (key === 'guidanceOverrides') {
          if (!Array.isArray(value)) return []
          return value
            .filter((entry) => entry && typeof entry.kind === 'string' && entry.kind !== '')
            .map((entry) => ({ kind: entry.kind, text: typeof entry.text === 'string' ? entry.text : '' }))
        }
        if (key === 'localOllama') {
          return normalizeLocalProviderDraft(value, LOCAL_PROVIDER_DEFAULTS.localOllama)
        }
        if (key === 'localLmStudio') {
          return normalizeLocalProviderDraft(value, LOCAL_PROVIDER_DEFAULTS.localLmStudio)
        }
        if (key === 'localDescribeStyle') return value === 'structured' ? 'structured' : 'plain'
        if (SELECT_KEYS.includes(key)) {
          if (value === 'custom') return 'standard'
          return value === 'fast' || value === 'standard' || value === 'deep' ? value : 'standard'
        }
        return typeof value === 'string' ? value : ''
      }
      const parse = (key, text) => {
        if (ALL_TOGGLE_KEYS.includes(key)) return { value: text === true }
        if (key === 'providers') {
          if (catalogReady) {
            const rows = normalizeVisionChainRows(text)
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
        if (NUMBER_KEYS.includes(key) || DEPTH_NUMBER_KEYS.includes(key)) {
          return parseNumber(text, NUMBER_META[key].min, NUMBER_META[key].max)
        }
        if (key === 'guidanceOverrides') {
          const rows = Array.isArray(text) ? text : []
          const cleaned = []
          for (const row of rows) {
            if (!row || typeof row !== 'object') return undefined
            const kind = typeof row.kind === 'string' ? row.kind.trim() : ''
            const textValue = typeof row.text === 'string' ? row.text.trim() : ''
            if (kind === '') {
              if (textValue !== '') return undefined
              continue // 空模板行
            }
            if (textValue === '') return undefined
            cleaned.push({ kind, text: textValue })
          }
          return cleaned.length > 0 ? { value: cleaned } : { clear: true }
        }
        if (key === 'localOllama') {
          return {
            value: parseLocalProviderDraft(text, LOCAL_PROVIDER_DEFAULTS.localOllama),
          }
        }
        if (key === 'localLmStudio') {
          const value = parseLocalProviderDraft(text, LOCAL_PROVIDER_DEFAULTS.localLmStudio)
          return value.enabled && value.model === '' ? undefined : { value }
        }
        if (key === 'localDescribeStyle') {
          return text === 'structured' || text === 'plain' ? { value: text } : undefined
        }
        if (SELECT_KEYS.includes(key)) {
          return text === 'fast' || text === 'standard' || text === 'deep' ? { value: text } : undefined
        }
        if (key === 'proxyHosts') {
          const list = String(text ?? '')
            .split('\n')
            .map((host) => host.trim())
            .filter((host) => host !== '')
          return list.length > 0 ? { value: list } : { clear: true }
        }
        if (key === 'extraVisionModels') {
          // The dropdown editor drafts rows of { provider, model } objects
          // (an incomplete row stays visible until the user picks both);
          // string entries are the legacy/free-text shape. Both are accepted.
          if (Array.isArray(text)) {
            const half = text.some((row) => {
              if (!row || typeof row !== 'object') return false
              return row.provider ? !row.model : !!row.model
            })
            if (half) return undefined
            const list = text
              .map((row) => {
                if (row && typeof row === 'object') {
                  return row.provider && row.model ? `${row.provider}/${row.model}` : ''
                }
                return String(row ?? '').trim()
              })
              .filter((entry) => entry !== '')
            return list.length > 0 ? { value: list } : { clear: true }
          }
          const list = String(text ?? '')
            .split(/[\n,]+/)
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '')
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
        .map((key) => ({ key, run: canonicalizeSettingsRun(key, parse(key, drafts[key])) }))
        .filter((item) => item.run !== undefined)
      const dirty = Object.keys(drafts).length > 0
      const invalid = plan.length !== Object.keys(drafts).length
      const blocked = !dirty || invalid || saving || !writable

      const setDraft = (key, text) => {
        setFailed(false)
        setFailedFields([])
        setDrafts((prev) => ({ ...prev, [key]: text }))
      }
      const clearDrafts = () => {
        setDrafts({})
        setFailed(false)
        setFailedFields([])
      }
      const save = async () => {
        if (blocked) return
        setSaving(true)
        setFailed(false)
        setFailedFields([])
        try {
          const outcome = await commitSettingsPlan(scope, plan, drafts)
          if (outcome.landedFields.length > 0) setDrafts(outcome.nextDrafts)
          if (guideTargetsVisionSettings && outcome.landed) finishGuide()
          if (outcome.failed) reportSettingsSaveFailures(outcome.failures)
          setFailed(outcome.failed)
          setFailedFields(outcome.failed ? [...new Set(outcome.failures.map((failure) => failure.field))] : [])
          // The extraVisionModels override changes which models count as vision
          // backends: refresh the capability map so the dropdown reflects the
          // saved override immediately.
          if (outcome.landedFields.includes('extraVisionModels')) {
            loadVisionCapabilities(true, true)
          }
          if (
            outcome.landedFields.includes('desktopScreenshot') &&
            plan.some((item) => item.key === 'desktopScreenshot' && item.run && item.run.value === true)
          ) {
            requestDesktopScreenshotPermission()
          }
        } catch (error) {
          reportSettingsSaveFailures([{
            field: 'settings-plan',
            operation: 'set',
            reason: 'write-error',
            detail: settingsSaveErrorMessage(error),
          }])
          setFailed(true)
          setFailedFields(['settings-plan'])
        } finally {
          setSaving(false)
        }
      }
      const resetField = async (key) => {
        if (editBlocked) return
        setFailed(false)
        setFailedFields([])
        setSaving(true)
        try {
          const outcome = await commitSettingsPlan(scope, [{ key, run: { clear: true } }], drafts)
          if (!outcome.landed) {
            reportSettingsSaveFailures(outcome.failures)
            setFailed(true)
            setFailedFields([...new Set(outcome.failures.map((failure) => failure.field))])
            return
          }
          setDrafts((prev) => {
            const next = { ...prev }
            delete next[key]
            return next
          })
          if (key === 'extraVisionModels') loadVisionCapabilities(true, true)
        } catch (error) {
          reportSettingsSaveFailures([{
            field: key,
            operation: 'unset',
            reason: 'write-error',
            detail: settingsSaveErrorMessage(error),
          }])
          setFailed(true)
          setFailedFields([key])
        } finally {
          setSaving(false)
        }
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

      const requestDesktopScreenshotPermission = () => {
        // Fire-and-forget: saving the setting must stay responsive while macOS
        // owns the native permission dialog. The tool itself still reports a
        // real capture failure if the user denies access.
        void fetch('/_dsh/vision-router/request-screenshot-permission', {
          method: 'POST',
          cache: 'no-store',
        }).catch(() => {})
      }

      const diagnosticError = (value, fallback) => {
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
        if (value && typeof value.message === 'string' && value.message.trim() !== '') {
          return value.message.trim()
        }
        return fallback
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
            throw new Error(diagnosticError(result && result.error, `HTTP ${response.status}`))
          }
          if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
            throw new Error(t('updateInvalidResponse'))
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
            throw new Error(diagnosticError(result && result.error, `HTTP ${response.status}`))
          }
          if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
            throw new Error(t('updateInvalidResponse'))
          }
          setSelfUpdateState({ status: 'done', result })
        } catch (error) {
          setSelfUpdateState({
            status: 'error',
            result: { ok: false, error: error && error.message ? error.message : String(error) },
          })
        }
      }

      const overriddenBadge = (key) =>
        userHas(snapshot, key)
          ? h('span', { className: 'vr-badges' },
              h('span', { className: 'vr-badge' }, t('overridden')),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: editBlocked,
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
                disabled: editBlocked,
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
            value: format(key), disabled: editBlocked,
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
      const selectField = (key, label, hint, options) => {
        const invalidField = key in drafts && parse(key, drafts[key]) === undefined
        return h('div', { className: 'vr-field', key },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, label),
            overriddenBadge(key),
          ),
          h('select', {
            className: 'vr-input vr-select' + (invalidField ? ' vr-input-invalid' : ''),
            'data-vr-depth-strategy': key === 'visionDepth' ? '1' : undefined,
            value: format(key), disabled: editBlocked,
            onChange: (event) => setDraft(key, event.target.value),
          },
            options.map((option) => h('option', { value: option.value, key: option.value }, option.label)),
          ),
          invalidField
            ? h('p', { className: 'vr-invalid' }, t('invalidGeneric'))
            : hint
              ? h('p', { className: 'vr-hint' }, hint)
              : null,
        )
      }
      const depthCapField = () => {
        const key = 'visionDepthMaxCalls'
        const raw = format(key)
        const parsed = Number(raw)
        const enabled = Number.isInteger(parsed) && parsed > 0
        const invalidField = key in drafts && parse(key, drafts[key]) === undefined
        const savedRaw = Number(readValue(snapshot, key))
        const savedCap = Number.isInteger(savedRaw) && savedRaw >= 1 && savedRaw <= 100 ? savedRaw : 4
        return h('div', { className: 'vr-field', key, 'data-vr-depth-cap': '1' },
          h('div', { className: 'vr-field-head' },
            h('div', { className: 'vr-toggle' },
              h('span', { className: 'vr-label' }, t('depthCapTitle')),
              h('input', {
                type: 'checkbox', className: 'vr-check', checked: enabled,
                'data-vr-depth-cap-toggle': '1', disabled: editBlocked,
                onChange: (event) => setDraft(key, event.target.checked ? String(savedCap) : '0'),
              }),
            ),
            overriddenBadge(key),
          ),
          h('p', { className: 'vr-hint' }, t('depthCapHint')),
          enabled
            ? h('div', { className: 'vr-local-row' },
                h('label', { className: 'vr-label vr-local-label' }, t('depthCapValueLabel')),
                h('input', {
                  className: 'vr-input' + (invalidField ? ' vr-input-invalid' : ''),
                  type: 'number', min: 1, max: 100, step: 1, value: raw,
                  'data-vr-depth-cap-value': '1', disabled: editBlocked,
                  onChange: (event) => setDraft(key, event.target.value),
                }),
                invalidField
                  ? h('p', { className: 'vr-invalid' }, t('depthCapInvalid'))
                  : null,
              )
            : null,
        )
      }

      // 自定义识图引导编辑器：每行 [图片类型 select] [引导语 input] [移除]，+ 添加。
      const GUIDANCE_KIND_OPTIONS = [
        { value: 'code', label: 'code（代码）' },
        { value: 'document', label: 'document（文档）' },
        { value: 'ui', label: 'ui（界面）' },
        { value: 'chat', label: 'chat（聊天）' },
        { value: 'person', label: 'person（人物）' },
        { value: 'animal', label: 'animal（动物）' },
        { value: 'plant', label: 'plant（植物）' },
        { value: 'food', label: 'food（食物）' },
        { value: 'vehicle', label: 'vehicle（交通工具）' },
        { value: 'machine', label: 'machine（机器）' },
        { value: 'architecture', label: 'architecture（建筑）' },
        { value: 'object', label: 'object（物品）' },
        { value: 'scene', label: 'scene（场景）' },
        { value: 'meme', label: 'meme（表情包）' },
      ]
      const guidanceOverridesEditor = () => {
        const rows = format('guidanceOverrides')
        const updateRow = (index, patch) => {
          const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
          setDraft('guidanceOverrides', next)
        }
        const removeRow = (index) => {
          const next = rows.filter((_, i) => i !== index)
          setDraft('guidanceOverrides', next.length > 0 ? next : [])
        }
        return h('div', { className: 'vr-field', key: 'guidanceOverrides' },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('guidanceOverridesLabel')),
            overriddenBadge('guidanceOverrides'),
          ),
          rows.map((row, index) =>
            h('div', { className: 'vr-chain-row', key: index },
              h('select', {
                className: 'vr-input vr-select', value: row.kind ?? '', disabled: editBlocked,
                onChange: (event) => updateRow(index, { kind: event.target.value }),
              },
                h('option', { value: '' }, t('selectKind')),
                GUIDANCE_KIND_OPTIONS.map((option) =>
                  h('option', { value: option.value, key: option.value }, option.label)),
              ),
              h('input', {
                className: 'vr-input', value: row.text ?? '', disabled: editBlocked,
                placeholder: t('guidanceOverridePlaceholder'),
                onChange: (event) => updateRow(index, { text: event.target.value }),
              }),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: editBlocked, title: t('removeTitle'),
                onClick: () => removeRow(index),
              }, t('remove')),
            ),
          ),
          h('button', {
            type: 'button', className: 'vr-btn', disabled: editBlocked,
            onClick: () => setDraft('guidanceOverrides', [...rows, { kind: '', text: '' }]),
          }, t('addGuidanceOverride')),
          h('p', { className: 'vr-hint' }, t('guidanceOverridesHint')),
        )
      }

      const modelsOf = (providerId) => {
        const group = catalog.groups.find((entry) => entry.id === providerId)
        return group && Array.isArray(group.models) ? group.models : []
      }
      // 折叠摘要只描述启用的本地后端。首遍识别是否自动运行由
      // structuredVisionBootstrap 统一控制，不再暴露第二套即时识图/输出风格状态。
      const localVisionSummary = () => {
        const ollama = format('localOllama') || {}
        const lmStudio = format('localLmStudio') || {}
        if (ollama.enabled !== true && lmStudio.enabled !== true) return t('localVisionOff')
        const parts = [t('localVisionOn')]
        if (ollama.enabled === true) parts.push(`Ollama ${ollama.model || 'qwen2.5vl'}`)
        if (lmStudio.enabled === true) {
          parts.push(
            lmStudio.model
              ? `LM Studio ${lmStudio.model}`
              : `LM Studio ${t('localModelRequiredShort')}`,
          )
        }
        return parts.join(' · ')
      }
      // dsh-vision 并入：本地 Ollama 编辑器（enabled + baseURL + model，合并
      // 成一个 localOllama 对象 draft）。
      const localOllamaEditor = () => {
        const value = format('localOllama')
        const update = (patch) => setDraft('localOllama', { ...value, ...patch })
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('div', { className: 'vr-toggle' },
              h('span', { className: 'vr-label' }, t('localOllamaEnabled')),
              h('input', {
                type: 'checkbox', className: 'vr-check', checked: value.enabled === true,
                disabled: editBlocked,
                onChange: (event) => update({ enabled: event.target.checked }),
              }),
            ),
            overriddenBadge('localOllama'),
          ),
          h('div', { className: 'vr-local-row' },
            h('label', { className: 'vr-label vr-local-label' }, t('localOllamaBaseURL')),
            h('input', {
              className: 'vr-input', value: value.baseURL, disabled: editBlocked,
              placeholder: 'http://127.0.0.1:11434/v1',
              onChange: (event) => update({ baseURL: event.target.value }),
            }),
          ),
          h('div', { className: 'vr-local-row' },
            h('label', { className: 'vr-label vr-local-label' }, t('localOllamaModel')),
            h('input', {
              className: 'vr-input', value: value.model, disabled: editBlocked,
              placeholder: 'qwen2.5vl',
              onChange: (event) => update({ model: event.target.value }),
            }),
          ),
          h('div', { className: 'vr-local-row' },
            h('label', { className: 'vr-label vr-local-label' }, t('localRequestFormat')),
            h('select', {
              className: 'vr-input vr-select', value: value.format, disabled: editBlocked,
              onChange: (event) => update({ format: event.target.value }),
            },
              h('option', { value: 'openai' }, t('localFormatOpenAI')),
              h('option', { value: 'anthropic' }, t('localFormatAnthropic')),
            ),
          ),
          h('div', { className: 'vr-local-row vr-local-row-pair' },
            h('label', { className: 'vr-label vr-local-label' }, t('localOllamaTemperature')),
            h('input', {
              className: 'vr-input', value: value.temperature === undefined ? '' : String(value.temperature),
              disabled: editBlocked, placeholder: t('localTemperaturePlaceholder'), type: 'number', step: '0.1', min: '0', max: '2',
              onChange: (event) => update({
                temperature: event.target.value === '' ? undefined : Number(event.target.value),
              }),
            }),
            h('label', { className: 'vr-label vr-local-label' }, t('localOllamaTopP')),
            h('input', {
              className: 'vr-input', value: value.top_p === undefined ? '' : String(value.top_p),
              disabled: editBlocked, placeholder: t('localTopPPlaceholder'), type: 'number', step: '0.05', min: '0', max: '1',
              onChange: (event) => update({
                top_p: event.target.value === '' ? undefined : Number(event.target.value),
              }),
            }),
          ),
          h('p', { className: 'vr-hint' }, t('hintLocalOllama')),
        )
      }
      // dsh-vision 并入：本地 LM Studio 视觉后端（与 Ollama 同层级）。
      const localLmStudioEditor = () => {
        const value = format('localLmStudio')
        const update = (patch) => setDraft('localLmStudio', { ...value, ...patch })
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('div', { className: 'vr-toggle' },
              h('span', { className: 'vr-label' }, t('localLmStudioEnabled')),
              h('input', {
                type: 'checkbox', className: 'vr-check', checked: value.enabled === true,
                disabled: editBlocked,
                onChange: (event) => update({ enabled: event.target.checked }),
              }),
            ),
            overriddenBadge('localLmStudio'),
          ),
          h('div', { className: 'vr-local-row' },
            h('label', { className: 'vr-label vr-local-label' }, t('localLmStudioBaseURL')),
            h('input', {
              className: 'vr-input', value: value.baseURL, disabled: editBlocked,
              placeholder: 'http://localhost:1234/v1',
              onChange: (event) => update({ baseURL: event.target.value }),
            }),
          ),
          h('div', { className: 'vr-local-row' },
            h('label', { className: 'vr-label vr-local-label' }, t('localLmStudioModel')),
            h('input', {
              className: 'vr-input', value: value.model, disabled: editBlocked,
              placeholder: t('localLmStudioModelPlaceholder'),
              onChange: (event) => update({ model: event.target.value }),
            }),
          ),
          value.enabled === true && String(value.model || '').trim() === ''
            ? h('p', { className: 'vr-invalid' }, t('localLmStudioModelRequired'))
            : null,
          h('div', { className: 'vr-local-row' },
            h('label', { className: 'vr-label vr-local-label' }, t('localRequestFormat')),
            h('select', {
              className: 'vr-input vr-select', value: value.format, disabled: editBlocked,
              onChange: (event) => update({ format: event.target.value }),
            },
              h('option', { value: 'openai' }, t('localFormatOpenAI')),
              h('option', { value: 'anthropic' }, t('localFormatAnthropic')),
            ),
          ),
          h('div', { className: 'vr-local-row vr-local-row-pair' },
            h('label', { className: 'vr-label vr-local-label' }, t('localLmStudioTemperature')),
            h('input', {
              className: 'vr-input', value: value.temperature === undefined ? '' : String(value.temperature),
              disabled: editBlocked, placeholder: t('localTemperaturePlaceholder'), type: 'number', step: '0.1', min: '0', max: '2',
              onChange: (event) => update({
                temperature: event.target.value === '' ? undefined : Number(event.target.value),
              }),
            }),
            h('label', { className: 'vr-label vr-local-label' }, t('localLmStudioTopP')),
            h('input', {
              className: 'vr-input', value: value.top_p === undefined ? '' : String(value.top_p),
              disabled: editBlocked, placeholder: t('localTopPPlaceholder'), type: 'number', step: '0.05', min: '0', max: '1',
              onChange: (event) => update({
                top_p: event.target.value === '' ? undefined : Number(event.target.value),
              }),
            }),
          ),
          h('p', { className: 'vr-hint' }, t('hintLocalLmStudio')),
        )
      }
      const finishGuide = () => {
        finishVisionSettingsGuide({ complete: true })
        setGuideStep(undefined)
      }
      const guideCallout = () =>
        guideStep === 'step2'
          ? h('div', { className: 'vr-guide-callout' },
              h('div', { className: 'vr-guide-callout-title' }, t('guideChainTitle')),
              h('p', { className: 'vr-guide-callout-body' }, t('guideChainBody')),
              h('button', { type: 'button', className: 'vr-btn vr-btn-save', onClick: finishGuide }, t('guideDone')),
            )
          : null
      const chainEditor = () => {
        const value = format('providers')
        const rows = Array.isArray(value) && value.length > 0
          ? value
          : [{ provider: '', model: '', fallbacks: [] }]
        const invalidRows = catalogReady
          ? rows.filter((row) => row && row.provider && row.model && !visionModelVisible(row.provider, row.model))
          : []
        const advisoryRows = rows
          .filter((row) => row && row.provider && row.model && visionModelVisible(row.provider, row.model))
          .map((row) => {
            const capability =
              visionCaps.capabilities && visionCaps.capabilities[row.provider]
                ? visionCaps.capabilities[row.provider][row.model]
                : undefined
            const warningKey = visionCapabilityWarningKey(capability, visionCaps.status)
            return warningKey ? { ...row, warningKey } : undefined
          })
          .filter(Boolean)
        const updateChain = (index, next) => {
          const list = rows.map((row) => ({ ...row }))
          list[index] = next
          setDraft('providers', list)
        }
        const removeChain = (index) => {
          const list = rows.filter((_row, i) => i !== index)
          setDraft(
            'providers',
            list.length > 0 ? list : [{ provider: '', model: '', fallbacks: [] }],
          )
        }
        return h('div', {
          className: 'vr-field' + (guideStep === 'step2' ? ' vr-guide-target' : ''),
          id: 'vr-vision-backend-chain',
          'data-vr-guide-target': 'vision-backend',
          tabIndex: guideStep === 'step2' ? -1 : undefined,
        },
          guideCallout(),
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('chainLabel')),
            overriddenBadge('providers'),
          ),
          catalog.status === 'ready' && Array.isArray(catalog.failures) && catalog.failures.length > 0
            ? h('div', { className: 'vr-catalog-error' },
                h('p', { className: 'vr-hint vr-stealth-notice' },
                  t('catalogPartialFailure', { detail: catalogFailureDetail(catalog.failures) }),
                ),
                h('button', {
                  type: 'button', className: 'vr-btn',
                  disabled: catalog.status === 'loading' || visionCaps.status === 'loading',
                  onClick: retryVisionModels,
                }, t('retryCatalog')),
              )
            : null,
          rows.map((row, index) =>
            h('div', { className: 'vr-chain-row', key: index },
              h('select', {
                className: 'vr-input vr-select', value: visionProviderVisible(row.provider) ? row.provider : '', disabled: editBlocked,
                onChange: (event) => updateChain(index, {
                  ...row,
                  provider: event.target.value,
                  model: '',
                  fallbacks: row.fallbacks === undefined ? [] : row.fallbacks,
                }),
              },
                h('option', { value: '' }, t('selectProvider')),
                visionGroupOptions,
              ),
              h('select', {
                className: 'vr-input vr-select', value: visionModelVisible(row.provider, row.model) ? row.model : '',
                disabled: editBlocked || !visionProviderVisible(row.provider),
                onChange: (event) => {
                  updateChain(index, {
                    ...row,
                    provider: row.provider,
                    model: event.target.value,
                    fallbacks: row.fallbacks === undefined ? [] : row.fallbacks,
                  })
                },
              },
                h('option', { value: '' }, visionProviderVisible(row.provider) ? t('selectModel') : t('pickProviderFirst')),
                modelOptionsOf(visionModelsFor(row.provider)),
              ),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: editBlocked, title: t('removeTitle'),
                onClick: () => removeChain(index),
              }, t('remove')),
            ),
          ),
          advisoryRows.map((row) =>
            h('p', { className: 'vr-hint vr-stealth-notice', key: `cap-${row.provider}/${row.model}` },
              `${row.provider}/${row.model} — ${t(row.warningKey)}`,
            ),
          ),
          invalidRows.length > 0
            ? h('p', { className: 'vr-invalid' },
                t('chainInvalidCurrent') + ' ' + invalidRows.map((row) => row.provider + '/' + row.model).join('、'))
            : null,
          h('button', {
            type: 'button', className: 'vr-btn', disabled: editBlocked,
            onClick: () => setDraft('providers', [
              ...rows,
              { provider: '', model: '', fallbacks: [] },
            ]),
          }, t('addFallback')),
          h('p', { className: 'vr-hint' }, t('chainHint')),
        )
      }
      const emptyVisionModelsPanel = () => {
        if (!(catalogReady && visionCaps.status === 'ready' && visionGroups.length === 0 && hiddenVisionBackends.length > 0)) {
          return null
        }
        const preview = hiddenVisionBackends.slice(0, 8)
        const remaining = hiddenVisionBackends.length - preview.length
        const hasMissingDeclaration = hiddenVisionBackends.some((entry) => entry.missingImageDeclaration)
        return h('div', { className: 'vr-vision-empty' },
          h('p', { className: 'vr-vision-empty-title' }, t('visionCapsEmptyTitle')),
          h('p', { className: 'vr-hint' }, t('visionCapsEmptyBody', { count: hiddenVisionBackends.length })),
          h('p', { className: 'vr-hint' }, t('visionCapsHiddenPrefix')),
          h('ul', { className: 'vr-vision-empty-list' },
            preview.map((entry) =>
              h('li', { key: entry.provider + '/' + entry.model },
                entry.provider + '/' + entry.model + ' — ' +
                  t(entry.missingImageDeclaration ? 'visionCapsReasonMissingImage' : 'visionCapsReasonUnverified')),
            ),
            remaining > 0 ? h('li', { key: 'more' }, t('visionCapsHiddenMore', { count: remaining })) : null,
          ),
          hasMissingDeclaration
            ? h('p', { className: 'vr-hint vr-stealth-notice' }, t('visionCapsMissingImageHint'))
            : null,
          h('div', { className: 'vr-vision-empty-actions' },
            h('button', {
              type: 'button', className: 'vr-btn',
              disabled: catalog.status === 'loading' || visionCaps.status === 'loading',
              onClick: retryVisionModels,
            }, t('visionCapsRetry')),
          ),
        )
      }
      const extraVisionModelsEditor = () => {
        const raw = 'extraVisionModels' in drafts
          ? drafts['extraVisionModels']
          : readValue(snapshot, 'extraVisionModels')
        // Rows persist as { provider, model } objects while editing — an
        // incomplete row (provider picked, model pending) stays visible
        // instead of collapsing, which is what made the provider dropdown
        // feel unselectable before. Like the vision backend chain above, an
        // empty configuration still renders one blank row ready to fill.
        const rows = (Array.isArray(raw) && raw.length > 0 ? raw : [{ provider: '', model: '' }]).map(
          (entry) => {
            if (entry && typeof entry === 'object') {
              return {
                provider: String(entry.provider ?? '').trim(),
                model: String(entry.model ?? '').trim(),
              }
            }
            const text = String(entry ?? '').trim()
            const slash = text.indexOf('/')
            return slash === -1
              ? { provider: '', model: text }
              : { provider: text.slice(0, slash), model: text.slice(slash + 1) }
          },
        )
        // Same two-select row shape as the vision backend chain above: a
        // provider dropdown (providers that have excluded models) and a model
        // dropdown (that provider's excluded models). A row the user already
        // selected elsewhere stays disabled in the other rows. Option sets
        // come from the memoized top-level hooks (this function is plain
        // render code and must stay hook-free).
        const hiddenProviders = hiddenVisionProviders
        const hiddenModelsOf = hiddenVisionModelsOf
        const used = new Set(
          rows
            .filter((row) => row.provider !== '' && row.model !== '')
            .map((row) => `${row.provider}/${row.model}`),
        )
        // Never merge the empty current value into the option list: that
        // produced a duplicate blank option right below the placeholder.
        const providerOptions = (current) => {
          const options =
            current !== '' && !hiddenProviders.includes(current)
              ? [...hiddenProviders, current].sort()
              : hiddenProviders
          return options.map((provider) => h('option', { value: provider, key: provider }, provider))
        }
        const modelOptions = (row) => {
          const listed = hiddenModelsOf.get(row.provider) ?? []
          const options =
            row.model !== '' && !listed.includes(row.model)
              ? [...listed, row.model].sort()
              : listed
          return options.map((model) => {
            const key = `${row.provider}/${model}`
            return h('option', {
              value: model,
              key,
              disabled: key !== `${row.provider}/${row.model}` && used.has(key),
            }, model)
          })
        }
        const update = (index, next) => {
          const list = rows.map((row, i) => (i === index ? next : row))
          setDraft('extraVisionModels', list)
        }
        const removeRow = (index) => {
          const list = rows.filter((_row, i) => i !== index)
          setDraft('extraVisionModels', list)
        }
        // A half-filled row (provider picked, model pending) keeps the field
        // invalid — same rule as the vision backend chain above.
        const hasHalfRow = rows.some((row) => (row.provider ? !row.model : !!row.model))
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('extraVisionModelsLabel')),
            overriddenBadge('extraVisionModels'),
          ),
          rows.map((row, index) =>
            h('div', { className: 'vr-chain-row', key: index },
              h('select', {
                className: 'vr-input vr-select',
                value: row.provider,
                disabled: editBlocked,
                onChange: (event) => update(index, { provider: event.target.value, model: '' }),
              },
                h('option', { value: '' }, t('selectProvider')),
                providerOptions(row.provider),
              ),
              h('select', {
                className: 'vr-input vr-select',
                value: row.model,
                disabled: editBlocked || row.provider === '',
                onChange: (event) => update(index, { provider: row.provider, model: event.target.value }),
              },
                h('option', { value: '' }, row.provider === '' ? t('pickProviderFirst') : t('selectModel')),
                modelOptions(row),
              ),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: editBlocked, title: t('removeTitle'),
                onClick: () => removeRow(index),
              }, t('remove')),
            ),
          ),
          h('button', {
            type: 'button', className: 'vr-btn', disabled: editBlocked || hiddenProviders.length === 0,
            onClick: () => setDraft('extraVisionModels', [...rows, { provider: '', model: '' }]),
          }, t('addFallback')),
          hasHalfRow
            ? h('p', { className: 'vr-invalid' }, t('invalidGeneric'))
            : h('p', { className: 'vr-hint' }, t('extraVisionModelsHint')),
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
              className: 'vr-input vr-select', value: pair.provider ?? '', disabled: editBlocked,
              onChange: (event) => setPair({ provider: event.target.value, model: '' }),
            },
              h('option', { value: '' }, t('selectProvider')),
              groupOptions,
            ),
            h('select', {
              className: 'vr-input vr-select', value: pair.model ?? '',
              disabled: editBlocked || !pair.provider,
              onChange: (event) => setPair({ provider: pair.provider, model: event.target.value }),
            },
              h('option', { value: '' }, pair.provider ? t('selectModel') : t('pickProviderFirst')),
              modelOptionsOf(modelsOf(pair.provider)),
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
                className: 'vr-input vr-select', value: row.provider ?? '', disabled: editBlocked,
                onChange: (event) => updateWrap(index, { provider: event.target.value, model: '' }),
              },
                h('option', { value: '' }, t('selectProvider')),
                wrapGroupOptions,
              ),
              h('select', {
                className: 'vr-input vr-select', value: row.model ?? '',
                disabled: editBlocked || !row.provider,
                onChange: (event) => updateWrap(index, { provider: row.provider, model: event.target.value }),
              },
                h('option', { value: '' }, row.provider ? t('wrapAllModels') : t('pickProviderFirst')),
                modelOptionsOf(modelsOf(row.provider)),
              ),
              h('button', {
                type: 'button', className: 'vr-reset', disabled: editBlocked, title: t('removeTitle'),
                onClick: () => removeWrap(index),
              }, t('remove')),
            ),
          ),
          h('button', {
            type: 'button', className: 'vr-btn', disabled: editBlocked,
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
      if (open && !remoteMode && testState.status === 'idle') {
        runTestConnection()
      }
      if (open && !remoteMode && updateState.status === 'idle') {
        runUpdateCheck(false)
      }

      const updatePanel = () => {
        const result = updateState.result
        const auto = result && result.autoUpdate
        const profile = auto && typeof auto.profile === 'string' && auto.profile ? auto.profile : 'web'
        const projectUrl = 'https://github.com/ysr666/dsh-vision-router'
        const releasesUrl =
          result && typeof result.releasesUrl === 'string' && result.releasesUrl
            ? result.releasesUrl
            : projectUrl + '/releases/latest'
        // Manual recovery is executable only when an exact target was
        // confirmed by npm metadata or GitHub Releases. If every version source
        // is unavailable, show a non-executable <version> template instead of
        // falling back to @latest / plain update, both of which pnpm 11 may
        // silently withhold while still reporting success.
        const manualVersion =
          result && typeof result.latestVersion === 'string' && result.latestVersion.trim()
            ? result.latestVersion.trim()
            : ''
        const manualTargetKnown = manualVersion !== ''
        const manualPackageSpec = 'dsh-vision-router@' + (manualTargetKnown ? manualVersion : '<version>')
        const manualAction = 'add ' + manualPackageSpec
        const pnpmCommand = 'pnpm dsh plugin --profile ' + profile + ' ' + manualAction
        const npxCommand = 'npx @deepseek-ai/dsh plugin --profile ' + profile + ' ' + manualAction
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
          status = t('updateFailed', { error: diagnosticError(result && result.error, t('updateNoDiagnostic')) })
        }
        let selfUpdateStatus
        let selfUpdateFailed = false
        if (selfUpdateState.status === 'running') {
          selfUpdateStatus = t('updateRunning')
        } else if (selfUpdateState.status === 'done' && selfUpdateState.result && selfUpdateState.result.ok === true) {
          const updateResult = selfUpdateState.result
          const latest = updateResult.targetVersion || (result && result.latestVersion) || ''
          if (updateResult.installedVersion) {
            selfUpdateStatus = t('updateSuccessVerified', {
              latest,
              installed: updateResult.installedVersion,
            })
          } else {
            selfUpdateStatus = t('updateSuccess', { latest })
          }
        } else if (selfUpdateState.status === 'error') {
          selfUpdateFailed = true
          selfUpdateStatus = t('updateActionFailed', {
            error: diagnosticError(selfUpdateState.result && selfUpdateState.result.error, t('updateNoDiagnostic')),
          })
        }
        const showManualHelp =
          failedUpdate ||
          selfUpdateState.status === 'error' ||
          (result && result.ok === true && result.updateAvailable === true && (!auto || auto.supported !== true))
        const commandBlock = (label, command) =>
          h('div', { className: 'vr-update-command' },
            h('div', { className: 'vr-update-command-label' }, label),
            h('code', { className: 'vr-update-code' }, command),
          )
        const manualHelp = showManualHelp
          ? h('div', { className: 'vr-update-manual' },
              h('div', { className: 'vr-update-manual-title' }, t('updateManualTitle')),
              !manualTargetKnown
                ? h('p', { className: 'vr-update-note' }, t('updateManualUnknownTarget'))
                : null,
              auto && auto.reason === 'source-cli-needs-loader'
                ? commandBlock(t('updateManualSource'), pnpmCommand)
                : null,
              commandBlock(t('updateManualNpx'), npxCommand),
              h('p', { className: 'vr-update-note' }, t('updateManualAgeHint')),
              h('div', { className: 'vr-update-actions' },
                h('button', {
                  type: 'button', className: 'vr-btn',
                  onClick: () => window.open(projectUrl, '_blank', 'noopener,noreferrer'),
                }, t('updateProject')),
                h('button', {
                  type: 'button', className: 'vr-btn',
                  onClick: () => window.open(releasesUrl, '_blank', 'noopener,noreferrer'),
                }, t('updateReleases')),
              ),
            )
          : null
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
          result && result.ok === true && result.registryFallbackFrom
            ? h('p', { className: 'vr-hint' }, t('updateRegistryFallback'))
            : null,
          result && result.ok === true && result.releaseFallback === true
            ? h('p', { className: 'vr-hint' }, t('updateReleaseFallback'))
            : null,
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
                releasesUrl
                  ? h('button', {
                      type: 'button', className: 'vr-btn',
                      disabled: selfUpdateState.status === 'running',
                      onClick: () => window.open(releasesUrl, '_blank', 'noopener,noreferrer'),
                    }, t('updateReleaseNotes'))
                  : null,
                selfUpdateStatus
                  ? h('p', { className: selfUpdateFailed ? 'vr-failed' : 'vr-hint' }, selfUpdateStatus)
                  : null,
              )
            : selfUpdateStatus
              ? h('p', { className: selfUpdateFailed ? 'vr-failed' : 'vr-hint' }, selfUpdateStatus)
              : null,
          manualHelp,
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
              dirty
                ? h('div', { className: 'vr-savebar', role: 'region', 'aria-label': t('pending') },
                    failed
                      ? h('p', { className: 'vr-failed', role: 'alert' },
                          t('saveFailed') + (failedFields.length > 0 ? `（${failedFields.join('、')}）` : ''))
                      : h('span', { className: 'vr-pending' }, t('pending')),
                    h('button', {
                      type: 'button', className: 'vr-btn', disabled: saving,
                      onClick: clearDrafts,
                    }, t('discard')),
                    h('button', {
                      type: 'button', className: 'vr-btn vr-btn-save', disabled: blocked,
                      onClick: save,
                    }, saving ? t('saving') : t('save')),
                  )
                : null,
              h('div', { className: 'vr-quickstart' },
                h('div', { className: 'vr-quickstart-title' }, t('quickStartTitle')),
                h('p', { className: 'vr-quickstart-body' }, t('quickStartBody')),
                h('p', { className: 'vr-quickstart-live' }, t('quickStartLive')),
                remoteMode ? h('p', { className: 'vr-hint' }, t('remoteSafeScopeHint')) : null,
                h('div', { className: 'vr-quickstart-actions' },
                  h('button', {
                    type: 'button', className: 'vr-btn',
                    // Re-viewing the guide replays it from the beginning:
                    // leave the settings modal first (its panel closes on
                    // Escape), show the overview (steps 1-3), and then walk
                    // through step 1 on the chat page — starting in place
                    // would skip the session/text-model step entirely.
                    onClick: () => {
              guideHostUi.closeSettings()
              const reveal = () => showOnboarding(t, { auto: false, focus: true })
              if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(reveal)
              else reveal()
            },
                  }, t('quickStartGuide')),
                ),
              ),
              TOGGLE_KEYS.map((key) => toggleField(key)),
              // 深度档位与自定义引导只作用于结构化预识别流程：跟随该开关
              // 显示在主设置区（而不是埋在「高级设置」里），用户开启后能
              // 直接看到、不用翻折叠区。
              format('structuredVisionBootstrap') === true
                ? h('div', { className: 'vr-group' },
                    h('p', { className: 'vr-group-title' }, t('groupDeepDive')),
                    SELECT_KEYS.map((key) => selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), [
                      { value: 'fast', label: t('visionDepthFast') },
                      { value: 'standard', label: t('visionDepthStandard') },
                      { value: 'deep', label: t('visionDepthDeep') },
                    ])),
                    guidanceOverridesEditor(),
                  )
                : null,
              depthCapField(),
              // Local vision is a primary capability. Keep the heavy editors
              // collapsed by default, but make the entry obvious at a glance.
              !remoteMode ? h('div', {
                className: 'vr-group vr-local-group' + (showLocalVision ? ' vr-local-group-open' : ''),
              },
                h('button', {
                  type: 'button', className: 'vr-group-head', 'aria-expanded': showLocalVision,
                  'aria-controls': 'vr-local-vision-body',
                  onClick: () => setShowLocalVision(!showLocalVision),
                },
                  h('span', { className: 'vr-group-title vr-local-title' }, t('groupLocalOllama')),
                  h('span', { className: 'vr-group-summary', title: localVisionSummary() }, localVisionSummary()),
                  h('span', { className: 'vr-chevron' + (showLocalVision ? ' vr-chevron-open' : '') }, '▾'),
                ),
                h('p', { className: 'vr-local-entry-hint' }, t('localVisionHeroHint')),
                showLocalVision
                  ? h('div', { className: 'vr-local-body', id: 'vr-local-vision-body' },
                      localOllamaEditor(),
                      localLmStudioEditor(),
                    )
                  : null,
              ) : null,
              !remoteMode ? toggleField('desktopScreenshot') : null,
              h('p', { className: 'vr-hint' }, t('defaultChainNote')),
              visionCaps.status === 'loading'
                ? h('p', { className: 'vr-hint' }, t('visionCapsLoading'))
                : visionCaps.status === 'error'
                  ? h('p', { className: 'vr-hint vr-stealth-notice' }, t('visionCapsError'))
                  : null,
              catalogReady
                ? chainEditor()
                : h('div', {
                    className: guideStep === 'step2' ? 'vr-guide-target' : '',
                    id: 'vr-vision-backend-chain',
                    'data-vr-guide-target': 'vision-backend',
                    tabIndex: guideStep === 'step2' ? -1 : undefined,
                  },
                    guideCallout(),
                    textField('providers', t('textProviders'), t('textProvidersHint'), true),
                  ),
              builtinFallbackPanel(),
              h('div', { className: 'vr-quickstart-actions' },
                h('button', {
                  type: 'button', className: 'vr-btn', disabled: testState.status === 'running',
                  onClick: runTestConnection,
                }, t('testConnection')),
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
              ),
              catalog.status === 'loading'
                ? h('p', { className: 'vr-hint' }, t('catalogLoading'))
                : catalog.status === 'error'
                  ? h('div', { className: 'vr-catalog-error' },
                      h('p', { className: 'vr-hint' }, t('catalogError') + catalog.error + t('catalogFallback')),
                      h('button', {
                        type: 'button', className: 'vr-btn',
                        onClick: () => {
                          setCatalog({ status: 'idle', groups: [], failures: [], error: undefined })
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
            h('p', { className: 'vr-group-title' }, t('groupPerformance')),
            PERFORMANCE_TOGGLE_KEYS.map((key) => toggleField(key)),
            NUMBER_KEYS.map((key) => textField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), false)),
          ),
          h('div', { className: 'vr-group' },
            h('p', { className: 'vr-group-title' }, t('groupCompatibility')),
            COMPATIBILITY_TOGGLE_KEYS.map((key) => toggleField(key)),
            catalogReady
              ? textProviderEditor()
              : textField('textProvider', t('textTextProvider'), t('textTextProviderHint'), false),
            h('p', { className: 'vr-hint' }, t('textModelGroupHint')),
          ),
          h('div', { className: 'vr-group' },
            h('p', { className: 'vr-group-title' }, t('groupCost')),
            COST_TOGGLE_KEYS.map((key) => toggleField(key)),
          ),
          !remoteMode ? h('div', { className: 'vr-group' },
            h('p', { className: 'vr-group-title' }, t('groupNetwork')),
            toggleField('allowRemoteSettings'),
            textField('proxy', t('proxyLabel'), t('proxyHint'), false),
            textField('proxyHosts', t('proxyHostsLabel'), t('proxyHostsHint'), true),
          ) : null,
          h('div', { className: 'vr-group' },
            h('p', { className: 'vr-group-title' }, t('groupDeveloper')),
            h('p', { className: 'vr-hint' }, t('developerHint')),
            !remoteMode ? DEVELOPER_TOGGLE_KEYS.map((key) => toggleField(key)) : null,
            !remoteMode ? stealthNotice() : null,
            h('p', { className: 'vr-group-title' }, t('groupWrappers')),
            catalogReady
              ? wrappersEditor()
              : textField('wrappedProviders', t('textWrappedProviders'), t('textHintWrappedProviders'), true),
            h('p', { className: 'vr-group-title' }, t('groupVisionOverrides')),
            catalogReady && hiddenVisionBackends.length > 0
              ? extraVisionModelsEditor()
              : textField('extraVisionModels', t('extraVisionModelsLabel'), t('extraVisionModelsHint'), true),
            h('p', { className: 'vr-group-title' }, t('groupRoutes')),
            !remoteMode ? TEXT_KEYS.map((key) => textField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), false)) : null,
          ),
        )
      : null,
    !remoteMode ? h('div', { className: 'vr-group' },
      h('p', { className: 'vr-group-title' }, t('groupDiagnostics')),
      updatePanel(),
    ) : null,              h('div', { className: 'vr-footer' },
                h('button', {
                  type: 'button', className: 'vr-btn',
                  onClick: async () => {
                    try {
                      const response = await fetch('/_dsh/vision-router/logs', {
                        method: 'POST',
                        cache: 'no-store',
                      })
                      const result = await response.json().catch(() => undefined)
                      if (!response.ok || !result || result.ok !== true) {
                        throw new Error(result && result.error ? result.error : `HTTP ${response.status}`)
                      }
                    } catch (error) {
                      if (typeof window.alert === 'function') {
                        window.alert(
                          t('openLogFolderFailed') + '：' +
                            (error && error.message ? error.message : String(error)),
                        )
                      }
                    }
                  },
                }, t('openLogFolder')),
                failed ? h('p', { className: 'vr-failed', role: 'alert' },
                  t('saveFailed') + (failedFields.length > 0 ? `（${failedFields.join('、')}）` : '')) : null,
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

    // Skip re-renders when the app re-renders the settings panel for unrelated
    // reasons (tab switches, other cards' stores): the card's props come from
    // a stable inject object, so a shallow memo keeps the heavy field/select
    // DOM untouched until its own state or the settings scope changes.
    const VisionRouterCardMemoized =
      typeof React.memo === 'function' ? React.memo(VisionRouterCard) : VisionRouterCard

    const ARTIFACT_TOOL_KEYS = [
      'vision_materialize',
      'vision_crop',
      'vision_pixel_diff',
      'vision_trace',
      'vision_extract_foreground',
      'vision_html_screenshot',
      'vision_screenshot',
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
      const localScope = ctx.settingsScope.bind({ namespace: 'vision-router' })
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
      const remoteScope = createRemoteSettingsScope(getConnection)
      // Connection is optional at plugin activation, but page authority is not.
      // Fall back to location.hostname so a remote page can never get frozen onto
      // DSH's intentionally-unavailable local SettingsScope just because Connection
      // was provided a few ticks later.
      const useRemoteSettings = shouldUseRemoteSettings(getConnection)
      const primaryScope = useRemoteSettings ? remoteScope : localScope
      installSettingsPersistence(primaryScope)
      ctx.effect(() => {
        if (!useRemoteSettings) return () => {}
        void remoteScope.load()
        const stopReset = ctx.on('connection/reset', () => { void remoteScope.reload() })
        let stopSettings
        try {
          stopSettings = ctx.remote && typeof ctx.remote.$on === 'function'
            ? ctx.remote.$on('settings/document-updated', (namespace) => {
                if (namespace === undefined || namespace === 'vision-router') void remoteScope.reload()
              })
            : undefined
        } catch { stopSettings = undefined }
        return async () => {
          stopReset()
          if (typeof stopSettings === 'function') stopSettings()
          await remoteScope.dispose()
        }
      }, 'vision-router: remote settings scope')
      ctx.effect(installStyles, 'vision-router: card styles')
      ctx.effect(() => installVisionSettingsGuide(t), 'vision-router: model selection guide')
      ctx.effect(() => installOnboarding(t), 'vision-router: first-run onboarding')
      // A stable props object: the memoized card skips re-renders only when
      // this identity stays fixed across slot renders.
      const subscribeConnectionReset = (listener) => ctx.on('connection/reset', listener)
      const cardInject = { getConnection, t, locale: ctx.locale, remote: ctx.remote, subscribeConnectionReset }
      // Vision Router owns one canonical settings surface. The section switches
      // to the opt-in remote scope on a non-loopback client.
      const sectionCardInject = Object.freeze({ ...cardInject, scope: primaryScope, surface: 'section' })
      const VisionRouterSettingsSection = (sectionProps) =>
        React.createElement(
          'ul',
          { style: { listStyle: 'none', margin: 0, padding: 0 } },
          React.createElement(VisionRouterCardMemoized, sectionProps),
        )
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.section',
                id: 'vision-router',
                order: 12,
                label: () => t('settingsNav'),
                inject: () => sectionCardInject,
              },
              VisionRouterSettingsSection,
            )
          }),
        'vision-router: primary settings section',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('tool.call.toolview', function* () {
            yield ctx.slots.register(
              { name: 'tool.call.toolview', key: 'vision_present', priority: -10, inject: () => ({}) },
              VisionPresentCard,
            )
            for (const key of ARTIFACT_TOOL_KEYS) {
              yield ctx.slots.register(
                { name: 'tool.call.toolview', key, priority: -10, inject: () => ({}) },
                ArtifactCard,
              )
            }
          }),
        'vision-router: artifact tool cards',
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots', 'locale', 'sessions', 'remote']
    exports.unwrapModelsResult = unwrapModelsResult
    exports.catalogFailureDetail = catalogFailureDetail
    exports.catalogStateFromValue = catalogStateFromValue
    exports.subscribeCatalogInvalidations = subscribeCatalogInvalidations
    exports.filterVisionBackendGroups = filterVisionBackendGroups
    exports.collectFilteredVisionBackends = collectFilteredVisionBackends
    exports.visionCapabilityWarningKey = visionCapabilityWarningKey
    exports.normalizeVisionChainRows = normalizeVisionChainRows
    exports.normalizeLocalProviderDraft = normalizeLocalProviderDraft
    exports.parseLocalProviderDraft = parseLocalProviderDraft
    exports.jsonValueEqual = jsonValueEqual
    exports.canonicalizeProviders = canonicalizeProviders
    exports.settingsValueEqual = settingsValueEqual
    exports.canonicalizeSettingsRun = canonicalizeSettingsRun
    exports.commitSettingsPlan = commitSettingsPlan
    exports.createRemoteSettingsScope = createRemoteSettingsScope
    exports.shouldUseRemoteSettings = shouldUseRemoteSettings
    exports.installSettingsPersistence = installSettingsPersistence
    exports.GUIDE_STATE = GUIDE_STATE
    exports.GUIDE_EVENT = GUIDE_EVENT
    exports.guideTransition = guideTransition
    exports.guideState = guideState
    exports.readOnboardingDisposition = readOnboardingDisposition
    exports.startVisionSettingsGuide = startVisionSettingsGuide
    exports.finishVisionSettingsGuide = finishVisionSettingsGuide
    // Guide lifecycle hooks for behavioral tests: the idle-path layout-cost
    // gate and the per-frame sync coalescing are the exact regression guards
    // against settings panel scroll stutter.
    exports.syncVisionGuidePrompt = syncVisionGuidePrompt
    exports.installVisionSettingsGuide = installVisionSettingsGuide
    exports.stopGuideSync = stopGuideSync
    exports.readVisionGuideStep = readVisionGuideStep
    return module.exports
  },
})

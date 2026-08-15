# Changelog

每个版本的中英双语发布说明（GitHub Release 工作流从这里取对应版本的段落，发布前必须先写好本节）｜
Bilingual (Chinese + English) release notes for every version — the GitHub Release workflow pulls the matching section from this file, so it must be filled in before tagging.

## v1.2.0

### 新增 / Added

- **真正零配置的匿名视觉兜底**：内置 OVHcloud 五模型视觉链固定作为最终兜底，免注册、免 Key；用户自己配置的视觉模型仍优先。OVH 匿名额度按每 IP、每模型 2 次/分钟独立计算，五个模型理论合计约 10 RPM，实际以 OVH 限流为准。
- **Zero-config anonymous vision fallback**: a five-model OVHcloud image chain is now the fixed final fallback with no signup or API key; user-configured vision models still run first. Anonymous OVH buckets are 2 RPM per IP per model, roughly 10 RPM in theory across five independent models, subject to OVH rate limiting.
- **安全的图片展示**：新增 `vision_present`，生成 / 编辑 / 截图得到的图片可作为 DSH 持久附件直接内联展示；刷新后仍可查看，并避免把展示图片塞回纯文本 DeepSeek 请求。
- **Safe image presentation**: `vision_present` stores generated/edited/screenshot images as durable DSH attachments for inline display and refresh persistence without feeding display images back into text-only DeepSeek requests.
- **诊断与修复工具**：新增 `npx dsh-vision-router doctor` / `repair`，可在 DSH 因 profile UTF-8 BOM 无法启动时独立检测并安全移除 BOM。
- **Doctor / repair CLI**: `npx dsh-vision-router doctor` and `repair` can diagnose and safely remove a profile UTF-8 BOM even when DSH cannot boot.
- **版本检查与安全更新**：设置页会明确提示发现的新版本；继承的 npm/pnpm registry 失败时自动回退 npm 官方源；自动更新不可用或失败时显示 pnpm / npx 手动命令、项目主页与 Releases。
- **Update checks and safe updates**: the settings card explicitly reports newer versions, falls back from a broken inherited npm/pnpm registry to npmjs, and shows pnpm/npx manual commands plus Project/Releases links when automatic update is unavailable or fails.

### 改进 / Changed

- **聊天模型和看图模型彻底分开**：聊天页右下角只负责会话模型；设置页「视觉后端链」一行一个用户视觉模型；内部 `Vision HTTP` 不再暴露给用户，OVH 匿名链固定在最后自动兜底。
- **Chat and vision model UX is fully separated**: the lower-right chat picker only chooses the conversation model; settings rows choose user vision models; internal `Vision HTTP` is hidden and the anonymous OVH chain remains the automatic final fallback.
- 首次引导升级为三步模型说明，标题统一为 **“Vision Router 已准备好 🎉”**；设置卡提示改为更自然的「聊天与看图分别设置」。
- First-run guidance now explains the two model roles in three steps under **“Vision Router is ready 🎉”**; the permanent settings hint is now “Chat and vision are configured separately.”
- OpenAI-compatible 视觉 HTTP 后端现在保留用户问题，GLM 等模型的输出 token 差异通过集中兼容规则与有限纠错处理。
- OpenAI-compatible vision HTTP calls now preserve the user's question, with centralized compatibility handling for GLM-style output-token limits and bounded corrective retries.

### 修复 / Fixed

- **修复纯文本 DeepSeek 会话被图片工具结果永久污染**：递归清理嵌套 `tool-result` 中的图片块，保留原始会话附件供 UI / `vision_describe` 使用，同时确保纯文本适配器永远收不到不支持的 image content。
- **Fixed text-only DeepSeek history poisoning from image tool results**: nested `tool-result` image blocks are sanitized before model calls while durable attachments remain available to the UI and `vision_describe`.
- 匿名 OVH 429 不再在单模型内部长时间等待，立即切换到下一个独立限额模型；Windows/macOS/Linux 的 Chrome/Edge 截图路径发现也更完整。
- Anonymous OVH 429 responses now move immediately to the next independently rate-limited model instead of sleeping inside one bucket; Chrome/Edge discovery for screenshots is also broader across Windows/macOS/Linux.

## v1.1.1

### 新增 / Added

- **已有模型自动包装**：安装后自动发现 DSH 当前已注册的 provider / model，并为它们生成「+ 自动识图」入口；后续新增或移除 provider 时也会随 `llm/adapters-updated` 动态同步，不再要求用户逐个填写「额外识图包装」。
- **Automatic wrapping for existing models**: on install, discover the providers/models already registered in DSH and create `+ auto vision` twins automatically; later provider changes sync on `llm/adapters-updated`, so users no longer have to add every route manually.
- **原生多模态采用软增强**：GLM 等本来就能看图的模型仍会生成自动识图入口，但原图继续直接传给源模型；grounding / crop / OCR / pixel diff 等工具只是按需增强，不再强制先图转文。
- **Native multimodal soft enhancement**: models such as GLM still get an auto-vision entry, but their original image blocks pass through unchanged; grounding/crop/OCR/pixel-diff tools are optional precision aids rather than a forced image-to-text bridge.

### 修复 / Fixed

- **Windows sharp/libvips 冲突（#42）**：插件不再自带第二套 native `sharp`，改为通过 peer dependency 复用 DSH 宿主的 `sharp >=0.35.3`；Windows / macOS / Linux 均增加真实打包安装 + PNG 处理回归测试。
- **Windows sharp/libvips conflict (#42)**: the plugin no longer installs a second native `sharp`; it uses the DSH host `sharp >=0.35.3` through a peer dependency, with packed-install + PNG smoke tests on Windows, macOS and Linux.
- 安装 / 升级文档区分普通 npm/npx 用户与 DSH 源码 pnpm 用户，并补充 v0.x 手动 `insert` 升级到 bundle patch 时的重复挂载迁移说明。
- Install/upgrade docs now distinguish normal npm/npx usage from source-checkout pnpm usage and document migration from the old v0.x manual `insert` to the bundle patch.

## v1.1.0

### 新增 / Added

- **额外识图包装**：给 opencode 等任意第三方/自定义文本路由注册可发图的「自动识图」孪生条目，设置卡片用 provider + 模型双下拉配置；模型留空 = 包装全部模型。开箱预置一条 `deepseek-official`（标记内置包装，无副作用）；已具备图片能力的路由不进入包装列表；改动**即时生效**，无需重启。
- **Extra vision wrappers**: register image-capable auto-vision twin entries for any third-party/custom text route (e.g. opencode), configured in the settings card with provider + model dropdowns; an empty model wraps every model of the route. Ships with a pre-filled `deepseek-official` row (marks the built-in wrapper, no-op); already image-capable routes are not offered; changes apply **live, no restart**.
- 设置卡片新增「测试连接」按钮与视觉制品调用卡（`vision_crop` / `vision_pixel_diff` 等关键字段 + 打开文件）。
- The settings card gains a "Test connection" button and artifact call cards for vision tools (key facts + open-file button for `vision_crop`, `vision_pixel_diff`, …).
- 新增 `vision_long_screenshot_ocr`：长截图自动分片转写，产物分片 PNG + `ocr.md` + `manifest.json`。
- New `vision_long_screenshot_ocr` tool: transcribes long screenshots chunk by chunk, writing chunk PNGs, `ocr.md` and a `manifest.json`.

### 修复 / Fixed

- **隐身模式默认值回归**：恢复默认关闭（issue #34 显式 opt-in）；官方 `llm-deepseek` 行被禁用时做 keep-alive 接管并在设置卡片给出提示；bundle 补丁恢复纯增量（不再禁用核心行）。
- **Stealth default regression**: back to off by default (explicit opt-in, issue #34); keep-alive takeover with a card hint when the official row is disabled; the bundle patch is pure-additive again.
- 额外识图包装的孪生路由改为**惰性注册**：openrouter 等由设置驱动的 provider 在启动后才注册路由，此前孪生条目永远不出现。
- Twin routes for wrapped providers now register lazily: settings-driven providers such as openrouter mount their routes after startup, which previously made the twin never appear.
- 长截图 OCR 转写质量：视觉上传改 JPEG 去 alpha、防编造提示与超长结果重试，修复清晰分片被转成乱码的问题。
- Long-screenshot OCR quality: JPEG upload without alpha, anti-hallucination prompt and absurd-length retry fix garbled chunk transcription.

## v1.0.1

### 修复 / Fixed

- bundle 补丁纯增量 + 隐身模式显式 opt-in，不再默认禁用官方 `llm-deepseek` 行（issue #34）。
- Pure-additive bundle patch and explicit stealth opt-in: the official `llm-deepseek` row is no longer disabled by default (issue #34).
- Release 工作流幂等：npm 已存在该版本时跳过发布，并同步创建 GitHub Release。
- Idempotent release workflow: skips npm publish for existing versions and creates the matching GitHub Release.

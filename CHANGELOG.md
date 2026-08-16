# Changelog

每个版本的中英双语发布说明（GitHub Release 工作流从这里取对应版本的段落，发布前必须先写好本节）｜
Bilingual (Chinese + English) release notes for every version — the GitHub Release workflow pulls the matching section from this file, so it must be filled in before tagging.

## Unreleased

### 新功能 / Added

- **本地 Ollama / LM Studio 视觉链（#98）**：可选本地后端现已接入 HTTP 视觉链、即时图片描述与桌面截图识别；支持 OpenAI / Anthropic 两种兼容协议、Ollama → LM Studio 逐级降级、可选采样参数，以及按附件记忆跳过重复识别。LM Studio 会校验真实模型标识，设置变更无需重启即可更新 URL、模型、协议和开关。
- **Local Ollama / LM Studio vision chain (#98)**: optional local backends now participate in the HTTP vision chain, instant image descriptions and desktop-screenshot recognition, with OpenAI/Anthropic-compatible formats, Ollama → LM Studio fallback, optional sampling controls, and attachment-memory reuse that skips repeated recognition. LM Studio validates a real model identifier, and URL/model/protocol/toggle changes apply live.

### 修复 / Fixed

- **设置页大模型目录卡顿与本地配置往返**：视觉模型目录按能力快照缓存并改用可回收的选项缓存，避免每次输入重新遍历、复制数百/数千个模型并持续积累 VNode；本地视觉组默认折叠，同时补齐响应式布局。`instantDescribe` 现以布尔值保存，OpenAI/Anthropic 协议、空采样值及中英文占位文案均可无损往返，保存期间所有相关控件会锁定。
- **Large-catalog settings lag and local-config round trips**: vision groups are memoized by capability snapshot and option nodes use a reclaimable cache, avoiding a full walk/copy of hundreds or thousands of models on every keystroke and unbounded VNode retention. The local group is collapsed by default with responsive layout. `instantDescribe` now persists as a boolean; protocol, blank sampling values and localized placeholders round-trip safely, and related controls lock while saving.
- **本地链超时、热更新与隐私边界**：每轮后端按剩余总预算公平分配超时，首个本地服务挂起时仍会尝试下一层；`freeFallback: false` 只关闭匿名 OVH，不再误删显式本地后端。桌面截图改为独立的默认关闭隐私开关，macOS 只抓主显示器并避免多屏临时文件残留；Linux 依赖说明与各平台行为已校正。
- **Local timeout, live-update and privacy boundaries**: backend rounds receive a fair share of the remaining total budget, so a hung first local service still leaves time for the next one; `freeFallback: false` now disables only anonymous OVH models, not explicit local backends. Desktop capture has a separate off-by-default privacy opt-in, macOS captures only the main display without multi-display temp-file leftovers, and Linux dependency/platform behavior is documented accurately.

## v1.4.2

### 修复 / Fixed

- **OpenCode Go 的 Qwen 识图模型不再被网关换成 MiniMax M3**：用户反馈 `opencode-go/qwen3.6-plus` 作识图模型时实际调用的是 MiniMax M3——根因是已安装的 pi-ai 目录把 Qwen3.6 Plus 分类为 OpenAI 协议（`/v1/chat/completions`），而 OpenCode Go 官方只在 Anthropic `/v1/messages` 上提供该模型（同病相怜的还有 `minimax-m2.7`），错误端点上的请求被网关落到默认模型。插件新增内置目录纠错（`catalogCorrections`，默认开启）：当解析出的目录条目仍指向错误协议时，该后端改由插件直连正确协议应答（Anthropic Messages + 渠道自身凭据）；上游目录修复、或用户把路由指向自己的网关后，纠错自动失效，回到正常 harness 路径。新增 12 个测试覆盖纠错判定、Anthropic 请求构造、整轮链路的端到端接管与自动失效。
- **OpenCode Go Qwen vision models are no longer served as MiniMax M3**: users reported that picking `opencode-go/qwen3.6-plus` as the vision backend actually invoked MiniMax M3 — the installed pi-ai catalog classifies Qwen3.6 Plus as OpenAI protocol (`/v1/chat/completions`), but OpenCode Go only serves it over the Anthropic `/v1/messages` endpoint (`minimax-m2.7` is misclassified the same way), so the gateway falls back to a default model on the wrong endpoint. The plugin now ships built-in catalog-routing corrections (`catalogCorrections`, on by default): while the resolved catalog entry still points at the wrong protocol, the backend is answered directly over the corrected one (Anthropic Messages with the channel's own credential); the moment upstream fixes the catalog — or the user points the route at their own gateway — the correction disarms itself and the normal harness path resumes. 12 new tests cover the decision table, the Anthropic request shape, and end-to-end chain take-over and auto-disarm.
- **Oh-DSH Desktop 内置 DSH 0.1.0-rc.5 上的启动崩溃已修复（#124）**：rc.5 的条目激活顺序是服务驱动的，插件可能在官方 llm-deepseek 行之前 apply；同步执行的 keep-alive 检查把尚未就绪的官方路由误判为「已停用」，抢先注册 deepseek-official 目录项，随后官方行注册时抛出 DUPLICATE_DIRECTORY，把整个运行时带崩（Oh-DSH Desktop 里表现为 `DSH runtime exited before readiness`）。接管决策现在推迟到启动稳定窗口（2s）之后再做：官方路由已注册则完全放手；确实停用/缺失才接管，stealth 与 keep-alive 路径行为不变。新增回归测试覆盖「迟到的官方行不得被误判」场景，并在真实 rc.5 宿主构建上完成端到端验证。
- **Startup crash on Oh-DSH Desktop's bundled DSH 0.1.0-rc.5 is fixed (#124)**: on rc.5, entry activation is service-driven, so the plugin could apply before the stock llm-deepseek row; the synchronous keep-alive check then misread the not-yet-applied official route as dead, registered the deepseek-official directory entry first, and the stock row's own registration threw DUPLICATE_DIRECTORY, killing the whole runtime (surfacing as `DSH runtime exited before readiness` in Oh-DSH Desktop). The takeover decision now runs after a short boot settle window (2s): a registered stock route means hands off; a still-dead route means the row is genuinely absent/disabled and the takeover is safe. Stealth and keep-alive behavior are otherwise unchanged. A new regression test covers the late-stock-row ordering, verified end-to-end against a real rc.5 host build.
- **「+ 自动识图」twin 组保留选择器里的推理等级（#103）**：切到 twin 组后宿主会丢掉会话选择器里选好的 reasoningEffort，多步 turn 只有第一步会思考。现在推理等级完全归选择器管：twin 元数据一比一镜像源路由，wrapper 流按「委托 provider + 模型」记忆最近显式的 reasoningEffort 并在后续步骤缺失时补上（选 max 一直 max，选 off 忠实跟随）；视觉链保持不消耗推理预算。顺带修复配置层不一致：wrapper 路由、视觉链路由与 agent/request 钩子改由解析后的 settings 文档响应式挂载/卸载，卡片开关即时生效（含 #120 引导完成时机修复）。
- **"+ Auto Vision" twins preserve the picker's reasoning effort (#103)**: switching to a twin group made the host drop the reasoningEffort chosen in the session picker, so only the first step of a multi-step turn reasoned. The reasoning level now belongs entirely to the picker: twin metadata mirrors the source route one-to-one, and the wrapper stream remembers the latest explicit reasoningEffort per delegated provider+model and re-applies it when later steps omit it (max stays max, off stays off); the vision chain keeps reasoning effort undefined so it never spends the reasoning budget. Also fixes a config-layer inconsistency: wrapper routes, the chain route and the agent/request hook now mount/unmount reactively from the resolved settings document, so card switches take effect immediately (including the #120 walkthrough-finish fix).

### 文档 / Docs

- **Oh-DSH Desktop 安装说明（#124）**：README 中英双语新增 Oh-DSH Desktop 章节——`DSH_HOME=~/.ohdsh` 的 desktop profile 安装命令、内置 rc.5 运行时的版本注意事项、错误安装导致无法启动时的恢复步骤、插件市场流程与内置 `@oh-dsh/vision` 的共存说明。
- **Oh-DSH Desktop install guide (#124)**: both READMEs now document the Oh-DSH Desktop path — the `DSH_HOME=~/.ohdsh` desktop-profile install command, the bundled rc.5 runtime caveat, recovery steps for a broken profile, the marketplace flow, and coexistence with the bundled `@oh-dsh/vision`.
- **多插件对比与致谢恢复并逐条核实（#122 / #123）**：恢复早前 README 重写中删除的六项目社区插件对比表与致谢一节，并按各家 2026-08 的 README 逐条核实措辞（sidecar 默认端点、provider 路由描述、modlens 登录态、toolkit 差异、tool-vision 桥接瀑布等）。
- **Multi-plugin comparison and acknowledgements restored and fact-checked (#122 / #123)**: the six-project comparison table and the Acknowledgements section lost in an earlier README rewrite are back, with every claim re-verified against each project's README as of 2026-08 (sidecar default endpoint, provider routing description, modlens login reuse, toolkit differences, tool-vision bridge hook, and more).

## v1.4.1

### 改进 / Changed

- **vision_html_screenshot 整页截图（#111）**：新增 `fullPage: true`（默认 false，原有行为不变）——Puppeteer 原生整页捕获一次拿下完整可滚动高度，结果 JSON 新增 `pageHeight`（CSS px），Agent 无需再猜视口高度；截取前唤醒折叠内容：禁用图片懒加载、覆盖 smooth scroll、视口步进扫动触发 IntersectionObserver 揭示并等待过渡动画结束。
- **vision_html_screenshot full-page capture (#111)**: `fullPage: true` (default false, existing behavior unchanged) captures the complete scrollable height in one shot and adds `pageHeight` (CSS px) to the result JSON, so agents no longer guess ever-taller viewports; below-the-fold content is woken first — lazy-loading images disabled, smooth scroll overridden, a viewport-stepped sweep fires IntersectionObserver reveals before a settle wait.
- **手动更新面板样式整理（#116）**：手动更新兜底改为独立竖向卡片，命令以整行等宽代码块展示（横向溢出滚动），pnpm 发布年龄提示降级为紧凑附注，操作按钮保持成组排列。
- **Manual-update panel layout cleanup (#116)**: the manual-update fallback gets its own vertical card with full-width monospace command blocks (horizontal overflow), the pnpm release-age warning becomes a compact secondary note, and the action buttons stay grouped.

### 修复 / Fixed

- **视觉失败链不再拖垮文本对话（#117）**：单个视觉后端的配置错误 / 401 / 429 / 临时故障此前会被放大成数分钟的重复视觉工具调用——超时逐层叠加（120s×N）、429 盲等 30–60s 重试、无熔断、无同轮失败记忆，后端失败以异常形式抛给模型，诱导其反复改问法重试直至 `tool call aborted`。现在引入统一韧性机制：AUTH 按凭据指纹熔断（换 Key 自动解除）、429 按 Retry-After 冷却、INVALID_REQUEST 本轮跳过；同一轮全部后端失败后，后续视觉调用零网络快速返回 `VISION_BACKEND_UNAVAILABLE_THIS_TURN`。单次视觉任务共享一个总预算（新增 `visionTaskTimeoutMs`，默认 45s），OCR 由 tesseract（≤12s）与视觉模型回退共享另一个预算（新增 `ocrTimeoutMs`，默认 30s），不再把两层超时相加。后端失败以结构化结果（`ok:false + code + retryable:false + attemptedProviders`）返回而非抛异常；401 时附带 Qwen Token Plan Key/端点不匹配提示；`vision_describe` / `vision_ground` / `vision_detect` / `vision_ocr` 工具描述、自动挂载提醒、wrapper 图片标记与 vision-tools skill 统一写明失败语义与「OCR 只读文字、绝不当识别重试」边界。新增 22 个回归测试覆盖 401/429 熔断、同轮防重打、总 deadline、OCR 预算、凭据更新解除熔断、wrapper/twin 委托一致性等全部场景。
- **Vision failure chains can no longer stall text turns (#117)**: one misconfigured/broken vision backend (401 / 429 / outage) used to cascade into minutes of repeated vision tool calls — stacked per-request timeouts (120s × N), blind 30–60s 429 retry waits, no circuit breaking, no same-turn failure memory, and backend failures surfaced as exceptions that invited the model to rephrase and retry until `tool call aborted`. A unified resilience layer now trips AUTH backends per credential fingerprint (auto-released when the key changes), applies Retry-After cooldowns for 429s, skips INVALID_REQUEST backends for the turn, and answers instantly with `VISION_BACKEND_UNAVAILABLE_THIS_TURN` once every backend failed this turn — zero further network attempts. One vision task shares a wall-clock budget (new `visionTaskTimeoutMs`, default 45s); OCR shares one budget between tesseract (≤12s cap) and the vision-model fallback (new `ocrTimeoutMs`, default 30s) instead of stacking the two timeouts. Backend failures return structured results (`ok:false + code + retryable:false + attemptedProviders`) instead of throwing; 401s carry a Qwen Token Plan key/endpoint mismatch hint; and the `vision_describe` / `vision_ground` / `vision_detect` / `vision_ocr` descriptions, the auto-mount reminder, the wrapper image marker and the vision-tools skill all state the failure semantics and that OCR is text-only, never a recognition retry. 22 new regression tests cover the full matrix: 401/429 trips, same-turn no-rehit, shared deadlines, OCR budget, credential-change release, and wrapper/twin delegation parity.
- **「+ 自动识图」包装委托保留推理回放（#110）**：会话经由自动识图包装路由委托文本 provider 时不再丢失 reasoning replay 记录，切换「+ 自动识图」模型后思考过程仍然可见。
- **Reasoning replay survives Auto Vision wrapper delegation (#110)**: delegating through the auto-vision wrapper no longer drops the session's reasoning replay, so thinking traces remain visible after switching to a "+ Auto Vision" model.
- **设置保存失败不再困住引导流程（#114）**：引导的跳过/完成在当前页面内即时生效，被 Host 拒绝的隐藏设置写入不会再复活引导；隐藏持久化改为单次排队的等待写入，Host 拒绝后不再无限重试；保留 #102 的读回校验并对瞬态冲突重试一次；旧版空视觉链行被归一化，不再渲染多个空白 provider/model 行；保存失败提示会点名失败的字段。
- **Settings save failures can no longer trap the vision guide (#114)**: walkthrough dismissal/finish is authoritative in-page, so a rejected hidden settings write cannot resurrect the guide; hidden persistence becomes a single-attempt queued write that never spins after Host rejection; the readback verification from #102 is kept with one retry for transient conflicts; legacy empty vision-chain rows are normalized so old settings no longer render blank provider/model rows; and save errors name the failed fields.
- **一键更新不再被 pnpm 发布年龄限制假成功欺骗（#115）**：pnpm 11 的 `minimumReleaseAge`（默认 1440 分钟）会静默扣住发布不满 24 小时的新版本并仍以 0 退出（"Already up to date"）——这正是「更新成功但版本没变」的根源。一键更新现在显式安装 registry 确认的目标版本（`add dsh-vision-router@<目标>`，显式安装自动豁免该策略），退出后读取 profile 内已安装清单并校验版本确实到达目标，零退出码不再等于成功；失败提示会解释发布年龄限制，并给出 `npx dsh-vision-router repair` 修复过期钉住豁免的路径。
- **One-click update is no longer fooled by the pnpm release-age hold (#115)**: pnpm 11's `minimumReleaseAge` (default 1440 minutes) silently keeps releases younger than 24h while still exiting 0 ("Already up to date") — the root cause of "update succeeded but the version never changed". The one-click updater now installs the registry-confirmed target explicitly (`add dsh-vision-router@<target>`, which pnpm auto-exempts from the policy) and verifies the installed manifest under the profile afterwards, so a zero exit code is never reported as success; failures explain the release-age hold and point to `npx dsh-vision-router repair` for stale pinned exemptions.

## v1.4.0

### 改进 / Changed

- **未声明视觉模型的自动识别与直连桥接（#99）**：视觉后端能力改用保守的名称推断（glm-4.6v 系列、qwen-vl/qvq、gpt-4o/4.1/5、gemini、claude-3+、internvl、doubao-vision、step-v、grok-4、pixtral、llama-vision、florence 等），并新增 `extraVisionModels` 设置手动声明视觉后端；下拉框、工具对与视觉后端链共用同一判定。当渠道适配器因目录未声明图片输入而拒绝收图（如 pi-ai `UNSUPPORTED_CONTENT`）时，推断/声明的后端自动回退为经该渠道自身 baseURL + 凭据的 OpenAI 兼容直连调用，智谱类渠道开箱即用。
- **Automatic recognition + direct-channel bridging for undeclared vision models (#99)**: vision-backend capability now uses conservative name-based inference (glm-4.6v family, qwen-vl/qvq, gpt-4o/4.1/5, gemini, claude-3+, internvl, doubao-vision, step-v, grok-4, pixtral, llama-vision, florence, …) plus a new `extraVisionModels` setting to declare vision backends manually; the dropdown, tool pairs and the chain list share one decision. When a channel adapter rejects images because the catalog does not declare image input (pi-ai `UNSUPPORTED_CONTENT`), inferred/declared backends fall back to a direct OpenAI-compatible call over the channel's own baseURL + credential, so Zhipu-like channels work out of the box.
- **doctor 检测并修复过期的版本钉住豁免（#101）**：pnpm v11 默认 `minimumReleaseAge=1440` 分钟，发布不到 24 小时的新版本会被 `dsh plugin update` 静默忽略；形如 `dsh-vision-router@1.2.0` 的版本钉住豁免只对单个版本生效、随新版发布失效——这正是「出了新版但更新无反应」的根源。doctor 现在会标记各 profile `pnpm-workspace.yaml` 中 `dsh-vision-router` 与 `@deepseek-ai/*` 宿主包的此类条目，修复时重写为裸名 / 组织通配模式。
- **The doctor detects and repairs stale version-pinned release-age exemptions (#101)**: pnpm v11 defaults `minimumReleaseAge` to 1440 minutes, so releases younger than 24h are silently ignored by `dsh plugin update`; a version-pinned exemption such as `dsh-vision-router@1.2.0` covers only that version and goes stale on the next release — the root cause of "a new release is out but update does nothing". The doctor now flags such entries for `dsh-vision-router` and the `@deepseek-ai/*` host packages in each profile's `pnpm-workspace.yaml` and rewrites them to bare names / the org pattern on repair.
- **引导流程聚光灯高亮（#107）**：三步引导此前只有第 3 步有卡片内高亮；现在每一步都是聚光灯引导——暗色遮罩 + 呼吸光环圈出真实控件（第 1 步模型选择器、第 2 步设置齿轮与「插件」入口、第 3 步视觉后端链），提示卡带箭头锚定且绝不遮挡目标；第 2 步的「下一步」可自动打开设置面板并进入插件页，全程可从提示卡一键推进。目标用稳定锚点（`data-slot` / `aria-*`）定位，不依赖哈希 CSS 类名；动效遵循 `prefers-reduced-motion`。
- **Spotlight-guided onboarding walkthrough (#107)**: the three-step guide previously highlighted only step 3. Now every step is a spotlight tour — a dimmed backdrop with a pulsing ring circles the real control (model selector, Settings gear and Plugins entry, vision chain), and the prompt is anchored beside it with an arrow that never covers the target. Step 2's Next button opens the settings panel and enters the Plugins section automatically, so the whole walkthrough can be driven from the prompt. Targets use stable anchors (`data-slot` / `aria-*`) instead of hashed CSS-module classes; motion honors `prefers-reduced-motion`.

### 修复 / Fixed

- **设置保存前先确认写入成功（#102）**：设置卡片在清除未保存草稿前会先校验写入确实生效，避免保存失败时静默丢弃草稿。
- **Settings writes are verified before drafts are cleared (#102)**: the settings card checks that a write actually succeeded before clearing unsaved drafts, so a failed save can no longer silently discard them.
- **doctor CLI 兼容 npx shim 符号链接调用（#104）**：npm 的 npx shim 在 POSIX 上通过 `node_modules/.bin` 的符号链接调用 bin，旧的字符串路径比对从未匹配，导致 macOS/Linux 上 `npx dsh-vision-router doctor` 静默退出 0 且无任何输出；现在按 realpath 比对，并补充单元与符号链接回归测试。
- **The doctor CLI works through the npx shim's symlinked bin (#104)**: npm's npx shim invokes the bin through a symlink under `node_modules/.bin` on POSIX, so the old string comparison never matched and `npx dsh-vision-router doctor` silently exited 0 without output on macOS/Linux; paths are now compared after realpath, with unit and symlink-spawn regression tests.
- **git 安装的 bin 可执行位（#105）**：pnpm 安装 git 来源插件时直接符号链接 bin 目标，文件本身需要可执行位，否则 profile 内调用 `node_modules/.bin/dsh-vision-router` 报 `EACCES`；已修复。
- **Executable bit for the git-hosted bin (#105)**: pnpm installs git-hosted plugins by symlinking the bin target directly, so the file itself needs the exec bit; without it, invoking `node_modules/.bin/dsh-vision-router` inside a profile fails with `EACCES`.
- **视觉后端兼容性加固（#106）**：收紧视觉模型过滤——保留 Qwen3-VL 聊天模型、排除 Embedding/Reranker 误报；自动发现模型在 pi-ai 准入失败前先填充能力状态；直连桥接恢复目录内的 baseURL/协议；对不兼容的提供方协议 fail-closed，并保留显式专家覆盖。
- **Hardened vision-backend compatibility (#106)**: vision-model filtering is tightened (Qwen3-VL chat models kept, Embedding/Reranker false positives excluded); capability state is populated for auto-discovered models before pi-ai admission failures; the direct bridge recovers the catalog-backed baseURL/protocol; incompatible provider protocols fail closed while explicit expert overrides are preserved.

### 文档 / Docs

- **dshpm 0.4.2 兼容说明（#97）与一条命令安装 + 目录（#95）**：注明 dshpm 0.4.2 兼容性；README 安装改为一条命令并补充目录。
- **dshpm 0.4.2 compatibility note (#97) and one-command install + TOC (#95)**: the README notes dshpm 0.4.2 compatibility, the install is now one command, and a table of contents was added.

## v1.3.0

### 改进 / Changed

- **长会话默认保持稳定工具 schema（#81 / #86）**：`progressiveTools` 改为显式 opt-in；默认从会话开始注册完整视觉工具集合，图片轮不再中途扩展 tools schema，减少 prefix/KV cache 失效与重复计费风险。
- **Stable tool schema for long sessions by default (#81 / #86)**: `progressiveTools` is now explicit opt-in. The complete vision tool set is registered from session start so image turns no longer expand the request tool schema mid-session and invalidate prefix/KV caches.
- **可持久化诊断日志（#88）**：现有诊断信息写入 `$DSH_HOME` 下的有界、脱敏日志，并可从设置页一键打开日志目录；包含轮转、同源保护与 macOS / Windows / Linux 兼容。
- **Persistent diagnostics (#88)**: existing diagnostics can be written to a bounded, redacted log under `$DSH_HOME`, with a one-click Settings action to reveal the folder across macOS, Windows and Linux.
- **视觉模型目录诊断更明确（#89）**：视觉后端按 model 粒度过滤，不会因为同一 provider 中某个模型缺少 image 能力就误伤整个 provider；无法验证 image 元数据时会列出被隐藏模型、给出修复提示，并支持重新检测。
- **Clearer vision-model catalog diagnostics (#89)**: filtering is per model, so one text-only or unverifiable model cannot hide image-capable siblings from the same provider. Hidden models explain missing image metadata and support re-detection.

### 修复 / Fixed

- **宿主 DSH capability 包使用 peer 依赖（#87 / #90）**：`@deepseek-ai/dsh-llm-deepseek` 与 `@deepseek-ai/dsh-anonymous-user-id` 改为 `peerDependencies`，避免 profile 内重复宿主能力包；`@deepseek-ai/schemastery` 按官方 DSH package cookbook 继续作为 runtime `dependency`，并加入 manifest 回归测试。
- **Host DSH capability packages use peers (#87 / #90)**: `@deepseek-ai/dsh-llm-deepseek` and `@deepseek-ai/dsh-anonymous-user-id` now use `peerDependencies`; `@deepseek-ai/schemastery` correctly remains a runtime dependency per the official DSH package cookbook.
- **与其他视觉插件共装不再因 toolview key 冲突启动失败（#91 / #92）**：Vision Router 为自己的 keyed 工具卡使用独立的 `priority: -10`，允许默认 priority 的其他视觉插件共存，同时保留 Vision Router 自己的渲染优先级。工具执行与视觉路由逻辑不变。
- **No startup failure from toolview-key collisions with other vision plugins (#91 / #92)**: Vision Router registers its keyed tool cards at `priority: -10`, allowing default-priority renderers from other plugins to coexist while keeping Vision Router rendering precedence. Tool execution and vision routing are unchanged.

### 兼容性说明 / Compatibility note

- 推荐安装方式仍是官方 DSH CLI：`npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router`。第三方 `dsh-web-plugin-manager` / `dshpm` 当前仍可能误判 Schemastery；该上游兼容性问题继续跟踪于 #87，不影响推荐的 npx 安装链路。
- The recommended install path remains the official DSH CLI: `npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router`. The third-party `dsh-web-plugin-manager` / `dshpm` may still reject Schemastery due to its current quality-gate rule; that upstream compatibility issue remains tracked in #87 and does not affect the recommended npx path.

## v1.2.3

### 修复 / Fixed

- **DSH Desktop 每次启动都重复弹出引导弹窗（#78）**：首次使用引导（「Vision Router 已准备好」）和模型引导步骤的「已读/进度」标记原来存在 `localStorage` 里，而 DSH Desktop 每次启动都换一个随机端口（`--port 0`），`localStorage` 按 origin 隔离，等于每次启动都清零。现在这两个标记改存 `vision-router` 设置段（随 profile 设置文件持久化）：客户端通过 `ctx.settingsScope` 读写 `onboardingSeen` / `visionGuideStep` 两个字段（已加入服务端 Config schema），`localStorage` 仅保留为旧版本迁移与降级兜底；同时处理了「设置快照异步到达晚于弹窗调度」的竞态——快照到达后会自动收起已弹出的引导。只读设置提供方下行为不变（回落 localStorage）。
- **DSH Desktop no longer re-shows the first-run dialog on every launch (#78)**: the onboarding dialog and the model-guide step markers used to live in `localStorage`, which is origin-scoped — and DSH Desktop serves the Web UI from a fresh random port on every launch (`--port 0`), wiping the markers each boot. The two flags now live in the `vision-router` settings section (persisted in the profile settings file) via `ctx.settingsScope` (`onboardingSeen` / `visionGuideStep`, both declared in the server Config schema); `localStorage` remains only as a legacy migration/downgrade fallback. A race where the async settings snapshot resolves after the dialog was scheduled is handled by auto-dismissing the already-shown overlay. Read-only settings providers keep the previous behavior (localStorage fallback).

## v1.2.2

### 修复 / Fixed

- **`read_image` 回挂的附件 ID 现在可被解析（#72）**：此前插件只索引 `agent/pre-step` 消息流（inbox claim，仅含用户新消息）里的图片块，宿主 `read_image` 持久化为 `tool/result` 事件的图片永远进不了索引，文本模型拿到会话中公布的 `sha256:…` ID 后调用 `vision_describe(attachmentIds=[…])` 报 `unknown attachment id`。现在索引会增量扫描会话事件日志（`user/message` / `assistant/message` / `tool/result`，含嵌套 tool-result），`lookupAttachment` 未命中时自动回退，跨回合、跨进程恢复均可用。
- **Attachment ids produced by `read_image` now resolve (#72)**: the plugin used to index only image blocks from the `agent/pre-step` inbox-claim stream, so images the host persisted as `tool/result` events never entered the index and `vision_describe(attachmentIds=[…])` failed with `unknown attachment id`. The index now incrementally scans the session event log, and `lookupAttachment` falls back to that scan on a miss — across turns and across process resumes.
- **工具结果里的图像块不再锁死文本模型会话（#74）**：`vision_present`（以及任何在工具结果中渲染图像的宿主工具）会把图像块持久化进会话历史，此后每一次请求都带上它，文本适配器以 `UNSUPPORTED_CONTENT` 拒绝，会话永久锁死。现在插件用宿主的表面替换机制（`surfaceOp: replace`，与压缩剪枝同一机制）把这类事件的模型视图替换为文本标记——用户界面仍显示原图（界面渲染 append-origin 事件），只有模型输入被净化；已锁死的历史会话升级后发一条消息即可自愈。净化按路由判断（与宿主 `read_image` 的门禁判定一致）：能直接看图的视觉路由仍正常内联看到 `read_image` 的结果图。同时修复了图片轮自动挂载分支提前 return 导致路由状态未登记、图片请求落到文本模型被拒的问题。
- **Tool-result image blocks no longer lock text-model sessions (#74)**: `vision_present` (and any host tool that renders an image into its result) persisted the image block into durable history, so every later request carried it and text-only adapters rejected the session forever with `UNSUPPORTED_CONTENT`. The plugin now rewrites the model-visible surface with sanitized replacements (`surfaceOp: replace` — the same mechanism the host compaction pruner uses): the Web UI keeps showing the image (it renders append-origin events), only the model input is sanitized, and already-locked sessions heal on the next message after upgrading. Sanitization is route-aware (mirroring the host's `read_image` gate), so image-capable routes still see `read_image` results inline. Also fixed the image-turn auto-mount branch returning early before the routing state was registered, which sent image requests to the text provider.
- **检测升级残留的旧版 sharp（#75）**：`loadSharp()` 现在对照 `package.json` 的 `peerDependencies.sharp` 范围校验实际解析到的 sharp 版本，不满足时打印明确告警（残留版本 vs 期望范围 + 清理指引），把 `colourspace: parameter space not set` 这类玄学报错变成一眼可见的修复提示。纯诊断，不改变任何行为。
- **Stale-sharp detection on upgrade (#75)**: `loadSharp()` now validates the resolved sharp against the `peerDependencies.sharp` range in `package.json` and warns with the stale version, the expected range, and cleanup guidance — turning the cryptic `colourspace: parameter space not set` into an actionable message. Diagnostics only, no behavior change.

### 升级注意 / Upgrade notes

- 从 v1.1.x 升级后若像素工具报 `colourspace: parameter space not set`：删除 profile 内残留的旧 sharp（`node_modules/sharp` 与 `node_modules/@img`）后重启，或在 profile 目录执行 `pnpm install` 重装。全新安装不受影响。
- If pixel tools report `colourspace: parameter space not set` after upgrading from v1.1.x: delete the stale sharp in the profile (`node_modules/sharp` and `node_modules/@img`) and restart, or run `pnpm install` in the profile. Fresh installs are unaffected.

## v1.2.1

### 修复 / Fixed

- **像素工具直接接受附件 ID**：`vision_ground` / `vision_detect` / `vision_crop` / `vision_present` / `vision_pixel_diff` / `vision_colors` / `vision_ocr` / `vision_long_screenshot_ocr` / `vision_trace` / `vision_extract_foreground` 的 image 参数现在可以直接传上传图片的附件 ID（如 `sha256:…`），不再报 `cannot read …/sha256:…: not found`；`vision_describe` 的 `paths` 同样支持。
- **Pixel tools accept attachment ids**: the image argument of all ten pixel tools — and vision_describe's `paths` — now resolves uploaded-image attachment ids like `sha256:…` directly instead of failing with `cannot read …/sha256:…: not found`.
- **产物文件名不再互相覆盖**：artifact 文件名在截断的 basename 之外追加完整输入的短指纹，64 字符 sha256 附件名与其裁剪产物不再塌缩成同一个 `…-ground.png` 互相覆盖。
- **Artifact names no longer collide**: stems append a short fingerprint of the full input, so a 64-char sha256 attachment name and its crops no longer collapse onto one `…-ground.png` and overwrite each other.
- `vision_ground` 对退化框（如 1 像素宽）自动重试一次，重试仍退化则明确报错。
- `vision_ground` retries once when the vision model returns a degenerate box (e.g. 1px wide) instead of accepting it silently.

### 改进 / Changed

- **模型引导可完整重放**：「重新查看模型引导」现在先退出设置页（设置面板监听标准 Escape 键关闭）、重新弹出三步总览，并依次走完第 1 步（会话/文字模型）、第 2 步（视觉模型）、第 3 步（高亮视觉链）；引导状态改为 v2 步骤标记存储。
- **The model guide replays fully**: “re-view model guide” closes the settings modal (its panel closes on the standard Escape keydown), reopens the 3-step overview, and walks step 1 (session/text model), step 2 (vision model) and step 3 (highlighted chain) in order; guide state is stored as a v2 step marker.
- **设置卡片滚动流畅**：长区块滚出视口即跳过绘制（content-visibility），各 provider 的模型选项列表缓存复用，卡片以稳定 props + memo 跳过无关重渲染；openrouter 单 provider 276 个模型下滚动不再卡顿。
- **Smooth settings scrolling**: long sections paint only when scrolled into view (content-visibility), per-provider model option lists are cached, and the memoized card skips unrelated re-renders — scrolling stays smooth even with 276 openrouter models.

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

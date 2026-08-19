# Changelog

每个版本的中英双语发布说明（GitHub Release 工作流从这里取对应版本的段落，发布前必须先写好本节）｜
Bilingual (Chinese + English) release notes for every version — the GitHub Release workflow pulls the matching section from this file, so it must be filled in before tagging.

## v1.7.1

> **v1.7.0 → v1.7.1**：修复纯远程部署无法开启 Vision Router 设置编辑的问题。通过 DSH trusted host 访问时，若远程设置尚未启用，页面会先显示明确风险确认；用户确认后只写入 `allowRemoteSettings=true` 并立即重新加载设置。后续远程编辑仍严格受现有字段白名单约束，API Key、HTTP Provider 凭据、本地 Ollama / LM Studio、产物路径等未列入白名单的敏感配置继续不对远程页面开放。
> **v1.7.0 → v1.7.1**: fixes remote-only deployments that could not enable Vision Router settings without loopback or host access. When opened through a DSH trusted host while remote settings are disabled, the page now shows an explicit risk confirmation; accepting it writes only `allowRemoteSettings=true` and reloads the settings immediately. Subsequent remote edits remain constrained by the existing field allow-list, while API keys, HTTP-provider credentials, local Ollama / LM Studio, artifact paths and other non-allow-listed sensitive settings remain unavailable remotely.

### 远程设置 / Remote settings

- **风险确认后远程启用**：取消确认时保持禁用且不写入任何设置；确认后仅提升 Vision Router 现有远程设置能力，不扩张普通远程 `mutate` 白名单，也不把 `trustedHosts` 当作身份认证。
- **Risk-confirmed remote opt-in**: cancelling leaves the permission disabled with no settings write; accepting enables only the existing Vision Router remote-settings capability, without widening the normal remote `mutate` allow-list or treating `trustedHosts` as authentication.

## v1.7.0

> **v1.6.2 → v1.7.0**：这是一次集中式 minor release：把 Vision Router 升级为一级设置能力，重做视觉模型发现与 provider 目录兼容，补齐旧会话修复与 rc.7 冷重启/replay 契约，解决 Ollama 大模型冷启动误超时，并把此前对抗式审查发现的资源、网络、文件系统、生命周期与并发边界系统性收紧。
> **v1.6.2 → v1.7.0**: a broad minor release that promotes Vision Router to a first-class Settings surface, rebuilds vision-model/provider discovery, adds legacy-session repair and rc.7 cold-resume/replay compatibility, fixes Ollama large-model cold-start timeouts, and systematically hardens the resource, network, filesystem, lifecycle, and concurrency boundaries found by adversarial review.

### 设置与模型发现 / Settings & model discovery

- **一级 Vision Router 设置页 + 受限远程设置（#213 / #219 / #229 / #237 / #239 / #240）**：新增独立的 **Settings → Vision Router** 入口，旧插件配置页只保留兼容跳转；远程编辑默认关闭，只暴露明确安全字段，网络/凭据/本地端点/桌面截屏等敏感项保持本机专属。随后补齐 rc.6/rc.7 Host/client schema 握手、`allowRemoteSettings` 布尔序列化、Host 端权威写入与稳定 snapshot，修复“保存成功但字段没落盘”和设置页空白回归。
- **First-class Vision Router Settings + constrained remote editing (#213 / #219 / #229 / #237 / #239 / #240)**: adds a dedicated **Settings → Vision Router** surface while the legacy plugin card becomes a compatibility redirect. Remote editing is off by default and capability-limited to reviewed safe fields; network, credentials, local endpoints, desktop capture, route ownership and the permission itself stay local-only. Follow-up fixes add rc.6/rc.7 Host/client contract handshakes, boolean-safe `allowRemoteSettings` persistence, authoritative Host mutation/readback, and stable snapshots so saves cannot silently disappear or blank the page.

- **自定义识图深度 + 正确的视觉预算起点（#220 / #221）**：视觉时间预算只在真正开始视觉工具工作时启动，长文本推理不再误触发“视觉预算耗尽”；识图深度新增 `custom` 与 `visionDepthMaxCalls`，可给 1+x 深挖设置精确上限或显式无限，并同步到主设置与允许的远程设置面。
- **Custom vision depth + correct budget activation (#220 / #221)**: the vision wall-clock budget now starts only when visual work actually begins, so long text-only reasoning can never exhaust a vision-only timer. The depth selector adds `custom` plus `visionDepthMaxCalls` for an exact 1+x deep-dive cap or explicit unlimited mode, synchronized across the canonical Settings surfaces.

- **私有实时模型发现与注册表（#223 / #225 / #227 / #230）**：Vision Router 不再完全依赖 DSH/pi-ai 静态目录；对已配置的兼容 provider 后台读取 `/models`，按路由指纹缓存并仅注入 Vision Router 私有选择器，不污染全局模型目录。注册表分开记录 DSH catalog、实时发现、可信端点提示与已保存兼容项；缓存重启后只作展示，只有当前路由重新验证后的证据才能授权 `UNKNOWN_MODEL` 兼容桥。官方 BigModel 端点增加严格 endpoint-scoped 视觉提示，修复目录漏列 `glm-4.6v-flash` 等可实际调用模型的场景。
- **Private live model discovery and registry (#223 / #225 / #227 / #230)**: Vision Router no longer relies solely on the static DSH/pi-ai catalog. Configured compatible providers are queried through bounded `/models` discovery, cached by route fingerprint, and merged only into Vision Router's private picker without mutating the global DSH model catalog. The registry keeps DSH catalog, live evidence, trusted endpoint hints, and saved compatibility rows separate; restart cache is display-only until the current route is revalidated. Exact official BigModel endpoint hints cover callable visual models omitted from its listing, including `glm-4.6v-flash`.

- **provider 目录兜底，彻底修复“只显示 DeepSeek”（#242）**：选择器同时读取 DSH `llm.providers` 与 `llm.models`。只要 provider 处于 active，即使模型枚举失败也不会整组消失；没有可枚举模型时提供“手动输入模型 ID”，但不会污染 DSH 全局目录，也不会绕过既有运行时授权/桥接证据边界。
- **Provider-directory fallback fixes the “only DeepSeek” case (#242)**: the picker now combines DSH `llm.providers` with `llm.models`. Active providers stay visible even when their model enumeration fails; if no IDs can be listed, users can enter an exact model ID manually. The private entry never mutates DSH's global catalog and does not grant direct-bridge authority by itself.

- **模型发现凭据与后端诊断（#238 / #243 / #245）**：实时发现的凭据解析与 DSH 自身所有权语义对齐，启动早期拿不到 Key 时不再匿名打 `/models` 制造 401；诊断日志记录实际尝试的 provider/model、adapter/bridge 路径、证据来源、成功后端与精确失败类别/详情，避免把后续 OVH fallback 误记到前一个 provider。
- **Discovery credentials and backend diagnostics (#238 / #243 / #245)**: live discovery now mirrors DSH credential ownership and defers instead of anonymously probing `/models` during startup races. Persistent diagnostics identify the exact provider/model, adapter vs bridge path, evidence source, winning backend, and bounded classified failure detail without misattributing later OVH fallbacks.

### 会话恢复与 DSH 兼容 / Session recovery & DSH compatibility

- **旧坏会话离线修复（#231）**：新增 `dsh-vision-router repair-sessions`，只匹配历史版本确切的“缺失 message id 的自动挂载提醒”签名，为 raw JSONL 与默认 checksummed Zstd 会话补确定性 id；修改前做备份，拒绝撕裂日志与正在写入的会话，修复后再次验证，避免把其他损坏数据一并“糊过去”。
- **Offline repair for legacy corrupted sessions (#231)**: adds `dsh-vision-router repair-sessions`, narrowly matching the historical Vision Router auto-mount reminder that lacked a message id. It repairs raw JSONL and checksummed Zstd sessions with deterministic IDs, byte-for-byte backups, torn-log refusal, live-writer detection, and post-write verification instead of papering over unrelated corruption.

- **rc.7 replay-v2 与真实冷重启契约（#232 / #233 / #234 / #236）**：自动识图 twin 在委托时识别 rc.7 `replayState.response` v2 所属 provider，只重绑请求时 assistant source，不篡改持久历史；新增真实 DSH rc.7 JSONL/Zstd、attachment-local、原生多模态 provider、真实 pi-ai adapter 与独立 Node 进程重启测试，覆盖多次发图→完全退出→恢复→继续文本/图片轮。
- **rc.7 replay-v2 and real cold-resume contracts (#232 / #233 / #234 / #236)**: Auto Vision twins recognize rc.7 `replayState.response` v2 ownership and rebind only request-time assistant source while leaving durable history untouched. New process-boundary contracts exercise real DSH rc.7 JSONL/Zstd persistence, attachment-local, native multimodal routes, the real pi-ai adapter, full process exit, resume, and continued text/image turns.

- **结构化 guard 持久化幂等（#249）**：`guard-stop`、混合分支与证据 guard 对同一轮/同一 message id 只注入一次，避免重复 `agent/pre-step` 把同 ID 用户消息写入多次、最终导致会话重载失败；长文本轮与视觉预算未激活场景保持零额外消息。
- **Idempotent structured guard persistence (#249)**: `guard-stop`, mixed-branch, and evidence guards are injected at most once per unchanged turn/message ID, preventing repeated `agent/pre-step` calls from persisting duplicate user messages that later break session reload. Long text-only turns remain free of synthetic vision-budget messages.

### 本地视觉 / Local vision

- **Ollama 冷启动不再被 45 秒识图预算误杀（#250）**：本机 loopback Ollama 模型在插件/设置就绪后后台预热；Ollama 是首个有效图片后端时，冷加载会在正常视觉任务预算开始前完成/复用。预热使用原生 `/api/generate` 空 prompt 与 `keep_alive: "30m"`，成功识图后后台续期；先以 1.5 秒 `/api/ps` 探测服务，真正挂死/未启动仍快速 fallback。相同 endpoint/model 并发预热自动合并，远程 Ollama URL 永不自动预热。
- **Ollama cold starts no longer consume the normal 45s vision budget (#250)**: loopback Ollama models prewarm in the background when the plugin/settings become ready. When Ollama is the first effective image backend, cold loading completes or coalesces before the normal inference deadline begins. Preload uses native `/api/generate` with an empty prompt and `keep_alive: "30m"`, successful calls renew residency asynchronously, a 1.5s `/api/ps` probe keeps dead services on the fast fallback path, concurrent warmups coalesce, and remote Ollama URLs are never auto-warmed.

### 安全、资源与生命周期 / Security, resources & lifecycle

- **四轮对抗式边界加固（#215 / #216 / #217 / #218）**：把此前“能工作但缺少硬边界”的路径统一收紧：adapter 同步固定点有上限；全页截图在滚动/唤醒前先做尺寸准入并限制浏览器并发；Android 临时附件按字节+数量有界；视觉 turn deadline 贯穿排队与核心调用；诊断写队列、HTTP 成功/错误体、模型目录响应均按字节流式限额；截图源与产物写入按 canonical realpath 防 symlink 越界；答案缓存、turn memory、熔断表按数量/字节/LRU/TTL 有界；结构化 JSON 提取改为单遍平衡扫描；动态 wrapper proxy 按 adapter+context 隔离；运行时 provider/fallback 配置统一规范化；Tesseract 兼容只挂在 promisify seam，不再替换全局 callback `execFile`。
- **Four adversarial hardening passes (#215 / #216 / #217 / #218)**: previously soft boundaries are made explicit and bounded: adapter reconciliation has a convergence cap; full-page screenshots admit size before scroll/wake work and browser concurrency is governed; Android transient attachments are byte- and count-bounded; turn deadlines propagate through queued/core work; diagnostic queues and HTTP/model bodies have streaming byte ceilings; screenshot sources and artifact publication use canonical realpath authority against symlink escapes; answer caches, turn memory and circuit state are count/byte/LRU/TTL bounded; structured JSON extraction is single-pass; dynamic wrappers are isolated by adapter+context; runtime provider/fallback config shares one bounded normalizer; and the Tesseract compatibility layer is limited to the promisified seam instead of replacing callback `execFile` process-wide.

### 文档与项目 / Docs & project

- **赞助页与 GitHub Sponsor 入口（#248 / #251）**：新增中英双语 `SPONSOR.md` 与微信/支付宝赞助入口；赞助完全自愿，不影响 issue/PR 优先级或功能承诺。
- **Sponsor page and GitHub funding entry (#248 / #251)**: adds a bilingual `SPONSOR.md` with WeChat Pay/Alipay support. Sponsorship is explicitly optional and does not buy issue/PR priority or feature commitments.

### 验证 / Validation

- 发布分支覆盖 **657 项测试**；主 CI 在 Node 22 / Node 24 下运行，并继续验证 DSH `0.1.0-rc.6` / `0.1.0-rc.7`、Ubuntu/macOS/Windows 宿主打包与 shared-sharp、真实 native multimodal cold-resume，以及 100MP 大图资源压力。最终 tag 触发的 immutable Release workflow 会再次执行完整测试后通过 npm Trusted Publishing（OIDC）发布并核对 tarball 身份。
- The release branch covers **657 tests**. Main CI runs on Node 22/24 and continues to verify DSH `0.1.0-rc.6` / `0.1.0-rc.7`, Ubuntu/macOS/Windows packed-host + shared-sharp integration, real native-multimodal cold resume, and 100MP large-image resource stress. The immutable tag-triggered Release workflow re-runs the full suite, publishes through npm Trusted Publishing (OIDC), and verifies the exact tarball identity.

## v1.6.2

> **v1.6.1 → v1.6.2**：本版本以稳定性为核心：加固 1+x 视觉流程的循环/深度边界，修复 rc.7 模型 twin 同步与 Tesseract OCR 输入链路，重构新手引导生命周期，并为长会话图片状态与超大图处理加入有界资源治理。
> **v1.6.1 → v1.6.2**: a stability-focused release: hardens loop/depth boundaries in the 1+x vision flow, fixes rc.7 model-twin synchronization and Tesseract OCR input paths, makes onboarding lifecycle state-driven, and adds bounded resource governance for long-session image state and very large images.

### 稳定性与可靠性 / Stability & reliability

- **1+x 流程加固（#206）**：结构化 bootstrap 改为单次执行，fast/standard/deep 深度配额与混合分支均受硬边界约束；空证据不再计为有效深挖，整轮共享预算，分类结果与自定义引导统一做归一化/限长/清洗，避免循环和失控调用。
- **1+x flow hardening (#206)**: makes the structured bootstrap one-shot, enforces hard fast/standard/deep quotas and mixed-branch bounds, rejects empty evidence, shares one turn budget, and normalizes/bounds custom guidance to prevent loops and runaway calls.

- **rc.7 模型同步 + OCR（#209）**：rc.7 adapter 更新重入改为收敛到固定点，避免模型列表旧快照覆盖新快照；OCR 兼容层只在 promise 化边界接管 `execFile`，不再全局覆盖 callback API，修复 Node 24/Tesseract 输入链路。
- **rc.7 model sync + OCR (#209)**: rc.7 adapter refresh now converges to a fixed point instead of allowing stale snapshots to overwrite newer state. The OCR compatibility layer only intercepts the promisified `execFile` seam instead of replacing the callback API process-wide, fixing the Node 24/Tesseract input path.

- **新手引导生命周期修复（#207）**：引导改成显式状态机，首次展示由设置 snapshot 就绪驱动，移除固定 650ms 延迟；设置面板关闭、返回聊天页、重开设置等状态都可正确收敛，不再出现“过几秒才突然弹出来”或关闭后卡死。
- **Onboarding lifecycle fix (#207)**: the guide is now an explicit state machine driven by a ready settings snapshot instead of a fixed 650ms delay. Closing/reopening Settings and returning to chat converge correctly, avoiding late popups and stuck walkthroughs.

- **长会话状态与大图资源治理（#208 / #210）**：会话图片状态加入有界 LRU/TTL；大图处理按像素、字节、并发和临时内存做硬限制，100MP 压力路径纳入持续验证。
- **Long-session state + large-image resource governance (#208 / #210)**: session image state gains bounded LRU/TTL behavior; large-image processing now has hard pixel, byte, concurrency and temporary-memory ceilings, with the 100MP stress path kept under continuous validation.

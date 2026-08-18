# Changelog

每个版本的中英双语发布说明（GitHub Release 工作流从这里取对应版本的段落，发布前必须先写好本节）｜
Bilingual (Chinese + English) release notes for every version — the GitHub Release workflow pulls the matching section from this file, so it must be filled in before tagging.

## v1.6.1

> **v1.6.0 → v1.6.1**：新增结构化预识别后的深挖引导（混合图分路识别、看图深度档位 fast/standard/deep、收敛分类、可配置引导文案）；恢复被 #198 误删的附件放宽（超长截图/大图过宿主准入，rc6/rc7 双侧 schema 均有效）；深度档位与自定义引导移到主设置区并配用户友好文案。
> **v1.6.0 → v1.6.1**: adds deep-dive guidance after the structured pre-scan (mixed-image branch routing, a vision depth tier fast/standard/deep, convergent classification, configurable guidance copy); restores the attachment limit widening #198 had over-cautiously removed (long screenshots / large images pass host admission — valid on both rc6 and rc7); and moves the depth tier + custom guidance into the main settings area with user-friendly copy.

### 识图引导 / Vision guidance

- **1+x 深挖引导（#178，感谢 shaoqiuyuavailable）**：结构化预识别后按场景/内容注入深挖引导——混合图（visual_kind=mixed）拆分为 ≤2 个分支分别引导识别方式（避免漏判/错判另一半内容，成本封顶）；bootstrap schema 新增 `content_kind`（人物/动物/植物/食物/交通工具/机器/建筑/物品/场景/表情包）与 `mixed_of`（混合媒介枚举）收敛分类字段（枚举校验 + 缺失回退，老格式输出照常解析）；看图深度档位 fast（最多再细看 1 次）/ standard（1-2 次，默认，与之前行为一致）/ deep（2-4 次），配额只在工具实际产出证据后递增、失败调用不烧额度；档位与混合分支在 fast 下保持一致（退化为单主分支）；默认配置零回归。
- **1+x deep-dive guidance (#178, thanks to shaoqiuyuavailable)**: after the structured pre-scan the model now receives scene/content-aware guidance — mixed images (visual_kind=mixed) split into at most 2 guided branches so the other half is never missed (cost capped at 2 extra calls); the bootstrap schema gains `content_kind` (person/animal/plant/food/vehicle/machine/architecture/object/scene/meme) and `mixed_of` (mixed media enum) convergent-classification fields (enum-validated with missing-value fallback — old-format output still parses); a vision depth tier fast (at most 1 more look) / standard (1-2 looks, default, identical to previous behavior) / deep (2-4 looks) caps extra looks, with quota incremented only after a tool actually produces evidence (failed calls do not burn quota); fast tier and mixed branches stay consistent (degrades to a single main branch); default config is zero-regression.

### 设置体验 / Settings UX

- **深度档位与自定义引导移到主设置区（#203）**：两个控件原本埋在「高级设置 → 性能」折叠区导致找不到；现在跟随「结构化预识别」开关显示在主设置区（新分组「识图深度（可选）」），并把「引导文案覆盖」重写为白话「自定义识图引导（可选）」——带具体示例、档位选项改为「快速/标准/细致」、占位符与按钮全部口语化，中英文同步。
- **Depth tier and custom guidance moved into the main settings (#203)**: both controls were buried inside the collapsed "高级设置 → 性能" group and could not be found; they now appear in the main settings area gated on the "结构化预识别" toggle (new group "识图深度（可选）"), and the jargon "引导文案覆盖" is rewritten in plain language as "自定义识图引导（可选）" with a concrete example, friendlier tier labels (快速/标准/细致), and clearer placeholders/buttons in both languages.

### 平台 / Platform

- **恢复附件放宽（#201）**：#198 移除的 `attachment-local` 补丁被核实为过度谨慎——dsh-base 0.1.0-rc.6/rc.7 两侧 bundle 都保留 `- id: attachment-local` 行，attachment-local 两侧 schema 都有可选 `maxImageBytes?/maxImagePixels?` 字段。恢复 5MB/4000 万像素 → 20MB/1 亿像素的宿主准入放宽：超长聊天记录截图（vision_long_screenshot_ocr 主场景）与大尺寸设计稿/扫描图可正常过审，rc6/rc7 均有效、不破坏 host-neutral。
- **Attachment widening restored (#201)**: #198's removal of the `attachment-local` patch was verified over-cautious — dsh-base 0.1.0-rc.6/rc.7 both keep the `- id: attachment-local` bundle row, and attachment-local on both runtimes declares optional `maxImageBytes?/maxImagePixels?`. The 5MB/40MP → 20MB/100MP host admission widening is back: long chat-log screenshots (the main vision_long_screenshot_ocr workload) and large design files/scan images pass again, on both rc6 and rc7, without breaking host-neutrality.

### 验证 / Validation

- 全量套件 **476 项测试全部通过（0 失败、0 跳过）**，Node 22 与 Node 24 均通过，Windows / macOS / Linux 宿主安装测试全绿。发布由 tag 触发的 immutable Release workflow 再次执行完整验证，并经 npm Trusted Publishing（OIDC）发布。
- Full suite passes **476 tests (0 failures, 0 skips)** on Node 22 and Node 24, with green Windows / macOS / Linux host-install jobs. The immutable tag-based Release workflow re-runs full verification and publishes through npm Trusted Publishing (OIDC).

## v1.6.0

> **v1.5.3 → v1.6.0**：视觉后端显式授权（P0）——仅在 DSH Settings→Models 里配置过的付费视觉模型不再被隐式调用，视觉工具只允许调用 Vision Router 中明确选择的 provider/model；「DeepSeek + 自动识图」身份钉死官方 DeepSeek。同时带来 macOS 路径与全页截图修复、rc.7 Models 目录恢复、安装诊断归属修正、设置引导滚动性能、Android/Termux 附件兼容，消除每个用户安装时都会出现的 pnpm peer 依赖告警，并把一键更新彻底改成「从正在运行的插件真实路径反查所属 profile、不确定就拒绝」的安全模型。
> **v1.5.3 → v1.6.0**: explicit vision-backend authorization (P0) — paid visual models merely configured under DSH Settings→Models are no longer callable implicitly; vision tools may only call exact provider/model pairs selected in Vision Router, and the DeepSeek + 自动识图 identity is pinned to official DeepSeek. Plus macOS path and full-page screenshot fixes, rc.7 Models-directory recovery, corrected install diagnostics, settings-guide scroll performance, Android/Termux attachment compatibility, removal of the pnpm peer-dependency warning shown on every user install, and a fail-closed one-click updater that infers the owning profile from the running plugin's real path instead of defaulting to web.

### 授权与安全 / Authorization & security

- **视觉后端显式授权（P0，#191）**：此前 `vision_describe` 的兜底链会自动发现并调用整个 DSH 注册表里声明图像能力的模型——只要在 DSH Settings→Models 配置过某个付费 provider（如 Kimi/小米），即使从未在 Vision Router 中选择它，视觉工具也可能拿它发起调用。现在工具执行期间宿主级模型发现被屏蔽（`listProviders` 返回空），流层做硬门控：未授权的 adapter 后端调用直接以 `NO_ADAPTER` 拒绝（且不会落入 direct-HTTP bridge 绕过路径）；每次工具调用冻结一份允许列表快照；插件自有的 HTTP/OVH 内置链与显式启用的本地视觉后端不受影响。回归测试复现了宿主目录含 Kimi/小米 的场景并断言零未授权调用。
- **Explicit vision-backend authorization (P0, #191)**: the `vision_describe` fallback walk used to auto-discover and call every image-capable model in the DSH registry — configuring a paid provider (Kimi/Xiaomi, etc.) under DSH Settings→Models made it callable even if never selected in Vision Router. Host-wide discovery is now hidden during tool execution (`listProviders` returns empty), and the stream layer hard-gates: unauthorized adapter-backed calls are refused as `NO_ADAPTER` (and cannot slip through the direct-HTTP bridge). The allowlist snapshot is frozen per tool call; the plugin-owned HTTP/OVH chain and explicitly enabled local backends are unaffected. Regression tests reproduce a host catalog containing Kimi/Xiaomi and assert zero unauthorized calls.

- **「DeepSeek + 自动识图」身份钉死官方 DeepSeek（#191）**：主 wrapper 的模型元数据、委托调用、retryPolicy 与 Settings→Models 目录别名全部指向官方/native DeepSeek，`textProvider` 配置不再能静默改变这个 DeepSeek 标签行的真实后端；第三方 provider 只能通过各自的 `<provider>-vision` twin 或显式视觉后端选择进入。全轮路由模式下配置驱动的 `provider/model（视觉）` 复合选择器条目已恢复（#192）。
- **DeepSeek + 自动识图 identity pinned to official DeepSeek (#191)**: the main wrapper's model metadata, delegate dispatch, retry policy and Settings→Models directory alias all point at official/native DeepSeek; a stale `textProvider` can no longer silently reroute the DeepSeek-labelled row to Kimi/OpenRouter. Third-party providers remain available through their own `<provider>-vision` twins or explicit vision-backend selection. The config-driven `provider/model（视觉）` composite picker rows in whole-turn routing mode are restored (#192).

- **对抗性运行时边界（#184 / #187）**：HTML 截图强制 Chrome 沙箱 + 离线模式 + 本地资源请求拦截，截图产物限制在工作区内，截图权限接口加同源守卫，进程级 fetch patch 与后续插件可组合。#187 修复了 macOS `/var`→`/private/var` 软链下的路径包含误判（本地资源被误拒），恢复全页截图的滚动唤醒（首屏以下懒加载/滚动触发内容不再静默缺失），并让空页面的高度测量把 `innerHeight` 计入，不再误报超限。
- **Adversarial runtime boundaries (#184 / #187)**: HTML screenshots enforce the Chrome sandbox, offline mode and local-request interception; artifacts stay inside the workspace; the screenshot-permission endpoint gains a same-origin guard; the process-wide fetch patch composes with later plugins. #187 fixes the macOS `/var`→`/private/var` symlink containment false-negative (local assets were wrongly rejected), restores the full-page scroll wake (below-the-fold lazy/scroll-triggered content is no longer silently missing), and includes `innerHeight` so empty pages are not misreported as over the pixel limit.

### 稳定性与性能 / Stability & performance

- **设置引导滚动门控（#174）**：引导层的解析结果缓存 + 250ms 限频 + 600ms 保活兜底，滚动帧只做一次小元素 rect 读取与样式写入，不再每帧 querySelectorAll 强制布局；回归测试断言滚动帧零 DOM 查询、刷新次数有界。
- **Settings-guide scroll gate (#174)**: cached walkthrough resolution with a 250ms throttle and a 600ms keep-alive; scroll frames now only read one small element's rect and write spotlight/prompt styles instead of per-frame querySelectorAll forced layout. Regression tests assert zero DOM queries per scroll frame and bounded refreshes.

- **Models-directory 别名生命周期（#189 / #192）**：rc.7 可配置 provider 目录的注册清理现在挂在插件自身 fiber 上——插件 reload 后旧目录行被正确回收、新实例正常重发布，不再出现「目录行被误判为外部所有而永久冻结」；撤回路径记录空集状态键避免多余 replace，重复告警去重。
- **Models-directory alias lifecycle (#189 / #192)**: the rc.7 configurable-provider registration is now disposed with the plugin's own fiber — a reload withdraws the old row and re-publishes cleanly instead of freezing on a stale row misread as externally owned; the withdrawal path records the empty-state key to avoid redundant replaces, and identical warnings are deduplicated.

- **逐会话推理强度记忆上限（#190）**：按 sessionId 键控的 reasoning-effort 记忆加上限（512 条，FIFO 淘汰 + 读取刷新热度），长驻进程不再无界增长。
- **Bounded per-session reasoning-effort memory (#190)**: the sessionId-keyed reasoning-effort memory is capped (512 entries, FIFO eviction with read-refreshed recency), so long-running processes cannot grow it without bound.

### 诊断 / Diagnostics

- **profile 级 pnpm 失败归属修正（#186 / #188）**：新增 profile 级安装失败诊断（识别 profile 中其他已装插件的 build 阻断）；修正归属逻辑——`Ignored build scripts` 里只有已声明的 profile 依赖（或已知共存视觉插件）才被当作可移除 blocker，Vision Router 自身的传递依赖（sharp）不再被误判为「别人的插件」并给出有害的 `remove sharp` 建议，而是指向 `pnpm approve-builds`/`onlyBuiltDependencies`；裸名忽略列表与 scoped 包均能解析，失败行匹配改用词边界。
- **Corrected profile-level pnpm failure attribution (#186 / #188)**: new profile-level install-failure diagnostics that surface build blockers from other installed profile plugins; attribution now only treats declared profile dependencies (or known coexisting vision plugins) as removable blockers — Vision Router's own transitive dependencies (sharp) are no longer misattributed with a harmful `remove sharp` suggestion and instead point at `pnpm approve-builds`/`onlyBuiltDependencies`; bare-name ignore lists and scoped packages parse correctly, and failure-line matching uses word boundaries.

### 更新与自更新 / Update & self-update

- **一键更新绑定到正在运行的 profile（根治，#195）**：彻底删除了「没有 `--profile` 就默认 web」的逻辑——Web、Desktop、任意自定义 profile 一律从当前正在运行的 dsh-vision-router 的真实安装路径（pnpm 软链接/link/workspace 场景经 `realpath` 解析）反查它属于哪个 profile；即便显式传了 `--profile` 也要验证该 profile 确实拥有正在运行的插件。0 个匹配、多个 profile 同时匹配、路径不明、profile 冲突时一律禁止一键更新、绝不猜测；更新真正执行前再做第二次归属校验，防止启动后目录被重链/替换；更新完成后只检查同一个已验证 profile 中的实际安装版本，杜绝「web 更新成功、desktop 其实没动」的假成功。共享 linked 包等极端场景结果也是「拒绝自动更新」，不会更新错 profile。
- **One-click update bound to the active profile (root-cause fix, #195)**: the "default to web without --profile" behavior is gone — Web, Desktop and any custom profile now infer the owning profile from the real install path of the running plugin (symlink/link/workspace installs resolved via `realpath`); even an explicit `--profile` must be verified to own the running plugin. Zero matches, multiple matches, unknown paths and profile conflicts all refuse the one-click update instead of guessing; a second ownership check runs immediately before mutation, and the post-update version check only inspects the same verified profile — no more "web updated but desktop was untouched" false success. Extreme shared-linked-package layouts also refuse auto-update rather than risk mutating the wrong profile.

### 平台 / Platform

- **DSH rc.7 Models 目录行恢复（#185）**：deepseek-vision 以官方 DeepSeek 的派生别名发布进 rc.7 的 configurable-provider 目录，重装后 Settings→Models 恢复「DeepSeek + 自动识图」分组行；旧运行时特性检测自动降级。
- **DSH rc.7 Models-directory row restored (#185)**: deepseek-vision is published into rc.7's configurable-provider directory as a derived alias of official DeepSeek, restoring the Settings→Models group row after reinstall; older runtimes feature-detect and no-op.

- **Android/Termux 附件兼容（#193）**：Termux 下附件本地存储的持久化目录遍历会因 `/data/data` 权限被拒而失败；新增 Android 专属兜底——仅当宿主 `saveImage()` 因嵌套 `EACCES`/`EPERM` 失败时，回退到进程内有界的临时引用并配私有 `readImage()` 包装，宿主附件服务与非 Android 运行时语义完全不变。
- **Android/Termux attachment compatibility (#193)**: the attachment-local durability walk fails on Termux because `/data/data` cannot be opened; a new Android-only fallback activates only when the host `saveImage()` fails with nested `EACCES`/`EPERM`, using a bounded process-local reference plus a private `readImage()` wrapper — host attachment semantics and non-Android runtimes are unchanged.

### 安装体验 / Install experience

- **消除每次安装的 pnpm peer 依赖告警**：`@deepseek-ai/dsh-anonymous-user-id`、`@deepseek-ai/dsh-llm-deepseek`（由 DSH 宿主模块图解析）与 `sharp`（缺省回退宿主实例）三个 peer 声明为 optional——profile 级 pnpm 看不到宿主包，之前每个用户安装都会打出 `Issues with peer dependencies found` 警告。optional 后安装静默，运行时的「优先宿主实例」语义完全不变。
- **No more pnpm peer-dependency warning on every install**: the three peers — `@deepseek-ai/dsh-anonymous-user-id` and `@deepseek-ai/dsh-llm-deepseek` (resolved through the DSH host's own module graph) and `sharp` (host-instance fallback) — are now marked optional. Profile-level pnpm cannot see host packages, so the mandatory peers printed `Issues with peer dependencies found` on every user install; optional peers silence it while the prefer-host runtime semantics stay exactly the same.

### 验证 / Validation

- 全量套件 **429 项测试全部通过（0 失败、0 跳过）**，Node 22 与 Node 24 均通过，Windows / macOS / Linux 宿主安装测试全绿。发布由 tag 触发的 immutable Release workflow 再次执行完整验证，并经 npm Trusted Publishing（OIDC）发布。
- Full suite passes **429 tests (0 failures, 0 skips)** on Node 22 and Node 24, with green Windows / macOS / Linux host-install jobs. The immutable tag-based Release workflow re-runs full verification and publishes through npm Trusted Publishing (OIDC).

## v1.5.3

> **v1.5.2 → v1.5.3**：修复 DSH 0.1.0-rc.6 上 update-check / self-update / model-capabilities 三个 host 路由缺失、视觉后端退化循环输出被当作成功结果、以及设置页与图片提醒中让用户误以为模型不可用的文案；新增逐后端视觉调用诊断日志与视觉后端链保存规范化。
> **v1.5.2 → v1.5.3**: fixes the missing update-check / self-update / model-capabilities host routes on DSH 0.1.0-rc.6, guards against degenerate repetition-loop vision output masquerading as success, and rewords copy that made users think their models were unusable; adds per-backend vision-call diagnostics and provider-chain save canonicalization.

### 更新与路由 / Updates & routes

- **修复 DSH 0.1.0-rc.6 上 update-check / self-update / model-capabilities 路由缺失（#160 / #166）**：v1.5 引入的本地视觉稳定层曾把注入的 `webServer` child context 换成 Proxy，导致这三个 host 路由静默丢失——设置卡「检查更新」拿到的是 Web UI 的 HTML 而不是 JSON，界面报「更新检查接口返回了无效响应」。现在保持注入上下文原样（不再代理/替换，保留对象身份），截图权限接口改用独立 raw `webServer` injection，多本地后端连接探测移回 core。新增 child-context 身份与本地回退的回归测试。
- **Fix missing update-check / self-update / model-capabilities host routes on DSH 0.1.0-rc.6 (#160 / #166)**: the local-vision stabilizer introduced in v1.5 replaced the injected `webServer` child context with a Proxy, silently dropping these three host routes — the Settings card's "Check for updates" received the Web UI's HTML instead of JSON and reported an invalid response. The injected context is now left unproxied (original identity preserved), the screenshot-permission endpoint mounts through a dedicated raw injection, and multi-local connection probing moved back into core. Regression tests cover child-context identity and local fallback.

### 识别链路 / Vision chain

- **重复循环输出守卫（#171）**：部分视觉后端在长约束输出（结构化预识别 JSON 模式 + 高截图）下会退化成「網絡路由器 互聯網 路由器…」式的循环，并且伪装成成功结果，导致兜底链从不运行、垃圾内容进入会话。现在每次后端返回内容后检测循环特征（精确周期 / 连续重复 / 词元密度），命中即判为 `REPETITION` 失败，交给现有逐后端兜底机制自动切换下一个候选。新增 9 个守卫测试。
- **Repetition-loop guard (#171)**: some vision backends degenerate into repetition loops (a short router/datacenter phrase repeated hundreds of times) on long constrained output such as the structured-bootstrap JSON schema over a tall screenshot — output that looks like a successful backend result, so the fallback chain never ran and garbage reached the conversation. Output is now checked for the loop signature (exact period / consecutive run / token density) right after each backend response; a hit becomes a classifiable `REPETITION` failure and the existing per-backend fallback machinery moves to the next candidate. 9 new guard tests.

- **逐后端诊断日志（#172）**：成功调用此前不留任何痕迹，退化后端与健康后端在日志里无法区分。现在每次后端尝试都会写插件诊断日志——跳过（熔断原因）、成功（后端、内容长度、耗时、JSON 纠正重试）、失败/回退（后端、失败类别、耗时）。扩展了挂起本地后端端到端测试断言日志携带后端标识。
- **Per-backend call diagnostics (#172)**: successful vision calls left no trace, so a degenerate backend was indistinguishable from a healthy one in the logs. Every backend attempt is now logged to the plugin diagnostics file — skips (circuit-open reason), successes (backend key, content length, latency, JSON-correction retries), and failures (backend key, failure kind, latency in the fallback warn). The hung-local-backend e2e test now asserts the backend key appears in both.

### 文案 / Copy

- **设置页模型能力警告去告警化（#169）**：「⚠️ 无法读取此模型的图片能力声明…」「⚠️ DSH 未声明此模型支持图片输入…」「⚠️ DSH 将此模型标记为仅文本…」三条警告改为「不影响使用 / 仍可直接使用 / 会在调用时自动验证，失败自动切换」的口吻并去掉 ⚠️ 图标——它们只是提示，模型仍可选用且会实际尝试。
- **Settings capability warnings no longer read as breakage (#169)**: the three model-list warnings ("⚠️ 无法读取此模型的图片能力声明…", "⚠️ DSH 未声明此模型支持图片输入…", "⚠️ DSH 将此模型标记为仅文本…") now lead with usability ("不影响使用 / 仍可直接使用 / verified automatically on the call") and drop the alarm icon — they are advisories, and the model remains selectable and is tried for real.

- **图片注入提醒友好化（#169）**：图片上传与结构化预识别（1+x 流程）的注入提醒不再以「当前文本模型无法直接查看图片」开头，改为「已收到图片…我可以借助视觉工具来看图」并用平实语言解释流程；全部功能约束（先 `vision_bootstrap`、不预选模式、x >= 1 深挖证据调用、`ok:false` 故障兜底、图中文字不可信）原样保留。
- **Friendlier image reminders (#169)**: the reminders injected on image upload and by the structured-bootstrap (1+x) flow no longer open with "当前文本模型无法直接查看图片"; they now lead with "已收到图片…我可以借助视觉工具来看图" and explain the workflow in plain language. Every functional constraint is preserved (first call must be `vision_bootstrap`, no mode preselection, x >= 1 evidence call before answering, `ok:false` failure fallback, text inside images stays untrusted).

### 稳定性与性能 / Stability & performance

- **设置引导滚动同步性能门控（#170）**：引导模块的 document 级滚动监听改为仅在激活阶段工作，滚动同步经 rAF 合并，避免每事件强制布局带来的卡顿。
- **Settings-guide scroll sync gated behind the active phase (#170)**: the guide's document-level scroll listener now only works while its phase is active, and scroll syncs are coalesced through rAF, removing the per-event forced-layout cost.

- **视觉后端链保存规范化（#168）**：后端链在保存/读回前做规范化，避免重复或坏条目进入配置。
- **Provider-chain save canonicalization (#168)**: the vision-provider chain is canonicalized before save/readback so duplicates or malformed entries do not reach the configuration.

### 验证 / Validation

- 全量套件 **368 tests pass**，Node 22 与 Node 24 均通过。发布由 tag 触发的 immutable Release workflow 再次执行完整验证，并经 npm Trusted Publishing（OIDC）发布。
- Full suite passes **368 tests** on Node 22 and Node 24. The immutable tag-based Release workflow re-runs full verification and publishes through npm Trusted Publishing (OIDC).

## v1.5.2

> **v1.5.1 → v1.5.2 紧急补丁**：修复当前 DSH keyed Settings slot 契约下会导致客户端插件直接加载失败的问题。
> **v1.5.1 → v1.5.2 emergency hotfix**: fixes a client-loader failure under the current DSH keyed Settings-slot contract.

### 客户端加载 / Client loading

- **修复 `settings.plugin.item` keyed-slot 注册（#160 / #162）**：Vision Router 的设置卡注册现在显式携带 `key: 'vision-router'`，不再只提供 `id`。这修复了 Harness 启动时的 `Failed to load plugins` / `keyed slot "settings.plugin.item" requires options.key`，避免插件在进入设置卡之前就被 loader 拒绝。现有 `id`、排序、文案、注入与视觉运行时行为均保持不变。
- **Fix keyed `settings.plugin.item` registration (#160 / #162)**: the Vision Router Settings card now supplies the required `key: 'vision-router'` in addition to its existing `id`. This fixes the Harness startup error `Failed to load plugins` / `keyed slot "settings.plugin.item" requires options.key`, where the loader rejected the client plugin before the Settings card could mount. Existing ordering, labels, injection, and vision runtime behavior are unchanged.

### 验证 / Validation

- 新增 keyed-slot 回归测试；全量套件为 **355 tests：350 pass + 5 macOS-only skips + 0 fail**，Node 22 / Node 24 均通过。发布仍由既有 immutable Release workflow 在 tag 上再次执行完整验证，并通过 npm Trusted Publishing（OIDC）发布。
- Added a keyed-slot regression guard. The full suite is **355 tests: 350 pass + 5 macOS-only skips + 0 fail** on Node 22 and Node 24. The existing immutable tag-based Release workflow re-runs full verification and publishes through npm Trusted Publishing (OIDC).

## v1.5.1

> 本节为 **v1.5.0 → v1.5.1** 的补丁版本说明，覆盖 v1.5.0 发布后合入的全部用户可见修复。
> This is the **v1.5.0 → v1.5.1** patch release summary, covering all user-visible fixes merged after v1.5.0.

### 更新与安装 / Update & Install

- **更新恢复彻底改为精确版本（#151 / #158）**：设置页手动兜底不再生成裸 `update dsh-vision-router`，正常版本发现会始终生成 `add dsh-vision-router@<具体版本>`；配置 registry 失败后会依次尝试 npm 官方源与 GitHub Releases 获取精确版本。若三路版本源全部失败，则只显示 `@<version>` 模板并要求用户先确认 Release，彻底移除可能被 pnpm 11 `minimumReleaseAge` 静默拦截的 `@latest` 最后兜底。同时补齐无效响应校验与可读错误，不再显示 `unknown`。
- **Exact-version update recovery (#151 / #158)**: manual recovery no longer emits bare `update dsh-vision-router`; when a version can be resolved it always uses `add dsh-vision-router@<exact-version>`. Version discovery now falls through configured registry → official npm → GitHub Releases. If all three are unavailable, the UI shows only an `@<version>` template and requires a confirmed Release instead of falling back to ambiguous `@latest`, eliminating the remaining pnpm 11 `minimumReleaseAge` false-success path. Invalid responses and missing diagnostics now surface readable errors instead of `unknown`.

### 稳定性与离线兜底 / Reliability & Offline Recovery

- **隐藏设置写入不再形成循环（#155 / #156）**：首次引导 / walkthrough 的隐藏状态持久化改为幂等写入，并记住页面生命周期内已经尝试过的相同 mutation。即使宿主拒绝写入或返回旧状态，也不会被 subscriber churn 反复触发；真实状态迁移（如 `step1 → step2 → unset`）仍可正常保存。
- **Hidden Settings mutations no longer loop (#155 / #156)**: onboarding / walkthrough hidden-state persistence is idempotent and remembers identical mutations already attempted during the page lifetime. Rejected or stale host readback can no longer trigger endless `settings.mutate` churn, while legitimate transitions such as `step1 → step2 → unset` still persist normally.

- **新增离线附件落地兜底 `vision_materialize`（#153 / #157）**：当 `vision_describe` / `vision_bootstrap` 的视觉基础设施不可用时，失败结果会携带精确 attachment ID，并引导 Agent 使用 `vision_materialize` 将已授权上传附件复制到会话 workspace，获得真实文件路径后交给本地 OCR / parser 等离线流程。该桥接不发起网络或视觉请求，也不暴露 DSH 私有 `~/.dsh/attachments/...` 存储布局；工具结果已接入聊天内工具 UI。默认常驻深看工具总数因此为 14 个。
- **Offline attachment materialization with `vision_materialize` (#153 / #157)**: when `vision_describe` / `vision_bootstrap` infrastructure is unavailable, failures carry the exact attachment IDs and direct the agent to copy an authorized upload into the session workspace, yielding a real filesystem path for local OCR/parsers. The bridge performs no network or vision call, does not expose DSH's private attachment-storage layout, and renders materialized artifacts in the tool UI. The default always-mounted deep-tool set is now 14 tools.

### 验证 / Validation

- Node 22 / Node 24 全量测试通过；Windows / macOS / Ubuntu 的宿主打包与 shared-sharp 回归全部通过。新增回归覆盖更新精确版本兜底、三路版本源全失败、隐藏设置 mutation 幂等，以及 attachment ID 离线落地契约。
- Full tests pass on Node 22 / Node 24, with packed-host + shared-sharp regression green on Windows, macOS, and Ubuntu. New coverage locks down exact-version update recovery, all-version-source failure behavior, idempotent hidden Settings mutations, and attachment-ID materialization contracts.

## v1.5.0

> 本节为 **v1.4.4 → v1.5.0 的累计发布说明**：既包含已经随 v1.4.5 发布的全部更新，也包含 v1.4.5 之后直到本版本的新增改动。
> This section is a **cumulative v1.4.4 → v1.5.0 release summary**: it includes everything shipped in v1.4.5 plus all changes added after v1.4.5 through this release.

### 重点新增 / Highlights

- **本地视觉后端：Ollama + LM Studio（#141 / #143）**：可在设置中直接启用本机 Ollama 或 LM Studio 作为识图后端，支持 OpenAI Chat Completions / Anthropic Messages 两种本地协议形态，并保留显式设置的 `temperature` / `top_p`。本地后端参与视觉降级链；同时开启时按 Ollama → LM Studio 顺序尝试，单个后端挂起不会吃掉整轮预算，连接测试也会继续探测下一个本地后端。
- **Local vision backends: Ollama + LM Studio (#141 / #143)**: enable a local Ollama or LM Studio server directly from Settings, with OpenAI Chat Completions or Anthropic Messages wire formats and preservation of explicitly configured `temperature` / `top_p`. Local backends join the vision fallback chain; when both are enabled the chain tries Ollama then LM Studio, a hung backend cannot consume the entire task budget, and connection testing falls through to the next local backend.

- **隐私优先的桌面截图识图（#141 / #146）**：新增默认关闭的 `vision_screenshot`。只有用户显式开启后工具才动态注册；关闭后立即卸载。macOS 保存开启状态时会主动做一次丢弃式 `screencapture` 权限探测以触发系统“屏幕录制”授权，临时文件随即删除。截图可直接交给已配置的本地视觉后端识别。
- **Privacy-gated desktop screenshot vision (#141 / #146)**: add `vision_screenshot`, off by default and dynamically registered only after explicit opt-in; turning it off removes the tool immediately. On macOS, saving the enabled setting performs a throwaway `screencapture` probe to trigger Screen Recording permission and deletes the temporary file immediately. Captures can be identified through configured local vision backends.

- **结构化预识别 1+x（来自 v1.4.5，#136 / #139 / #146）**：图片任务可选先做 1 次与具体任务目标解耦的结构化视觉基线，再强制聊天模型围绕原问题至少追加 1 次证据/深挖视觉工具调用（`x >= 1`）。首遍稳定产出 `visual_kind`、`regions`、`visible_text`、`entities`、`relationships`、`uncertainties`、`recommended_followups` 等字段；需要 OCR 时优先视觉模型。v1.5.0 进一步把它收敛为**唯一的自动首遍识图开关**，旧 `instantDescribe` / `localDescribeStyle` 仅保留配置兼容，不再制造第二次自动首遍调用。
- **Structured 1+x visual bootstrap (from v1.4.5, #136 / #139 / #146)**: optionally run one task-independent structured visual baseline before requiring at least one task-directed evidence/deepening tool call (`x >= 1`). The first pass returns stable fields such as `visual_kind`, `regions`, `visible_text`, `entities`, `relationships`, `uncertainties`, and `recommended_followups`, preferring vision-model OCR when OCR is actually needed. v1.5.0 further makes this the **single automatic first-pass switch**; legacy `instantDescribe` / `localDescribeStyle` remain loadable for config compatibility but can no longer trigger a second automatic first pass.

### 设置与交互 / Settings & UX

- **设置页按用户任务重组（来自 v1.4.5，#139）**：保留 Quick Start 和三步首次引导，但把“视觉后端链”等工程术语改成“识图模型”等用户语言；第一屏聚焦自动创建、识图工具、1+x、整轮视觉与识图模型链，高级设置拆成性能 / 兼容性 / 网络 / 开发者设置。未保存操作收敛为右上角紧凑 sticky 控件。
- **Settings reorganized around user intent (from v1.4.5, #139)**: keep Quick Start and the three-step guide while replacing implementation vocabulary with user-facing labels such as “Vision model”; the first screen focuses on auto setup, vision tools, 1+x, whole-turn routing, and the vision-model chain, while advanced controls are grouped into Performance / Compatibility / Network / Developer sections. Unsaved actions use a compact top-right sticky control.

- **本地视觉入口与文案重做（#144 / #145 / #146）**：本地视觉以普通一级设置分组展示为“本地视觉 · Ollama / LM Studio”，不再用低对比度灰字，也不使用额外高亮卡片；去除“即时本地翻译/识图”“本地识别输出风格”等重复用户开关，让本地菜单只负责配置后端。桌面截图移出本地后端折叠区，并用常规分隔明确区块边界；补齐中英文“桌面截图识图”等文案。
- **Local-vision entry and copy cleanup (#144 / #145 / #146)**: expose “Local vision · Ollama / LM Studio” as a normal first-level Settings group with standard text weight rather than low-contrast gray or special highlight styling. Remove duplicate user-facing first-pass controls so the local section only configures backends. Desktop screenshot lives outside that backend fold with a standard divider, and missing Chinese/English screenshot copy is filled in.

- **大模型目录下的设置性能恢复（#144）**：恢复 `visionGroups` 的稳定 memo，缩小选项 memo 的依赖，继续配合 `content-visibility` 与有界 option vnode 缓存，避免 OpenRouter 等大目录下滚动、切换和编辑时出现整页级重算；新增回归测试防止再次把 memo 依赖改回每次 render 新数组。
- **Settings performance restored for large model catalogs (#144)**: restore stable memoization for `visionGroups`, narrow option dependencies, and keep `content-visibility` plus bounded option-vnode caches so scrolling, toggling, and editing do not trigger page-scale recomputation on large catalogs such as OpenRouter. Regression tests guard against recreating the memo dependency on a fresh array every render.

### 稳定性与生命周期 / Reliability & Lifecycle

- **本地视觉集成稳定化（#143）**：本地模型统一通过 `callLocalBackend`，保留采样参数；设置中的 URL / 模型 / 协议运行时读取，无需重启；桌面截图工具跟随持久化设置动态挂载；首遍调用受统一任务超时预算约束，并抑制失败后的重复自动首遍；多本地后端连接测试按后端逐个探测与降级。
- **Local-vision integration stabilization (#143)**: local models dispatch through `callLocalBackend` so sampling is preserved; URL/model/protocol changes are read live without restart; screenshot tool exposure follows the persisted setting dynamically; first-pass work is bounded by the task timeout budget and duplicate automatic retries are suppressed; multi-local connection tests probe and fall through backend by backend.

- **冷启动设置卡不再偶发缺席（#147）**：浏览器端不再把可选 `connection` 服务作为 hard inject；设置卡可以在 connection 尚未 ready 时先注册，模型目录继续懒获取服务，解决“第一次进设置看不到，退出再进才出现”的竞态。
- **Settings card no longer disappears on cold start (#147)**: the browser client no longer hard-injects the optional `connection` service. The card can register before connection readiness while the model catalog continues to acquire the service lazily, removing the “missing on first open, appears after reopening” race.

- **生命周期恢复能力专项加固（#148）**：文件日志一次临时写失败不再永久静默，而是指数退避后自动恢复；logger installation 的 WeakMap 缓存随 Cordis plugin fiber 卸载失效，reload 后 HTTP 日志路由会重新挂载；settings service 卸载时释放旧 scope、恢复后重新绑定；webServer 实例更换时桌面截图权限 route 会从旧 server 注销并在新 server 重挂。
- **Dedicated lifecycle recovery hardening (#148)**: a transient file-log write failure no longer disables logging for the process lifetime and instead retries with exponential backoff; the logger-installation WeakMap cache now expires with the Cordis plugin fiber so HTTP log routes remount after reload; stale settings scopes are released and rebound across service replacement; screenshot-permission routes detach from an old webServer instance and remount on its replacement.

- **保留宿主 HTTPS 代理（#149）**：插件加载时不再顶层 import 用户态 Undici；Undici 固定在 7.x，并只在 Vision Router 自己的 selective proxy 真正需要时懒加载 `ProxyAgent`。当插件代理关闭、或请求 host 不在 `proxyHosts` 中时，完全沿用宿主原始 `fetch` 路径，避免覆盖/破坏宿主已有 HTTPS proxy 行为。
- **Host HTTPS proxy is preserved (#149)**: userland Undici is no longer imported at plugin load time, remains pinned to 7.x, and `ProxyAgent` is lazy-loaded only when Vision Router’s own selective proxy is actually needed. When plugin proxying is disabled or the request host is outside `proxyHosts`, the host’s original `fetch` path remains untouched.

- **Windows 打开日志文件夹兼容（来自 v1.4.5，#112）**：`explorer.exe` shell relay 的数字退出码按成功交接处理；真正 spawn 失败时回退到 `cmd /c start`，两条路径都失败时返回机器可读错误码；macOS / Linux 继续严格处理原生非零退出。
- **Windows “Open log folder” compatibility (from v1.4.5, #112)**: numeric `explorer.exe` shell-relay exit codes count as a successful hand-off; real spawn failures fall back to `cmd /c start`, both-path failure returns a machine-readable code, and macOS/Linux retain strict native non-zero handling.

### 文档、兼容与发布工程 / Docs, Compatibility & Release Engineering

- **dsh-web-ui / dsh-web-ui-all 共存说明（来自 v1.4.5）**：README 说明发送钩子若先把图片改写成 `describe-image` 引用会让 Vision Router 收不到原始 image block；新版 dsh-web-ui 可用 `interceptImageSend: false` 关闭该拦截，并按每次发送动态读取。
- **dsh-web-ui / dsh-web-ui-all coexistence note (from v1.4.5)**: the README documents that a send hook which rewrites images into `describe-image` references can hide the original image block from Vision Router; current dsh-web-ui can disable that interception with `interceptImageSend: false`, read dynamically on every send.

- **设计来源归因补充（来自 v1.4.5）**：中英文 README 更明确记录 agent-vision-toolkit / dsh-vision-toolkit 对深度视觉工具层、UI restoration / pixel-diff 闭环、渐进式工具暴露以及部分工具职责/命名的设计影响，并区分本项目独立发展的 turn-level/tools-first routing、DSH 准入/包装、多后端 fallback、免费链、附件/图片记忆、缓存与运行时容错。
- **Expanded design-lineage attribution (from v1.4.5)**: both READMEs more explicitly credit agent-vision-toolkit / dsh-vision-toolkit for influence on the deep-vision tool layer, UI-restoration/pixel-diff loop, progressive tool exposure, and parts of the tool decomposition/naming, while separating Vision Router’s independently developed turn-level/tools-first routing, DSH admission/wrapping, multi-backend fallback, free chain, attachment/image memory, caching, and runtime resilience.

- **npm 发布供应链加固（v1.4.5 之后）**：发布流程改为 npm trusted publishing / OIDC；tag 必须与 `package.json` 版本一致且可从 main 追溯，README/CHANGELOG 必须先写版本；发布时只 pack 一次并记录 tarball SHA-1 / SHA-256，发布后再核对 npm registry tarball 身份；GitHub Release 同时附带 tarball 与 `SHA256SUMS.txt`，避免重复或可变发布。
- **npm release supply-chain hardening (after v1.4.5)**: releases now use npm trusted publishing / OIDC; the tag must match `package.json`, be reachable from main, and already appear in README/CHANGELOG. The workflow packs exactly once, records tarball SHA-1 / SHA-256, verifies registry tarball identity after publish, and attaches both the tarball and `SHA256SUMS.txt` to an immutable GitHub Release.

### 验证 / Validation

- **348 项自动化测试通过**：当前发布点在 Node 22 / Node 24 下均通过；Windows / macOS / Ubuntu 的宿主打包 + shared-sharp 回归也全部通过。测试覆盖 1+x、本地 Ollama/LM Studio、协议与采样、超时/降级、桌面截图权限、设置性能与冷启动、日志恢复、service/webServer 重挂以及宿主代理保护。
- **348 automated tests pass**: the release point passes on Node 22 and Node 24, with packed-host + shared-sharp regression green on Windows, macOS, and Ubuntu. Coverage includes 1+x, local Ollama/LM Studio, wire protocols and sampling, timeout/fallback behavior, desktop screenshot permission, Settings performance and cold start, log recovery, service/webServer remounting, and host-proxy preservation.

## v1.4.5

### 新增 / Added

- **可选的结构化预识别 1+x（实验，#136）**：新增 `structuredVisionBootstrap`（默认关闭）。开启后，每个图片任务先做 1 次**不读取具体任务目标**的通用结构化视觉基线，再要求聊天模型围绕原问题至少追加 1 次证据/深挖视觉工具调用后才能回答（`x >= 1`）；基线稳定返回 `visual_kind`、`regions`、`visible_text`、`entities`、`relationships`、`uncertainties` 与 `recommended_followups` 等信息。结构化流程确实需要 OCR 时，自动模式优先使用视觉模型，降低中文/UI 截图上本地 OCR 噪声；普通识图工具和默认 tools-first 流程不受影响。
- **Optional structured vision pre-scan 1+x (experimental, #136)**: add `structuredVisionBootstrap` (off by default). Each image task first gets one **task-independent** structured visual baseline, then the chat model must make at least one task-directed evidence/deepening vision-tool call before it may answer (`x >= 1`). The baseline exposes stable fields such as `visual_kind`, `regions`, `visible_text`, `entities`, `relationships`, `uncertainties`, and `recommended_followups`. When the structured flow actually needs OCR, auto mode prefers vision-model OCR to reduce noisy local OCR on Chinese/UI screenshots. The normal vision tools and default tools-first flow are unchanged.

### 改进 / Changed

- **设置页按用户任务重新组织（#139）**：保留 Quick Start 与三步首次引导，但把工程实现词汇换成用户可理解的结果描述——「视觉后端链」统一为「识图模型」，第一屏聚焦「自动创建 + 自动识图模型组 / 识图工具 / 结构化预识别 1+x / 整轮交给视觉模型 / 识图模型链」；高级设置重组为**性能 / 兼容性 / 网络 / 开发者设置**，测试连接移动到识图模型附近，版本与诊断下移。整轮视觉路由仍是普通开关，现有配置 key、默认值、provider 与运行时路由语义不变。
- **Settings are reorganized around user intent (#139)**: Quick Start and the three-step first-run guide remain, while implementation vocabulary is replaced with outcome-oriented labels — the “vision backend chain” becomes “Vision model”; the first screen focuses on Auto Vision groups, vision tools, structured 1+x pre-scan, whole-turn vision routing, and the vision-model chain. Advanced controls are grouped into **Performance / Compatibility / Network / Developer settings**, connection testing moves next to vision-model selection, and version/diagnostics move lower. Whole-turn routing remains a normal toggle; existing config keys, defaults, provider behavior, and runtime routing semantics are unchanged.
- **未保存设置操作更轻量（#136 / #139）**：继续保留滚动时随时可用的「未保存 / 放弃修改 / 保存」能力和失败后草稿保留语义，但最终样式从横铺整个卡片的粘性横条收成右上角紧凑 sticky 操作块，去掉重毛玻璃、整行底边与大阴影，减少对内容的遮挡。
- **Lighter unsaved-settings controls (#136 / #139)**: keep the always-reachable Unsaved / Discard / Save behavior and draft retention on failed writes, but replace the full-width sticky banner with a compact top-right sticky action group, removing the heavy blur, full-row divider, and large shadow so it interferes less with the settings content.

### 修复 / Fixed

- **Windows「打开日志文件夹」兼容（#112）**：`explorer.exe` 通过 shell relay 返回数字退出码时按成功交接处理；遇到真正的 spawn 级失败时再回退到 `cmd /c start`，两条路径都失败时返回可机器读取的错误码。macOS / Linux 继续严格处理原生非零退出码，并新增 Windows、macOS、Ubuntu 三端回归覆盖。
- **Windows “Open log folder” compatibility (#112)**: numeric `explorer.exe` relay exit codes are treated as a successful shell hand-off; true spawn-level failures fall back to `cmd /c start`, and failures from both launch paths carry a machine-readable error code. macOS/Linux keep strict native non-zero handling, with regression coverage across Windows, macOS, and Ubuntu.

### 文档与兼容性 / Docs & Compatibility

- **dsh-web-ui / dsh-web-ui-all 共存说明**：中英文 README 新增兼容说明。上游 `dsh-tool-describe-image` 发送钩子若先把图片改写成 `describe-image` 引用，会让 Vision Router 收不到原始 image block；新版 dsh-web-ui 可关闭「发送时改写图片为 describe-image 引用」（`interceptImageSend: false`），且每次发送动态读取，无需重装 hook 或重启 DSH。
- **dsh-web-ui / dsh-web-ui-all coexistence note**: both READMEs now explain that the upstream `dsh-tool-describe-image` send hook may rewrite an image into a `describe-image` reference before Vision Router receives the original image block. Current dsh-web-ui can disable “Rewrite images to describe-image references on send” (`interceptImageSend: false`), read dynamically on every send with no hook reinstall or DSH restart.
- **设计来源与归因补充**：中英文 README 明确记录深度视觉工具层、UI restoration / pixel-diff 闭环、渐进式工具暴露及部分工具职责/命名受到 Anionex/agent-vision-toolkit 与 dsh-vision-toolkit 的设计影响，同时区分本项目独立实现和发展的 turn-level/tools-first routing、DSH 准入/包装、多后端 fallback、内置免费链、附件/图片记忆、缓存与运行时容错。
- **Expanded design-lineage attribution**: both READMEs explicitly credit Anionex/agent-vision-toolkit and dsh-vision-toolkit for influence on the deep-vision tool layer, UI-restoration/pixel-diff loop, progressive tool exposure, and parts of the tool decomposition/naming, while distinguishing the independently implemented turn-level/tools-first routing, DSH admission/wrapping, multi-backend fallback, built-in free chain, attachment/image memory, caching, and runtime resilience.

### 验证 / Validation

- **270 项自动化测试通过**：Node 22 / Node 24 测试矩阵与 Ubuntu / macOS / Windows 宿主打包 + shared-sharp 回归均通过，覆盖本次设置、1+x 和日志目录兼容改动。
- **270 automated tests pass**: the Node 22 / Node 24 test matrix and Ubuntu / macOS / Windows packed-host + shared-sharp regression jobs all pass, covering the settings redesign, 1+x flow, and log-folder compatibility changes.

## v1.4.4

### 修复 / Fixed

- **DSH rc.6 插件配置页空白**：补齐浏览器端插件对 `connection` / `remote` 的运行时依赖声明，并在 package manifest 中显式注入 `@deepseek-ai/dsh-client-connection` 与 `@deepseek-ai/dsh-api-remotes`。`settingsScope.bind()` 现在能从调用方上下文取得设置 transport 与更新事件，配置卡可正常注册；无需手动修改 `settings.yaml`。对应 client / manifest 回归断言同步更新。
- **Blank plugin settings on DSH rc.6**: declare the browser plugin's runtime `connection` / `remote` service dependencies and explicitly inject `@deepseek-ai/dsh-client-connection` plus `@deepseek-ai/dsh-api-remotes` in the package manifest. `settingsScope.bind()` can now resolve its settings transport and invalidation events from the caller context, so the configuration card registers normally without manual `settings.yaml` edits. Client and manifest regression assertions were updated alongside the fix.

## v1.4.3

### 新增 / Added

- **免费视觉 Key 渠道指南（#127）**：README 在 Quick Start 后新增免费视觉 Key 配置入口，方便用户把自己的免费额度接入视觉后端链，绕开内置匿名视觉后端约 2 req/min 的单模型限速；同时精简配置说明，移除不必要的 `settings.yaml` 示例，让安装后更容易直接找到并配置可用渠道。
- **Free vision-key channel guide (#127)**: the README now surfaces free vision-key setup immediately after Quick Start, making it easier to bring free personal quota into the vision chain instead of relying on the built-in anonymous backend's roughly 2 req/min per-model limit. The setup was also simplified by removing the unnecessary `settings.yaml` example.

### 改进 / Changed

- **自定义视觉后端改为运行时验证（#128 / #130）**：DSH 的图片能力元数据现在只作提示，不再作为准入门槛。设置 → 模型中可调用的生成式模型都会出现在视觉后端链里；未声明图片能力或被标成仅文本的模型仍可手动选择并显示警告。运行时始终先走供应商已注册的 DSH adapter，HTTP、WebSocket、RPC 与私有协议保留原生传输；只有明确识别为 http(s) OpenAI Chat Completions 的渠道才允许进入直连兼容桥。实际图片调用失败后继续自动尝试下一后端；embedding/reranker 与插件自身包装路由仍结构性排除。`extraVisionModels` 降级为可选能力标记覆盖，不再是解锁模型的前置条件。
- **Custom vision backends are now runtime-verified (#128 / #130)**: DSH image-capability metadata is advisory instead of an admission gate. Any callable generative model from Settings → Models can be selected in the vision chain; undeclared or text-only-labelled models remain selectable with warnings. Runtime dispatch is adapter-first, preserving native HTTP, WebSocket, RPC and private transports; the direct compatibility bridge is used only for positively identified http(s) OpenAI Chat Completions channels. A real image-call failure falls through to the next backend, while embedding/reranker endpoints and the plugin's own generated wrapper routes remain structurally excluded. `extraVisionModels` is now an optional capability-label override rather than an unlock requirement.

### 修复 / Fixed

- **视觉失败摘要不再出现重复句号（#131）**：当 adapter 自身错误已经以句号或其他句末标点结束时，整轮失败汇总不再额外追加一个 `.`，避免出现 `..`；新增回归测试覆盖英文与中文句末标点。
- **Vision failure summaries no longer produce doubled punctuation (#131)**: when an adapter error already ends in terminal punctuation, the whole-turn failure summary no longer appends another period, avoiding `..`; regression coverage includes English and Chinese sentence endings.

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

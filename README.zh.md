<p align="center">
  <img src="assets/hero-zh.svg" width="100%" alt="DSH Vision Router——为 DeepSeek Harness 的纯文本 Agent 提供视觉能力" />
</p>

<h1 align="center">dsh-vision-router</h1>

<p align="center"><strong>图片粘贴即用：给 DeepSeek Harness 的纯文本 Agent 装上“眼睛”——开箱免费、免 Key、无 Python、一条命令安装。</strong></p>

<p align="center">DeepSeek 只负责思考，内置免费视觉链 + 10 个像素级工具负责“看”；图片轮次就像普通工具调用一样自然、可定位、可验证。</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
  <a href="https://github.com/zp-home/dsh-recommend"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2Fysr666__dsh-vision-router.certified.json&amp;style=flat-square" alt="dsh-recommend 🏅 精选认证" /></a>
  <a href="https://github.com/zp-home/dsh-recommend"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2Fysr666__dsh-vision-router.json&amp;style=flat-square" alt="dsh score 0.90" /></a>
</p>

<p align="center">
  <a href="https://github.com/ysr666/dsh-vision-router/releases/tag/v1.2.1"><img src="https://img.shields.io/badge/release-v1.2.1-5B4CF0?style=flat-square" alt="Release v1.2.1" /></a>
  <a href="tests"><img src="https://img.shields.io/badge/verified-149%20tests-2EA44F?style=flat-square" alt="Verified: 149 tests" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat-square" alt="License: MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js >=22" /></a>
  <img src="https://img.shields.io/badge/runtime-no%20Python-8A2BE2?style=flat-square" alt="No Python" />
  <a href="cordis.patch.yml"><img src="https://img.shields.io/badge/DSH-Web%20profile-5B4CF0?style=flat-square" alt="DSH Web profile" /></a>
</p>

<p align="center"><a href="README.md">English</a> · 中文</p>

<p align="center">💬 <strong>QQ 用户交流群：1105463028</strong></p>

> [!WARNING]
> 📌 **公告（v1.2.1）**
>
> v1.2.1 加固像素闭环：十个像素工具可直接接受上传图片的附件 ID（告别 `cannot read …/sha256:…` 的绕路），产物文件名带指纹不再互相覆盖，`vision_ground` 对退化框自动重试，模型引导支持从第 1 步完整重放（先退出设置页），设置卡片在数百模型目录下滚动依然流畅。

<p align="center">
  <img src="assets/vision-demo.gif" width="640" alt="演示：粘贴图片，Agent 用 vision_ground / vision_crop / vision_pixel_diff 定位发送按钮并给出坐标" />
</p>

## 为什么做这个

大多数 DSH 视觉插件把图片“翻译”成一段文字描述再喂给 DeepSeek——有损、一次性、看不见像素。本插件把**原图像素留在视觉模型侧**、把推理留在 DeepSeek 侧，并把“看图”变成一次**普通的工具调用**：

- **一条命令安装。** 包自带组合补丁（`dsh.bundle.patch`）：`dsh plugin add` 自动完成插件行挂载、准入包装与附件限制放宽——不用手改任何文件。是否接管官方 DeepSeek 路由由「隐身模式」开关决定（默认关）。
- **默认免费。** 视觉工具最终兜底为 5 个 OVHcloud 匿名视觉模型：免注册、免 Key，每 IP、每模型 2 次/分钟，独立限额理论合计约 10 次/分钟；用户自备视觉模型会优先调用。
- **无 Python。** 整条管线——缩放、定位、裁剪、像素对比、取色、OCR、SVG 矢量化、抠图、HTML 截图——全部基于 sharp / potrace / tesseract / 系统 Chrome。
- **可连续多步看图。** 图片轮 = 调用工具的文本轮：`vision_ground` → `vision_crop` → `vision_describe` → `vision_pixel_diff` → 修复 → 再截图，Agent 可以一直迭代到任务完成。
- **DeepSeek 始终是大脑。** 文字轮在模型、成本、上下文上完全不动；视觉模型只当“眼睛”、按需调用，答案按图片内容缓存。
- **界面无感。** 上传的图片在会话界面里照常显示为图片；指向视觉工具的改写只发生在模型输入层，从不写入会话日志。

## 对比同类插件

最接近的同类是 [@anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit)（Anionex），它是知名 `agent-vision-toolkit` 系列的 DSH 原生版。两者都提供 `vision-tools` 技能和一组像素级工具，区别在理念：**零配置粘贴即用** vs **Agent 主导的视觉工程**：

| | dsh-vision-router | @anionex/dsh-vision-toolkit |
|---|---|---|
| 开箱图片问答 | ✅ 内置免费视觉链（OVHcloud 匿名端点），免注册免 Key | 远程工具需自备视觉 API Key（本地像素工具免 Key） |
| 运行时 | ✅ 纯 Node，无需 Python | 需要 Python 3.11+ 受管运行时 |
| 图片怎么进来 | ✅ 选一次「+ 自动识图」模型组后直接粘贴 | 工作区路径 + `/vision-tools` 命令，再显式调用工具 |
| 轮次路由 | ✅ 图片轮切视觉、文本轮切回 DeepSeek——可选隐身接管，模型选择器与官方一致 | 工具驱动，无整轮自动路由 |
| 支持 profile | Web | Web + Headless |
| 玩法库 | 像素循环：定位 → 裁剪 → 对比 → 修复 → 再截图 | 更丰富的案例库（长截图 OCR、UI 还原、GUI 自动化） |
| 测试 | 144 | 162 |
| 安装 | 一条命令 | 一条命令（npm） |

两者都是 MIT 许可、一条命令安装。想要图片**粘贴即用**、零配置就选本插件；需要 Headless 部署或更丰富的案例库，可以看 @anionex/dsh-vision-toolkit。（功能对比以其 README 2026-08 状态为准。）

## 快速开始

### 1. 安装并让插件加载

普通 npm / npx 安装方式推荐这样用（与 DSH 官方 README 的启动方式一致）：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router
npx @deepseek-ai/dsh web
```

如果你是从 DeepSeek Harness 源码仓库通过 pnpm 运行，`dsh` 不一定在系统 `PATH` 里，请改用工作区脚本：

```sh
cd deepseek-harness
pnpm dsh plugin --profile web add dsh-vision-router
pnpm dsh web
```

如果你已经全局安装 DSH CLI，并且终端里能直接执行 `dsh`，也可以继续使用较短的 `dsh ...` 写法。

> [!NOTE]
> 如果你是把插件**首次安装进一个已经长期运行的 Web 进程**，需要让 DSH Web 进程重新加载一次插件本体。插件加载完成后，新增/删除模型、修改自动识图包装范围都会**热更新，无需再重启 DSH**。

### 2. 在聊天页切换到「+ 自动识图」模型组

插件加载后会自动发现 **设置 → 模型** 里已启用的模型组，并为它们额外创建同名的自动识图入口。例如：

```text
opencode-go                 ← 原模型组，保持不变
opencode-go + 自动识图       ← 发图片时选这个
```

> [!IMPORTANT]
> **发图前，请点击聊天页输入区右下角的模型选择器，选择带「+ 自动识图」的模型组。**
>
> Vision Router 故意**不修改原模型组**。因此如果当前仍选着原来的纯文本 `opencode-go` / DeepSeek 路由，DSH 会在插件处理图片之前先提示“当前模型不支持图片”。这不是视觉后端配置失败，只是还没有切到自动识图入口。

这个模型组的模型列表会跟随 DSH 的模型目录实时同步；新增模型或修改包装范围后无需重启。

### 3. 直接粘贴或上传图片

选好「+ 自动识图」模型组后，直接往对话里贴图即可。Agent 会自动挂载视觉工具，通过 `vision_describe`、`vision_ground`、`vision_crop` 等工具看图，需要时连续多步操作。

默认已经有内置 OVH 匿名视觉兜底，无需注册、无需 Key。**聊天页右下角只选择“脑子/会话模型”**；视觉模型不要在那里选。高级配置在 **设置 → 插件 → 插件配置 → 视觉路由（自动识图）**：视觉后端链每一行只选择一个你在 **设置 → 模型** 中已经配置且支持图片输入的用户模型；一行都不填也可以，OVH 免费链会固定在最后兜底。插件内部的 `Vision HTTP` 只是传输实现，不是用户需要选择的模型组。

### 实际效果

*左：一次图片轮——用户发图，Agent 通过免费链路调用 `vision_describe` 并作答。右：最终的结构化解读。*

<p align="center">
  <img src="assets/dsh-conversation-image-qa.png" width="49%" alt="Agent 通过 vision_describe 查看上传图片的对话轮次。" />
  <img src="assets/dsh-conversation-image-qa-result.png" width="49%" alt="Agent 对图片内容的结构化解读。" />
</p>

## 亮点

- **原图像素，真实答案。** 视觉链按原始分辨率读图（仅为保护延迟/额度自动缩放）；你的问题随图一起发送，答案围绕*你的问题*，而不是一段泛泛的描述。
- **自动降级 + 分类报错。** 地区限制、ToS 风控、402 额度、429 限流（尊重 Retry-After 退避重试）、上下文超长、网络故障——链路逐供应商尝试，全部失败才报错并给出可操作的建议。
- **图片记忆。** 视觉答案按附件内容哈希缓存；后续文字轮用记录的描述替换历史图片（标注为不可信证据），DeepSeek 真正“记得”之前发过的图，且不重复消耗视觉调用。
- **可验证的像素闭环。** 参照图 → `vision_html_screenshot` → `vision_pixel_diff`（差异率 + 红色热力图 + 最差区域排行）→ 修复 → 再对比，直到差异收敛。UI 还原从“目测”变成“实测”。
- **渐进式 schema 暴露。** 平时只有一个零参引导工具 `vision_activate`；图片轮自动挂载全部 10 个深看工具（附一次性使用提示），并为纯文字轮注册 `vision-tools` 技能。
- **选择性代理。** 只有配置的视觉供应商域名走本地代理；DeepSeek 保持直连。

### 像素闭环实测

[![参考设计与 Agent 最终复刻，通过 vision_pixel_diff 实测最终差异为 2.54%。](assets/pixel-loop-zh.png)](assets/pixel-loop-zh.png)

<p align="center"><sub>点击图片可查看完整原图。</sub></p>

Agent 仅根据参考图复刻 UI，再用 `vision_pixel_diff` 验证最终结果：**最终差异 2.54%**（32,939 / 1,296,000 个差异像素，threshold 16/channel）。

## 工作原理

<p align="center">
  <img src="assets/how-it-works-zh.svg" width="100%" alt="DSH Vision Router 的工作原理：DeepSeek 作为大脑，视觉工具作为眼睛。" />
</p>

视觉模型**只当眼睛**，DeepSeek **始终是大脑**。图片轮永远不会被一次性视觉答案“劫持”——Agent 自己驱动工具，可以跨多个步骤持续对同一张图操作。

## 工具

10 个深看工具在图片轮自动挂载（`autoActivateOnImage`）；文字轮可通过 `vision_activate` 或 `/vision-tools` 技能挂载。全部基于 sharp / potrace / tesseract / 系统 Chrome——无 Python：

<p align="center">
  <img src="assets/vision-tools-zh.svg" width="100%" alt="DSH Vision Router 的 10 个视觉工具。" />
</p>

| 工具 | 作用 | 产物 |
|---|---|---|
| `vision_describe` | 看图问答 / 多图对比 / 结构化证据 JSON 模式（摘要 + 布局区域 + 实体清单 + 原文转写） | — |
| `vision_ground` | 定位目标 → **原图像素框 x1/y1/x2/y2** | 标注 PNG（可选） |
| `vision_detect` | 盘点某类元素（按钮/输入框/链接…）→ 编号清单 + 原图像素框 | 编号标注 PNG |
| `vision_crop` | 按像素框裁剪放大 | PNG |
| `vision_pixel_diff` | 逐像素对比：差异率 + 最差 8×8 网格区域 | 红色热力图 PNG + JSON 报告 |
| `vision_colors` | 主色提取（十六进制 + 占比） | — |
| `vision_ocr` | 文字转写：本地 tesseract（中英）优先，视觉模型兜底 | — |
| `vision_trace` | SVG 矢量化（potrace 分色；图标/logo） | SVG |
| `vision_extract_foreground` | 边界洪泛抠图（纯色背景） | 透明 PNG |
| `vision_html_screenshot` | 给本地 HTML 文件截图（无头系统 Chrome） | PNG |
| `vision_long_screenshot_ocr` | 长截图转写：重叠分片，tesseract 优先 / 视觉模型回退，按序拼接 Markdown | 分片 PNG + Markdown + manifest |

图片格式按**魔数识别**，无扩展名的内容寻址附件文件也能直接用（不用再复制成 `.png`）。

**常用流程**

```text
vision_ground image="ref.png" target="发送按钮"
vision_detect image="page.png" target="输入框"
vision_crop   image="ref.png" region="1067,841,1108,881"
vision_describe paths=["ref.png","impl.png"] question="列出两图的差异" json=true
vision_pixel_diff original="ref.png" rebuilt="screenshot.png"
vision_ocr image="screenshot.png"
vision_colors image="ref.png" top=8
vision_trace image="icon.png" steps=4
vision_extract_foreground image="logo.png"
vision_html_screenshot source="page.html" width=1200 height=720
vision_long_screenshot_ocr image="chat-log.png" chunkHeight=1200 overlap=120
```

## 供应商降级链

视觉工具按顺序逐个尝试，全部失败才报错：

1. **用户视觉模型**：设置卡里一行一个，从上到下；只显示 **设置 → 模型** 中明确声明支持 image 输入的模型；
2. **高级自定义 HTTP 视觉端点**：如果旧配置/高级配置中存在 `httpProviders`，在用户模型之后尝试；
3. **内置 OVH 匿名免费兜底**：固定最后尝试，不需要出现在任何模型选择器里。当前内置链按质量优先为 `Qwen3.5-397B-A17B` → `Qwen2.5-VL-72B-Instruct` → `Qwen3.6-27B` → `Mistral-Small-3.2-24B-Instruct-2506` → `Qwen3.5-9B`。OVH 匿名限额为 **每 IP、每模型 2 次/分钟**；5 个模型是独立限额，因此理论上分散请求可到约 **10 次/分钟**，实际仍以 OVH 当时的限流为准。免注册、免 Key。

> [!IMPORTANT]
> 这里的“视觉链”是 Vision Router 调用的**眼睛**：设置页里每一行只选一个用户视觉模型；聊天页右下角选择的是**脑子/会话模型**，两者完全分开。纯文本 DeepSeek / opencode 不会出现在视觉后端下拉里；内部 `Vision HTTP` 也不会再暴露给用户。

> 在旧版 `routing: true` 模式下，整轮链只走 `provider + fallbacks`——`httpProviders`（含免费兜底）不参与。默认的 `routing: false`（工具优先）会尝试全部。

失败会分类（地区 / 风控 / 额度 / 限流 / 上下文 / 网络），最终报错附带建议；`429` 会尊重 `Retry-After` 做一次有上限的退避重试。超大上传图在调用前自动压缩（默认预算 400 万像素），保证工具调用不卡。

## 隐身模式

隐身模式默认**关闭**（issue #34 起显式 opt-in）：关闭时官方 `deepseek-official` 路由原样保留，发图走选择器里可见的「DeepSeek + 自动识图」包装入口。

开启隐身模式后，插件接管官方 `deepseek-official` 路由：模型选择器看起来和原版完全一样（同一个 DeepSeek 组、同样的模型名），但每个条目背后都是声明了图片输入的自动识图包装；文字轮交给插件重建的原生 DeepSeek 适配器（读取同一个 `llm-deepseek` 设置段与凭据）。老会话通过隐藏的 `deepseek-vision` 别名继续工作。接管的前提是官方行不在场——在你的 profile 补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）禁用即可：

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  disabled: true
```

官方行在场时，插件自动回退为可见包装入口。反过来，隐身模式关闭但官方行仍被禁用时，插件会做 keep-alive 兜底接管，保住 DeepSeek 模型（设置卡片会给出提示）；想完全恢复官方原生行，把上面的 `disabled` 改回 `false` 再重启即可。

> 隐身模式**只作用于官方 DeepSeek 路由**。opencode 等自定义/第三方文本路由与隐身模式无关——默认会被自动包装成「+ 自动识图」模型组。

## 自动识图模型组与手动包装

默认开启 `autoWrapProviders`：插件会自动发现 **设置 → 模型** 中当前已启用的 provider / model，并额外注册同名的「+ 自动识图」模型组。**原模型组完全不变**；发图片时选自动识图组，纯文字仍可继续用原组。DSH 的 `llm/adapters-updated` 变化会触发同步，所以新增/删除模型后无需重启。

`wrappedProviders` 是**可选的手动范围控制**，不是普通用户必须配置的步骤。只有两种情况需要它：

1. 关闭了自动包装，想手动指定哪些 provider / model 获得自动识图入口；
2. 自动包装保持开启，但只想让某个 provider 的部分模型出现在「+ 自动识图」组。

设置卡片里用两个下拉（provider + 模型）配置；模型留空 = 包装该路由的全部模型，同一 provider 要限定多个模型就添加多行。修改即时生效，无需重启。

## Web 设置

Web 配置页在 **设置 → 插件 → 插件配置** 下注册「视觉路由（自动识图）」卡片，顶部会直接提示最重要的使用步骤：**回到聊天页 → 右下角模型选择器 → 选择「+ 自动识图」模型组 → 发图**。其余设置主要用于高级定制：

- **自动创建「+ 自动识图」模型组**：默认开启，自动发现已有模型；模型目录变化热更新，无需重启；
- **手动限定自动识图范围（可选）**：仅在需要关闭自动包装或限制部分模型时使用；
- **视觉后端链**：给 `vision_describe` 等视觉工具调用的真正图片模型，默认内置免费 Qwen 即可；不要填纯文本模型；
- 开关：整轮自动路由（旧模式）、识图工具、图片块改写、隐身模式（仅官方 DeepSeek 路由）；
- 视觉请求超时、包装/链路由名、代理等高级参数；
- 每个字段都有「已覆盖」徽标与一键恢复组合默认，以及放弃/保存；
- 「测试连接」按钮探测第一个视觉提供方并内联显示延迟/失败原因；
- 产出制品的工具在对话里渲染专用调用卡（关键字段 + 打开文件按钮）。

<p align="center">
  <img src="assets/vision-settings.png" width="72%" alt="设置 → 插件 → 插件配置 里的视觉路由卡片。" />
</p>

> PR [#8](https://github.com/ysr666/dsh-vision-router/pull/8) 会把面板升级为目录驱动的模型下拉框、可增删的备用模型行与代理设置。

## 配置项

全部可选，默认即可用。通过 Web 卡片或 profile 补丁修改：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` / `model` | `vision-http` / `ovh/Qwen2.5-VL-72B-Instruct` | 简写视觉后端链路（有适配器且真正支持图片输入的供应商 + 模型） |
| `fallbacks` | `[]` | 简写视觉供应商的备用图片模型 |
| `providers` | 内置免费 `vision-http` 条目 | 多供应商视觉后端链 `{ provider, model, fallbacks[] }`，按序尝试；优先于简写形式。不要填写纯文本模型 |
| `httpProviders` | 内置 OVH 条目 | OpenAI 兼容直连端点 `{ name, baseURL, model, apiKeyEnv, maxTokens }` |
| `autoWrapProviders` | `true` | 自动发现当前已启用 provider / model，并热更新同名「+ 自动识图」模型组；原模型组不变 |
| `wrappedProviders` | `[{ provider: 'deepseek-official', models: [] }]` | 可选的手动包装范围 `{ provider, models[] }`；用于关闭自动包装后手动指定，或限制某个 provider 只包装部分模型。改动即时生效，无需重启 |
| `routing` | `false` | 旧版整轮链路由（一次性整轮回答）。`false` = 工具优先流程（推荐） |
| `reverseRouting` | `true` | 开启 `routing` 时，文字轮路由回 `textProvider` |
| `wrapperRoute` / `chainRoute` | `deepseek-vision` / `vision-chain` | 准入包装路由名 / 降级链路由名（置空关闭） |
| `stealth` | `false` | 接管官方 `deepseek-official` 路由（仅官方行；自定义路由默认由自动包装处理） |
| `textProvider` | `deepseek-official` / `deepseek-v4-pro` | 负责思考的模型（你的日常模型） |
| `tool` / `progressiveTools` / `autoActivateOnImage` | `true` ×3 | 视觉工具开关 / 渐进式挂载 / 图片轮自动挂载 |
| `rewriteImages` | `true` | 模型输入层改写图片块（缓存描述或工具提示标记）；界面日志保留图片 |
| `downscale` / `downscaleMaxPixels` | `true` / `4000000` | 调用前压缩及其像素预算（延迟保护） |
| `cache` / `cacheTtlSeconds` / `cacheMaxEntries` | `true` / `3600` / `200` | 视觉答案缓存 |
| `timeoutMs` | `120000` | 单次视觉调用超时 |
| `artifactsDir` | `.dsh-vision-router/artifacts` | 产物目录（相对会话工作区） |
| `proxy` / `proxyHosts` | `''` / openrouter 域名 | 仅视觉供应商域名可选的本地代理 |

## 环境要求

- DeepSeek Harness 的 Web profile。普通安装可用 `npx @deepseek-ai/dsh ...`；从源码仓库运行时用 `pnpm dsh ...`。只有 CLI 已经进入系统 `PATH` 时才能直接写 `dsh ...`。
- Node ≥ 22（宿主侧）。
- 默认免费链路无需 API Key；付费 `httpProviders` 只需一个凭据引用（`apiKeyEnv`）。
- `vision_html_screenshot` 才需要 Chrome / Chromium / Edge；其余工具无浏览器也能用。
- tesseract 可选：本地引擎缺失时 `vision_ocr` 自动退回视觉模型。

## 安装与生命周期

### 安装

普通 npm / npx 安装：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router
npx @deepseek-ai/dsh --profile web --dump-config | grep vision-router
```

从 DeepSeek Harness 源码仓库运行：

```sh
pnpm dsh plugin --profile web add dsh-vision-router
pnpm dsh --profile web --dump-config | grep vision-router
```

首次把插件装进已经长期运行的 Web profile 时，需要让 Web 进程重新加载插件本体；宿主在启动时通过 `dsh.client` 声明发现浏览器端包。**插件加载完成后，模型目录与包装范围的变化会热更新，不需要为这些变化重启。**

### 禁用 / 恢复

```yaml
- id: vision-router
  disabled: true
```

改回 `false` 即恢复。卸载会移除包装路由、工具、技能与设置卡片；已生成的产物文件保留。

### 升级

```sh
# 普通 npm / npx 安装
npx @deepseek-ai/dsh plugin --profile web update dsh-vision-router

# DeepSeek Harness 源码仓库
pnpm dsh plugin --profile web update dsh-vision-router
```

设置存放在 profile 的设置提供方里，升级不丢失。

> **从 bundle 补丁之前（v0.x）升级：** 现在插件由自带的 bundle 补丁自动挂载，
> 若 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里还残留旧版手动行，会与之
> 重复，`dsh web` 启动即报 `duplicate loader entry id: vision-router`。删除
> 旧块：
>
> ```yaml
> - insert:            # 删除整块
>     - id: vision-router
>       name: dsh-vision-router
> ```
>
> 若要保留自定义配置，改为不带 insert 的按 id 覆盖行：
>
> ```yaml
> - id: vision-router
>   config:
>     # 你的配置…
> ```

### 卸载

```sh
# 普通 npm / npx 安装
npx @deepseek-ai/dsh plugin --profile web remove dsh-vision-router

# DeepSeek Harness 源码仓库
pnpm dsh plugin --profile web remove dsh-vision-router
```

同时移除依赖与 bundle 层。若你曾手动禁用官方 DeepSeek 行，记得在 profile 补丁里恢复。

## 故障排查

### 启动报错 `Unexpected token ... is not valid JSON`（UTF-8 BOM）

**现象**：`dsh web` / `pnpm dsh web` 启动时直接退出：

```
SyntaxError: Unexpected token ...
is not valid JSON
at JSON.parse (<anonymous>)
at readProfileManifest (packages/boot/app-boot/src/profile.ts)
```

**原因**：`~/.dsh/profiles/<profile>/package.json` 被某些编辑器保存成了 **UTF-8 with BOM**。文件最前面多了一个不可见的 `\uFEFF` 字符，dsh 读取 manifest 时直接 `JSON.parse`，而 JSON 不允许在开头出现这个字符，于是解析失败。

**推荐修复**：直接运行 Vision Router 自带的独立修复命令。它不需要 DSH 先成功启动，会定位 profile、检测 UTF-8 BOM，只删除开头的三个 BOM 字节，然后重新验证 JSON：

```sh
npx dsh-vision-router repair --profile web
```

只想检查、不修改文件时：

```sh
npx dsh-vision-router doctor --profile web
```

如果你使用的不是 `web` profile，把 `web` 换成对应名称；也可以不传 `--profile`，让 doctor 扫描全部 profile。

手动兜底方式：VS Code 右下角编码 → “通过编码保存” → 选择 `UTF-8`（无 BOM）。若 `repair` 去掉 BOM 后仍提示 JSON 非法，它不会猜测或重写其他 JSON 内容，请再手动检查文件。

## 安全说明

- 图片中的文字是**不可信证据**：描述、OCR 输出与自动挂载提示都要求 Agent 绝不执行图片内出现的指令。
- 工具输入经由 `ctx.fs`（沙盒感知）解析；视觉上传只发送选中的图片与问题本身。
- 产物只写入 `<workspace>/.dsh-vision-router/artifacts`；结果返回绝对路径与字节数。
- 密钥不上线：`apiKeyEnv` 只指向 DSH 凭据引用，值按调用解析、永不写入日志。
- 设置写入走设置服务（schema 校验 + 修订号检查）——过期或非法的保存会被拒绝，不会半截生效。

## License

[MIT](LICENSE)

<!-- star-history-chart -->
## Star 趋势

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ysr666/dsh-vision-router/star-history/assets/star-history/star-history-dark.svg">
    <img alt="Star 历史趋势图" src="https://raw.githubusercontent.com/ysr666/dsh-vision-router/star-history/assets/star-history/star-history-light.svg" width="100%">
  </picture>
</p>

<p align="center">
  <img src="assets/hero-zh.svg" width="100%" alt="DSH Vision Router——为 DeepSeek Harness 的纯文本 Agent 提供视觉能力" />
</p>

<h1 align="center">dsh-vision-router</h1>

<p align="center"><strong>图片粘贴即用：给 DeepSeek Harness 的纯文本 Agent 装上“眼睛”——开箱免费、免 Key、无 Python、一条命令安装。</strong></p>

<p align="center">DeepSeek 只负责思考，内置免费视觉链 + 10 个像素级工具负责“看”；图片轮次就像普通工具调用一样自然、可定位、可验证。</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
  <a href="https://github.com/ysr666/dsh-vision-router/releases/tag/v1.0.0"><img src="https://img.shields.io/badge/release-v1.0.0-5B4CF0?style=flat-square" alt="Release v1.0.0" /></a>
  <a href="tests"><img src="https://img.shields.io/badge/verified-86%20tests-2EA44F?style=flat-square" alt="Verified: 86 tests" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat-square" alt="License: MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js >=22" /></a>
  <img src="https://img.shields.io/badge/runtime-no%20Python-8A2BE2?style=flat-square" alt="No Python" />
  <a href="cordis.patch.yml"><img src="https://img.shields.io/badge/DSH-Web%20profile-5B4CF0?style=flat-square" alt="DSH Web profile" /></a>
</p>

<p align="center"><a href="README.md">English</a> · 中文</p>

<p align="center">
  <img src="assets/vision-demo.gif" width="640" alt="演示：粘贴图片，Agent 用 vision_ground / vision_crop / vision_pixel_diff 定位发送按钮并给出坐标" />
</p>

## 为什么做这个

大多数 DSH 视觉插件把图片“翻译”成一段文字描述再喂给 DeepSeek——有损、一次性、看不见像素。本插件把**原图像素留在视觉模型侧**、把推理留在 DeepSeek 侧，并把“看图”变成一次**普通的工具调用**：

- **一条命令安装。** 包自带组合补丁（`dsh.bundle.patch`）：`dsh plugin add` 自动完成插件行挂载、准入包装、隐身接管与附件限制放宽——不用手改任何文件。
- **默认免费。** 视觉链内置 OVHcloud 匿名端点（`Qwen2.5-VL-72B-Instruct`，免注册、免 Key，每 IP 2 次/分钟）。付费链路（OpenRouter、Pi-AI 供应商、任意 OpenAI 兼容直连端点）是可选升级。
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
| 图片怎么进来 | ✅ 直接粘贴——轮次自动切视觉链并自动挂载工具 | 工作区路径 + `/vision-tools` 命令，再显式调用工具 |
| 轮次路由 | ✅ 图片轮切视觉、文本轮切回 DeepSeek——隐身接管，模型选择器与官方一致 | 工具驱动，无整轮自动路由 |
| 支持 profile | Web | Web + Headless |
| 玩法库 | 像素循环：定位 → 裁剪 → 对比 → 修复 → 再截图 | 更丰富的案例库（长截图 OCR、UI 还原、GUI 自动化） |
| 测试 | 86 | 162 |
| 安装 | 一条命令 | 一条命令（npm） |

两者都是 MIT 许可、一条命令安装。想要图片**粘贴即用**、零配置就选本插件；需要 Headless 部署或更丰富的案例库，可以看 @anionex/dsh-vision-toolkit。（功能对比以其 README 2026-08 状态为准。）

## 快速开始

```sh
dsh plugin --profile web add github:ysr666/dsh-vision-router
```

重启 `dsh web`——完成，零配置：

- 插件的 bundle 补丁自动挂载插件行、接管官方 DeepSeek 路由（隐身模式——模型选择器看起来和原版一模一样）、放宽附件限制到 20MB / 1 亿像素；
- 默认视觉链就是内置免费端点；
- 全部配置可在 **设置 → 插件 → 插件配置 → 视觉路由（自动识图）** 实时修改。

然后直接往对话里贴一张图。Agent 自动挂载视觉工具，通过 `vision_describe`（以及其余 8 个工具）看图，需要时连续多步。

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

<p align="center">
  <img src="assets/pixel-loop-zh.png" width="100%" alt="参考设计与 Agent 最终复刻，通过 vision_pixel_diff 实测最终差异为 2.54%。" />
</p>

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
```

## 供应商降级链

视觉链按顺序逐个尝试，全部失败才报错：

1. **内置免费端点**（`vision-http` → `ovh/Qwen2.5-VL-72B-Instruct`）——免 Key、尽力而为、每 IP 2 次/分钟；
2. 配置的 `httpProviders`（OpenAI 兼容直连端点，可选 `apiKeyEnv`）；
3. 配置的 `providers` / `provider` + `fallbacks`（任何有适配器的供应商，例如 Pi-AI 配置的 OpenRouter 或智谱）。

> 在旧版 `routing: true` 模式下，整轮链只走 `provider + fallbacks`——`httpProviders`（含免费兜底）不参与。默认的 `routing: false`（工具优先）会尝试全部。

失败会分类（地区 / 风控 / 额度 / 限流 / 上下文 / 网络），最终报错附带建议；`429` 会尊重 `Retry-After` 做一次有上限的退避重试。超大上传图在调用前自动压缩（默认预算 400 万像素），保证工具调用不卡。

## 隐身模式

默认安装即接管官方 `deepseek-official` 路由：模型选择器看起来和原版完全一样（同一个 DeepSeek 组、同样的模型名），但每个条目背后都是声明了图片输入的自动识图包装；文字轮交给插件重建的原生 DeepSeek 适配器（读取同一个 `llm-deepseek` 设置段与凭据）。老会话通过隐藏的 `deepseek-vision` 别名继续工作。

想保留官方行，在你的 profile 补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）覆写即可：

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
```

官方行在场时，插件回退为选择器里可见的「DeepSeek + 自动识图」包装入口——发图前选它即可。安装出问题时同样用这一行恢复。

## Web 设置

Web 配置页在 **设置 → 插件 → 插件配置** 下注册「视觉路由（自动识图）」卡片，样式与内置卡片一致，可实时修改：

- 开关：整轮自动路由（旧模式）、识图工具、图片块改写、隐身模式；
- 视觉请求超时、包装/链路由名；
- **视觉模型链**（每行一个 `provider/model`，自上而下降级）与文本模型；
- 每个字段都有「已覆盖」徽标与一键恢复组合默认，以及放弃/保存。

<p align="center">
  <img src="assets/vision-settings.png" width="72%" alt="设置 → 插件 → 插件配置 里的视觉路由卡片。" />
</p>

> PR [#8](https://github.com/ysr666/dsh-vision-router/pull/8) 会把面板升级为目录驱动的模型下拉框、可增删的备用模型行与代理设置。

## 配置项

全部可选，默认即可用。通过 Web 卡片或 profile 补丁修改：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` / `model` | `vision-http` / `ovh/Qwen2.5-VL-72B-Instruct` | 简写链路（有适配器的供应商 + 模型） |
| `fallbacks` | `[]` | 简写供应商的备用模型 |
| `providers` | `[]` | 多供应商链路 `{ provider, model, fallbacks[] }`，按序尝试；优先于简写形式 |
| `httpProviders` | 内置 OVH 条目 | OpenAI 兼容直连端点 `{ name, baseURL, model, apiKeyEnv, maxTokens }` |
| `routing` | `false` | 旧版整轮链路由（一次性整轮回答）。`false` = 工具优先流程（推荐） |
| `reverseRouting` | `true` | 开启 `routing` 时，文字轮路由回 `textProvider` |
| `wrapperRoute` / `chainRoute` | `deepseek-vision` / `vision-chain` | 准入包装路由名 / 降级链路由名（置空关闭） |
| `stealth` | `true` | 接管官方 `deepseek-official` 路由 |
| `textProvider` | `deepseek-official` / `deepseek-v4-pro` | 负责思考的模型（你的日常模型） |
| `tool` / `progressiveTools` / `autoActivateOnImage` | `true` ×3 | 视觉工具开关 / 渐进式挂载 / 图片轮自动挂载 |
| `rewriteImages` | `true` | 模型输入层改写图片块（缓存描述或工具提示标记）；界面日志保留图片 |
| `downscale` / `downscaleMaxPixels` | `true` / `4000000` | 调用前压缩及其像素预算（延迟保护） |
| `cache` / `cacheTtlSeconds` / `cacheMaxEntries` | `true` / `3600` / `200` | 视觉答案缓存 |
| `timeoutMs` | `120000` | 单次视觉调用超时 |
| `artifactsDir` | `.dsh-vision-router/artifacts` | 产物目录（相对会话工作区） |
| `proxy` / `proxyHosts` | `''` / openrouter 域名 | 仅视觉供应商域名可选的本地代理 |

## 环境要求

- DeepSeek Harness 的 Web profile，且 `dsh plugin` 可用 `pnpm`。
- Node ≥ 22（宿主侧）。
- 默认免费链路无需 API Key；付费 `httpProviders` 只需一个凭据引用（`apiKeyEnv`）。
- `vision_html_screenshot` 才需要 Chrome / Chromium / Edge；其余工具无浏览器也能用。
- tesseract 可选：本地引擎缺失时 `vision_ocr` 自动退回视觉模型。

## 安装与生命周期

### 安装

```sh
dsh plugin --profile web add github:ysr666/dsh-vision-router
dsh --profile web --dump-config | grep vision-router   # 一行，由 bundle 补丁挂载
```

长期运行的 Web profile 需重启。宿主在启动时通过 `dsh.client` 声明发现浏览器端包。

### 禁用 / 恢复

```yaml
- id: vision-router
  disabled: true
```

改回 `false` 即恢复。卸载会移除包装路由、工具、技能与设置卡片；已生成的产物文件保留。

### 升级

```sh
dsh plugin --profile web update dsh-vision-router
```

设置存放在 profile 的设置提供方里，升级不丢失。

### 卸载

```sh
dsh plugin --profile web remove dsh-vision-router
```

同时移除依赖与 bundle 层。若你曾手动禁用官方 DeepSeek 行，记得在 profile 补丁里恢复。

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

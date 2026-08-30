<!-- 注：本报告由自动调研生成（2026-08），presets 片段已按 llm-pi-ai 实际 schema 校正并放入 ../presets/。 -->
# dsh-vision-router 免费/内置视觉模型方案调研报告

> 调研时间：2026-08（快照）。方法：直接抓取 OpenRouter 官方 `GET https://openrouter.ai/api/v1/models`（411 个模型）交叉核对官方定价页与第三方免费额度库（pricepertoken、yangmao.ai、mintlify free-llm-api-resources、teamday.ai、阿里云/Cloudflare/Z.ai 官方文档）。所有额度/限速都可能随时变动，落地前务必以各平台控制台为准。

## 关键结论（先看这里）

1. **OpenRouter 免费视觉模型已大幅轮换**：用户熟悉的 `qwen-vl-plus:free`、`llama-4-scout:free`、`gemma-3-27b-it:free`、`llama-3.2-11b-vision:free` **均已从免费列表下架**（我抓取的实时 API 中均 ABSENT）。当前免费视觉模型变成了 **Google Gemma 4 与 NVIDIA Nemotron VL** 系列。用户已在用的 `qwen/qwen3-vl-235b-a22b-instruct` 是**付费模型**（约 $0.26/M in / $1.04/M out）。
2. **大陆直连最省事**：**阿里云百炼 DashScope**（新用户每个模型系列 100 万 token / 90 天，含 Qwen-VL 系列，OpenAI 兼容端点）＞ **智谱 Z.ai / bigmodel.cn**（`glm-4.6v-flash` 永久免费视觉）＞ **SiliconFlow**（¥14 赠金覆盖便宜 VL）。
3. **完全免 key 的视觉理解 API 目前不存在**：pollinations.ai 现在只有文本模型 `openai-fast`（`vision: false`），无 vision 模型。
4. **插件不可内置第三方密钥**（安全 + ToS），正确做法是仓库随附 **provider 预设 yaml**（baseURL + 免费 model id + `apiKeyEnv`），用户只填一个 key。

---

## 1. OpenRouter 免费视觉模型

**是否需要 key**：需要（用户已有 OpenRouter key 即可直接用）。
**免费额度/限速**：所有免费模型共享一个总配额 —— **20 请求/分钟**；免费账户 **50 请求/天**；账户历史累计充值 ≥ $10 后提升到 **最高 1,000 请求/天**（20 req/min 不变）。上游供应商可能施加更紧的限制。（来源：mintlify free-llm-api-resources / teamday.ai / OpenRouter 官方模型 API）

**当前支持 image 输入的免费模型**（来源：OpenRouter 实时 API + teamday.ai 2026-08-03 快照）：

| 精确 model id | 模态（输入） | 上下文 | 最大输出 | 用途/备注 |
|---|---|---|---|---|
| `google/gemma-4-26b-a4b-it:free` | image + text + video | 262,144 | 32,768 | **通用视觉理解，首选免费 VLM** |
| `google/gemma-4-31b-it:free` | image + text + video | 262,144 | 32,768 | 通用视觉理解，质量更高 |
| `nvidia/nemotron-nano-12b-v2-vl:free` | image + text + video | 128,000 | 128,000 | 视觉语言模型，输出上限大 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | text + audio + image + video | 256,000 | 65,536 | 全模态，含推理 |
| `nvidia/nemotron-3.5-content-safety:free` | text + image | 128,000 | 8,192 | ⚠️ 内容安全分类器，非通用 VLM，勿用 |
| `google/lyria-3-pro-preview` / `google/lyria-3-clip-preview` | text + image | 1,048,576 | 65,536 | ⚠️ 音乐/音视频类，非通用图片理解（不确定） |
| `openrouter/free` | text + image | 200,000 | — | 免费模型路由（可过滤 image 能力），随机选模型 |

**关于用户点名的几个系列**（结论均为“免费变体已下架”或“不存在”）：
- **qwen-vl 系列**：`qwen/qwen-vl-plus:free` 不存在了；付费的 `qwen/qwen2.5-vl-72b-instruct`、`qwen/qwen3-vl-8b/32b/235b-*` 仍在（付费）。
- **llama-4 系列**：`meta-llama/llama-4-scout:free` 不存在；`meta-llama/llama-4-scout`、`llama-4-maverick`（image 输入）为付费。
- **gemma-3 系列**：`google/gemma-3-27b-it:free` 不存在；付费 `gemma-3-4b/12b/27b-it` 仍在。免费档已升级为 **gemma-4**。

> ⚠️ 注意：OpenRouter 免费档近期频繁轮换（teamday 记录：一周内 15→14，前一周 20 个，数周内下架了 8 个）。不要把生产/长任务硬编码到某个 `:free` 端点。

**信息来源**：[OpenRouter models API](https://openrouter.ai/api/v1/models)、[teamday.ai: Best Free OpenRouter Models 2026](https://www.teamday.ai/blog/best-free-ai-models-openrouter-2026)、[mintlify: OpenRouter Free](https://mintlify.wiki/cheahjs/free-llm-api-resources/providers/free/openrouter)、[OpenRouter qwen-vl-plus:free 定价页](https://openrouter.ai/qwen/qwen-vl-plus:free/providers)

---

## 2. 其他免费视觉 API（带 key 但免费额度）

### 2.1 SiliconFlow 硅基流动（api.siliconflow.cn）—— 大陆直连 ✅

| 项 | 内容 |
|---|---|
| OpenAI 兼容 baseURL | `https://api.siliconflow.cn/v1` |
| 免费额度 | 新用户 **¥14 赠金**（约 2000 万 token 量级，具体以控制台为准）；另有少量 `$0` 模型（当前为文本 Qwen3-8B、DeepSeek-R1-Distill-Qwen-7B、**DeepSeek-OCR** 等） |
| 免费视觉模型 | **不确定**：当前免费列表里未见“通用 VL”永久免费项；`DeepSeek-OCR` 是图像输入（文档 OCR，非通用理解）。历史上 `Qwen/Qwen2.5-VL-7B-Instruct` 曾免费，现需在控制台核对 |
| 推荐视觉 model id（便宜，赠金可覆盖） | `Qwen/Qwen2.5-VL-7B-Instruct`、`Qwen/Qwen2.5-VL-32B-Instruct`、`Qwen/Qwen3-VL-8B-Instruct`、`Qwen/Qwen3-VL-32B-Instruct` |
| 直连性 | 中国大陆**直连**，无需代理 |

**信息来源**：[pricepertoken: SiliconFlow Free Tier](https://pricepertoken.com/endpoints/siliconflow/free)、[yangmao.ai: SiliconFlow Free API](https://yangmao.ai/en/providers/siliconflow/free-api/)、[SiliconFlow 限速文档](https://docs.siliconflow.cn/cn/userguide/rate-limits/rate-limit-and-upgradation)

### 2.2 Z.ai / 智谱 GLM —— 大陆直连（bigmodel.cn）✅

| 项 | 内容 |
|---|---|
| OpenAI 兼容 baseURL | 国际版 `https://api.z.ai/v1`（可能需代理）；大陆版 `https://open.bigmodel.cn/api/paas/v4`（直连） |
| 免费视觉模型（永久免费） | **`glm-4.6v-flash`（GLM-4.6V-Flash，Free）** |
| 限时免费视觉模型 | `glm-4.5v`（GLM-4.5V）、`glm-4.6v`（GLM-4.6V）、`glm-5v-turbo`（GLM-5V-Turbo）标记为 “Limited-time Free / 限时免费”（非永久，可能过期） |
| 其它视觉 model id | `glm-ocr`（OCR，极便宜 $0.03/M） |
| 关于 GLM-4V | 用户提到的老 **GLM-4V 已停用/被替代**，现行为 GLM-4.5V / 4.6V / 5V-Turbo |
| 是否需要 key | 需要（Z.ai 或 bigmodel.cn 的 API key） |

**信息来源**：[Z.AI 官方定价页](https://docs.z.ai/guides/overview/pricing)、[models.dev: Z.ai](https://models.dev/providers/zai/)、[Z.AI 概览文档](https://docs.z.ai/guides/overview/overview)

### 2.3 阿里云百炼 DashScope —— 大陆直连 ✅（综合最优）

| 项 | 内容 |
|---|---|
| OpenAI 兼容 baseURL | `https://dashscope.aliyuncs.com/compatible-mode/v1`（国际版 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`） |
| 免费额度 | 新用户开通后 **90 天**内，**每个模型系列 100 万 token**；覆盖「通义千问基础 / 垂直(OCR·Audio·Coder) / **多模态 Omni+VL 系列** / 第三方(DeepSeek·Kimi·GLM)」 |
| 视觉 model id | `qwen-vl-plus`、`qwen-vl-max`、`qwen2.5-vl-7b-instruct`、`qwen2.5-vl-72b-instruct`、`qwen3-vl-plus`、`qwen-vl-ocr`（OCR）、`qwen-omni-turbo`（全模态） |
| 是否需要 key | 需要（阿里云百炼 API key，控制台开通即得） |
| 直连性 | 中国大陆**直连** |

**信息来源**：[阿里云百炼新人免费额度（官方）](https://help.aliyun.com/zh/model-studio/new-free-quota)、[掘金：百炼新用户免费额度机制](https://juejin.cn/post/7594315259463516195)、[阿里云 Qwen-VL OpenAI 兼容（官方）](https://help.aliyun.com/zh/model-studio/qwen-vl-compatible-with-openai)

### 2.4 Groq —— 需代理，视觉可用性不确定

| 项 | 内容 |
|---|---|
| OpenAI 兼容 baseURL | `https://api.groq.com/openai/v1` |
| 免费额度 | **永久免费档**，限速约 **30 RPM / 6,000 TPM**（部分模型 15,000 TPM），无总量上限，免卡 |
| 免费模型 | Llama 3.3 70B、Llama 4 Scout 17B、Llama 4 Maverick 17B、Mixtral 8x7B、Gemma 2 9B、DeepSeek-R1-Distill-Llama-70B 等 |
| 视觉支持 | Groq 有 vision 支持（历史上 `llama-3.2-11b-vision-preview`、`llama-3.2-90b-vision-preview`；Llama 4 Scout/Maverick 原生多模态）。但**免费档哪个视觉模型当前可用 = 不确定**，需用 Groq 模型列表核对 |
| 直连性 | 中国大陆**通常需代理**，直连不稳定 |

**信息来源**：[yangmao.ai: Groq Free Tier](https://yangmao.ai/en/providers/groq/free-tier/)、[Groq 限速文档](https://console.groq.com/docs/rate-limits)、[langchain PR #34620（Groq vision 支持）](https://github.com/langchain-ai/langchain/pull/34620)

### 2.5 Cloudflare Workers AI —— 免费额度大，但接入较绕、大陆不友好

| 项 | 内容 |
|---|---|
| 免费额度 | 每个账户 **每天 10,000 免费 Neurons**（Workers Free 计划），每日 00:00 UTC 重置，免卡；超额按 $0.011/1K Neurons 计费 |
| 视觉模型 | `@cf/meta/llama-3.2-11b-vision-instruct`（首次使用需先向 Meta 同意 License）、Llama 4 Scout 17B 16E Instruct 等 |
| 认证 | 需要 **Cloudflare 账户 + Account ID + API Token（Bearer）** |
| OpenAI 兼容端点 | 原生 REST `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}`；也有 OpenAI 兼容风格 `/ai/v1/chat/completions`（**不确定**是否与 pi-ai 完全兼容） |
| 直连性 | 中国大陆访问 Cloudflare API 不稳定，接入配置（Account ID + Token + License 同意）较绕 |

**信息来源**：[pricepertoken: Cloudflare Workers AI Free Tier](https://pricepertoken.com/endpoints/cloudflare/free)、[Cloudflare llama-vision 官方教程](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers-ai/guides/tutorials/llama-vision-tutorial.mdx)

### 2.6 GitHub Models —— 免费档已收窄，需 Copilot、大陆需代理

| 项 | 内容 |
|---|---|
| OpenAI 兼容 baseURL | `https://models.github.ai/inference`（旧 `https://models.inference.ai.azure.com` 已于 2025-07 弃用） |
| 免费额度 | **免费档请求数很有限**；限速按 GitHub **Copilot 订阅档位**（Free / Pro / Pro+ / Business / Enterprise）递增；单请求 token 上限**极严** |
| 视觉模型 | `gpt-4o`、`gpt-4o-mini`、`gpt-4.1`、`gpt-4.1-mini`（均支持 image）；`Llama-3.2-11B-Vision-Instruct`、`Llama-3.2-90B-Vision-Instruct`、`Llama-4-Scout`、`Llama-4-Maverick` |
| token 获取 | GitHub **Personal Access Token（PAT）** 或 Copilot token |
| 直连性 | 中国大陆**需代理** |

> ⚠️ 注意：GitHub Models 的免费/开放 API 路线在 2025 年中已被 GitHub Copilot 体系吸收，`gpt-4o` 在 GitHub Models 上被弃用（转向 gpt-4.1 系）。它不是“开箱即用免费”的首选。

**信息来源**：[GitHub Changelog：Azure endpoint 弃用](https://github.blog/changelog/2025-07-17-deprecation-of-azure-endpoint-for-github-models/)、[mintlify: GitHub Models](https://mintlify.wiki/cheahjs/free-llm-api-resources/providers/free/github-models)、[GitHub Models 迁移说明](https://www.nocode.tech/article/github-models-dies-july-30-heres-where-to-migrate-your-no-code-ai-backend)

---

## 3. 完全免 key 的视觉 API

**结论：目前不存在可稳定使用的“零注册/零密钥”视觉理解 API。**

- **pollinations.ai**：实测其 OpenAI 兼容模型列表（`https://text.pollinations.ai/openai/models`）目前**只有一个文本模型 `openai-fast`（GPT-OSS 20B，`vision: false`，`input_modalities: ["text"]`）**。它免费做的是**文生图**（`image.pollinations.ai`）和文本生成，**没有视觉理解（image input → 描述）模型**。
- 其余“免 key”聚合端点多为文本/生图，且**稳定性差、无 SLA、随时变更**，不适合做插件默认视觉后端。

**信息来源**：[pollinations models 端点实测](https://text.pollinations.ai/openai/models)、[pollinations README](https://github.com/learn05/pollinations-AI/blob/master/pollinator-agent/README-pollinations.md)

---

## 4. “预先内置”的落地建议（provider 预设，不内置密钥）
## 4. “预先内置”的落地建议（provider 预设，不内置密钥）

**原则**：绝不把第三方 key 写进仓库（安全 + 违反 ToS）。本仓库随附 [`presets/`](../presets/) 目录：
每个供应商一份按 llm-pi-ai 实际 schema 校正过的 `settings.yaml` 片段（`api: openai-completions` +
`baseURL` + 免费/便宜 model id + `apiKeyEnv`，`input: [text, image]`），用户只填一个 Key 即用。

当前内置清单：

| 预设 | 平台 | 免费视觉模型 | 直连 | 说明 |
|---|---|---|---|---|
| `presets/dashscope.yaml` | 阿里云百炼 | `qwen-vl-plus`、`qwen2.5-vl-7b-instruct` | ✅ | 新用户每系列 100 万 token/90 天（综合最优） |
| `presets/zai.yaml` | 智谱 bigmodel.cn | `glm-4.6v-flash` | ✅ | **永久免费** |
| `presets/siliconflow.yaml` | 硅基流动 | `Qwen/Qwen2.5-VL-7B/32B-Instruct` | ✅ | ¥14 赠金覆盖 |
| `presets/openrouter.yaml` | OpenRouter | `google/gemma-4-31b-it:free` 等 | 需代理 | 50 次/天；免费名单轮换频繁 |
| `presets/ovh.yaml` | OVHcloud AI Endpoints | `Qwen2.5-VL-72B-Instruct` | ✅ | **免注册免 Key**（2 次/分钟/IP）；已内置为插件默认 httpProviders |

## 5. 结论与推荐顺序

① 百炼 DashScope（额度最大 + 直连）＞ ② 智谱 bigmodel.cn `glm-4.6v-flash`（永久免费 + 直连）＞
③ SiliconFlow（直连 + 赠金）＞ ④ OpenRouter（已有 key，`gemma-4:free`，需代理）＞
⑤ Cloudflare（额度大但接入绕）＞ ⑥ GitHub Models（已收窄）＞ ⑦ Groq（需代理，视觉可用性不确定）＞
⑧ pollinations（无视觉理解）。

## 6. 不确定项

- SiliconFlow 通用 VL 是否永久免费：官方未明示，赠金用完后以账单为准；
- Groq 免费档视觉模型可用性：官方免费层主要是文本模型；
- Cloudflare Workers AI 的 OpenAI 兼容端点兼容性：官方端点非 OpenAI 形状，需网关转换；
- Z.ai 除 `glm-4.6v-flash` 外各 VL 的限时免费截止时间；
- OpenRouter 免费名单轮换风险：数周内已下架 `qwen-vl-plus:free`、`llama-4-scout:free`、
  `gemma-3-27b-it:free`、`llama-3.2-11b-vision:free` 等，本节数据以报告生成当日为准。

> 所有来源链接见上文各节；免费额度、模型名称、地区可用性均可能变化，使用前请以官方页面为准。

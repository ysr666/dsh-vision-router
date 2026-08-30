# #178 交接文档：1+x 深挖引导（mixed 分路 / 深度档位 / 收敛分类 / 引导可配置）

> 对应 PR：[#178 feat: 1+x deep-dive guidance - mixed branching, depth tier, convergent classification, configurable copy](https://github.com/ysr666/dsh-vision-router/pull/178)
> 分支：`feat/mixed-router` @ `7ac5ee8`（stacked on #177 `feat/free-cloud-first` @ `a8384ca`）
> 作者：shaoqiuyuavailable（`rangsic2963277@163.com`）
> 状态：open，7 个 commit 全部为作者本人提交（2 个来自 #177 + 5 个本 PR 增量）

---

## 一、一句话定位

在群主 v2 能力路由（#142）与 structured bootstrap 1+x（#136）框架之上，补齐**深挖阶段**的四个维度：**精度（mixed 分路）、深度（档位）、收敛（schema 分类）、可配置（引导文案）**。全部默认行为不变（zero-regression）。

## 二、增量作者与来源

| 项 | 说明 |
|---|---|
| 增量作者 | shaoqiuyuavailable，dsh-vision 插件（`shaoqiuyuavailable/text-llm-vision`）作者 |
| 概念来源 | dsh-vision main 分支的 `scan → zoom → guess` 场景路由 + PRECISION 档位；dsh-vision 分支（text-llm-vision）的场景级识图路由层设计 |
| 本 PR 性质 | 在群主已有框架上的**成本/速度妥协优化**：概念移植为 router 生态的轻量实现，不引入 dsh-vision 的完整引擎路由表 |
| 定位边界 | 与 #142（能力路由：谁来看）正交——本 PR 只负责**怎么看的引导**，出口选择仍归模型（软路由） |

## 三、设计哲学（四条，均来自 dsh-vision 实践结论）

1. **场景感知路由（scene-aware routing）**：先分类、再引导识别方式，替代"所有图一条固定链"。
2. **档位只定深度、不参与提示词组合**：fast/standard/deep 是用户级全局开关；引导文案是**模板集合**（每类一条），不是提示词矩阵——工作量 = 引导表 + 拼接函数。
3. **收敛分类（schema 免费收敛）**：让视觉模型直接输出结构化枚举（JSON schema 天然校验），替代系统启发式——同时用于 `content_kind`（主体）与 `mixed_of`（混合构成），删除约 60 行 entities 启发式。
4. **软引导、硬上限（soft guidance, hard caps）**：识别方式/工具选择归模型（软文案引导，保留逃生通道）；深度是唯一硬约束（VISION_DEPTH_LIMIT）。

## 四、功能详述（5 个增量 commit）

### 1. `7fe43fb` feat: mixed branch routing（新建 `lib/mixed-router.js`）
- **动机**：1.5.3 中 bootstrap 判出 `visual_kind=mixed` 后无后续处理，模型自由深挖可能漏判/错判另一半内容（§4.6 缺陷实证）。
- **实现**：`planMixedBranches()` 消费 bootstrap 的 `mixed_of`，产出 ≤2 个分支（`MAX_MIXED_BRANCHES=2`），每分支一条独立软引导（`BRANCH_GUIDANCE`：document:code / document:form / document:table / ui / code / table / _default 放行）；主/次分支按信号强度排序（可交互 > 文字 > 其余，`KIND_PRIORITY`）。
- **防呆**：`mixed_of` 缺失/为空 → `fallback=true` **放行**（绝不硬拦，行为同现状）。
- **成本**：混合图 ≤2 次视觉调用，成本封顶（副产品）。
- **语义差异**：与 dsh-vision 不同——语义从"实体主体"（人+飞机）改为"内容类型"（文档+UI）。

### 2. `a85c8c1` feat: visionDepth tier（新建 `lib/depth-guidance.js` + index.js 档位注入）
- **动机**：深挖深度无约束，成本不可控。
- **实现**：新配置 `visionDepth`（`fast|standard|deep`，默认 `standard`）。档位句注入 bootstrapReminder（执行前，只给档位）与 followupReminder（完成后，场景引导+档位句）。
- **硬上限**：`depthLimitFor()` — fast=1、deep=4、standard=不硬拦（现状行为）。在 evidence 深挖工具（`structuredFollowupEvidenceTools`）入口计数 `state.deepCalls`，超限返回 `VISION_DEPTH_LIMIT`（retryable:false）。bootstrap 那 1 遍不计入。
- **提示**：fast 档携带"若需深度定向识别请告知用户升级档位"句（搬 dsh-vision 回答节思想）。

### 3. `ff0ecca` feat: content_kind in bootstrap schema（`lib/structured-bootstrap.js`）
- **动机**：general 图（媒介无引导）缺主体方向，深挖无的放矢。
- **实现**：bootstrap schema 新增 `content_kind` 枚举（person/animal/plant/food/vehicle/machine/architecture/object/scene/meme + unknown），normalizer 枚举校验，非法/缺失 → unknown；media-kind 图（document/ui/code/chat）约定 unknown。
- **消费**：`renderDepthGuidance()` — general 且 content_kind 已知 → 内容引导（`CONTENT_GUIDANCE` 10 类）；未知 → `GENERAL_FALLBACK_GUIDANCE` 兜底（让模型自判主体方向）。

### 4. `1b8b50e` refactor: mixed_of in bootstrap schema（`lib/structured-bootstrap.js` + `lib/mixed-router.js`）
- **动机**：entities 启发式推断混合构成不稳定。
- **实现**：bootstrap schema 新增 `mixed_of`（仅 `visual_kind=mixed` 时填写，1-2 项，document/ui/code/chat/general）；normalizer 枚举校验+去重+≤2，非法/缺失 → `[]`（调用方 fallback 放行）。`normalizeMixedOf()` 与 schema 同域、同哲学，删除 entities 启发式路径（约 60 行）。

### 5. `7ac5ee8` feat: guidanceOverrides（`lib/client.js` + `lib/depth-guidance.js`）
- **动机**：引导文案硬编码，用户无法按需调整。
- **实现**：新配置 `guidanceOverrides`（`[{kind, text}]`，默认 `[]`= 内置表，零变化）。`resolveGuidance()` 覆盖优先于内置表；kind 覆盖场景（visual_kind：code/document/ui/chat）与内容（content_kind：person/…/meme）共 14 类。
- **UI**：设置卡片 Performance 组新增 `selectField`（visionDepth 下拉）+ `guidanceOverridesEditor`（行编辑器：类别 select + 文案 input + 移除 + 添加），zh/en 双语文案，`SELECT_KEYS` 校验。

## 五、mixed 变更说明（变更前后对比）

| 环节 | 变更前（1.5.3 / main） | 变更后（本分支） |
|---|---|---|
| bootstrap 判定 mixed 后 | 无后续处理，模型自由深挖（可能漏判/错判另一半内容） | 按 `mixed_of` 拆 ≤2 分支（`MAX_MIXED_BRANCHES=2`），各分支独立软引导；主/次按信号强度排序（ui > document > code > table > chat > general） |
| 混合构成判定来源 | 无（schema 无此字段） | `mixed_of`：schema 枚举，视觉模型直接输出；normalizer 校验去重 + ≤2 |
| 细分失败（mixed_of 缺失/为空） | 无细分（等同现状） | `fallback=true` **放行**（绝不硬拦，行为同现状） |
| 分支引导 | 无 | `BRANCH_GUIDANCE`：document:code/form/table → 逐字专精；ui → detect/ground；code → 逐字；table → 结构优先；_default → 放行 |
| 成本 | 混合图深挖轮数无上限 | ≤2 分支 = 混合图 ≤2 次识别调用（成本封顶，副产品） |
| 判定结果消费 | 无 | `bootstrapState.mixedPlan` → followupReminder 注入分支引导文案 |

原则：**精度优化**（避免漏判/错判另一半内容），成本封顶是副产品；所有分支引导都是软引导，模型保留逃生通道（软路由成立结论：不硬拦截识别方式）。

## 六、判定接口（供 #142 能力路由对接参考）

bootstrap 结构化输出新增两个字段，normalizer 已校验：

```json
{
  "visual_kind": "chat|document|ui|code|general|mixed|unknown",
  "content_kind": "person|animal|plant|food|vehicle|machine|architecture|object|scene|meme|unknown",
  "mixed_of": ["document|ui|code|chat|general"]  // 仅 visual_kind=mixed，1-2 项
}
```

- `content_kind` = **内容主体**（物理实体类，11 值含 unknown）；`visual_kind` = **媒介**（正交维度）。
- `mixed_of` = **混合构成**（媒介组合，≤2），已去重排序（可交互 > 文字 > 其余）。
- 二者都是"schema 免费收敛"产物：视觉模型 JSON 输出 + normalizer 枚举校验，无启发式。
- 消费点：`bootstrapState.visualKind / contentKind / mixedPlan`（turn 状态），下一次 pre-step 的 followupReminder 按场景/内容/分支注入引导。

## 七、默认行为与零回归

| 开关 | 默认 | 关闭时行为 |
|---|---|---|
| `visionDepth` | `standard` | 无硬上限，仅提示词引导（与现状等价） |
| `guidanceOverrides` | `[]` | 内置引导表（与现状等价） |
| mixed 分路 | 随 bootstrap 自动生效 | `mixed_of` 缺失 → fallback 放行（与现状等价） |
| `content_kind` | 新增字段 | 只影响 general 图引导（其余场景不消费） |

回归门：`tests/zero-regression-gate.test.js`（含 #177 的 orderedHttpProviders 默认关断言）+ 全量 407 pass / 0 fail / 6 skipped（env 相关）。

## 八、与 #142 / #177 的关系

- **与 #142 正交**：#142 管"哪个能力 → 哪个后端"（谁来看）；本 PR 管"怎么看的引导"（怎么看）。判定结果（content_kind/mixed_of）可直接作为 #142 能力声明的输入（见第六节）。
- **stacked 依赖**：本分支含 #177 的 2 个 commit（freeCloudFirst + OCR 提示词强化）。合并顺序：先 #177 后 #178，或 #178 单独 squash（内含 177）。

## 九、测试

- 新增 `tests/mixed-router.test.js`（13 例：normalizeMixedOf 校验/去重/封顶/排序、buildMixedBranches 去重/封顶/单分支、mixedGuidance 精确→kind→放行、planMixedBranches fallback 防呆、renderMixedGuidance 文案）。
- 新增 `tests/depth-tier.test.js`（15 例：depthLimitFor fast/deep/standard、场景/内容引导查表与放行、renderDepthGuidance 拼接、guidanceOverrides 覆盖优先）。
- `tests/structured-bootstrap.test.js` +29 行（content_kind/mixed_of 枚举校验）。
- `package.json` test 脚本挂载两个新测试文件。

## 十、评审与合并指南（给群主）

1. 先审 #177（freeCloudFirst + OCR 提示词强化），再审本 PR；或合并时 squash。
2. 重点看三处：`lib/mixed-router.js` 的 fallback 防呆（绝不放行变成硬拦）、`index.js` 的 `VISION_DEPTH_LIMIT` 计数（bootstrap 不计入、只数 evidence 深挖工具）、`lib/depth-guidance.js` 的 `resolveGuidance`（覆盖优先）。
3. 判定接口（第六节）可直接对接 #142 能力声明，作者可协助整理接口说明。

# 模型目录所有权与预设退役｜架构决策

> **DSH负责模型供应商及目录；Vision Router负责视觉能力编排、执行与诊断。只有解决真实兼容问题所需的代码或配置，才应由Vision Router长期维护。**

DSH管理用户供应商、模型、凭据、Host目录及输入模态权限；Vision Router的设置页经`connection.api.llm.models({})`读取相同目录，视觉模式用`modelDirectories.directoryFor(sessionId)`读取Host权威选择状态。Router继续管理视觉工具、像素处理、能力评估、执行、回退和诊断；不另造商用供应商注册表。Host声明的输入模态不能取代真实图片投递验证。

## 逐项来源核查（清理前）

| 来源 | 当初的目的 | 本轮结论 |
| --- | --- | --- |
| [提交16e29d07](https://github.com/ysr666/dsh-vision-router/commit/16e29d07b943d2b2e1dfb615683ab07f24cc96af)，2026-08-13（无关联PR） | 降低用户手动写`llm-pi-ai`配置的门槛，添加五份供应商YAML和免费模型调研。 | 退役五份静态示例；原始报告可通过Git历史追溯。 |
| [提交cf4eb6b3](https://github.com/ysr666/dsh-vision-router/commit/cf4eb6b35fe1005dcf9fd46f840a6688ef60372e) | `zai.yaml`改名为`zhipu.yaml`，避免自定义bigmodel.cn provider key与内置`zai`冲突。 | 不删除已有用户的手动配置，只退役仓库示例。 |
| [PR #89](https://github.com/ysr666/dsh-vision-router/pull/89)，2026-08-16 | DSH Web自定义视觉模型未保存`image`能力声明，曾触发下拉过滤及难以理解的空列表。 | **保留通用图片能力修复指引**和实测提示，不延续过时的“全部隐藏”描述。 |
| [PR #676](https://github.com/ysr666/dsh-vision-router/pull/676)，2026-10-09 | DSH 0.2.1-alpha.2变更Web信任初始化所有权，新增`presets/web-connection-ready/`私有运行时桥接。 | **不能删**，仍由`cordis.patch.yml`加载、`package.json.files`打包，必须保留Host跨代回归门。 |
| [PR #729](https://github.com/ysr666/dsh-vision-router/pull/729)，2026-10-19 | 提交收费Atlas Cloud网关示例及文档；贡献者披露商业关联。 | 按同一职责原则关闭而未合并，不针对特定厂商区别对待。 |

## 清理边界

只删除仓库发布包中需人工复制的`dashscope.yaml`、`zhipu.yaml`、`siliconflow.yaml`、`openrouter.yaml`、`ovh.yaml`。已有用户的`settings.yaml`、凭据、模型注册一概不动。中英文README改为DSH原生模型配置路径；原动态价格清单仅由不可变历史快照承载。

**必须保留：** `presets/web-connection-ready/`、`cordis.patch.yml`引用、`package.json`中的`presets`打包项、`src/lib/core-primitives.js`运行时匿名OVH兜底；`src/lib/http-compat.js`的协议兼容预设及catalog corrections不能与手工厂商YAML混淆。后续清理每条真正运行时兼容规则前，也必须查Issue/PR、复现原因、受支持Host替代能力及负向测试。

## 验收门

- `pnpm test`、`pnpm typecheck`、`pnpm build`及`pnpm pack`。tarball须含`presets/web-connection-ready/index.mjs`和`package.json`，不含五份厂商YAML。
- 原有Windows/macOS/Linux、Node22/24与支持窗口内的DSH稳定版/preview Host门不得回归。
- DSH模型目录选择、#89图片能力提示、真实识图校验、运行时OVH兜底与连接信任权限必须保持原状。
- 真正移除`web-connection-ready`或供应商协议兼容逻辑，另开PR证明上游问题已不再存在，并提供回滚策略。

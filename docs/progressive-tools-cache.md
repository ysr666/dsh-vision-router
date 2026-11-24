# Progressive tools and prefix cache

中文 | English

## 中文

Vision Router 默认让完整视觉工具表从会话开始就保持稳定。正常通过 DSH bundle 安装时，组合层会提供：

```yaml
- id: vision-router
  name: dsh-vision-router
  config:
    progressiveTools: false
```

插件入口本身也把 `progressiveTools` 的 schema 默认值设为 `false`，因此即使后续 profile patch 整块覆盖了 bundle 的 `config`、但没有重述这个字段，也不会意外回到渐进模式。

原因是很多模型服务的 KV / prefix cache 会把工具 schema 视为请求前缀的一部分。若长会话一开始只暴露 `vision_activate`，第一次图片轮再挂载完整视觉工具，工具列表发生变化后可能导致此前的大段会话前缀无法命中缓存。

渐进式暴露仍然保留为高级 opt-in。如果你更在意平时请求中少携带工具 schema，而不依赖长会话前缀缓存，请在 **profile / composition 的 `cordis.patch.yml`** 中显式给 `vision-router` 设置：

```yaml
- id: vision-router
  config:
    progressiveTools: true
```

`progressiveTools` 决定插件启动时注册哪组工具，因此它是**启动期配置**；不要依赖运行中的 Web 设置热切换这个字段。修改 profile patch 后重启 DSH。

开启后，平时只暴露 `vision_activate`，首次需要时再挂载完整视觉工具；默认关闭时，完整视觉工具从一开始就常驻。视觉工具本身的能力不变。

**重要时序约束（DSH 0.2.x）：** 宿主会在模型步骤开始前冻结本批可执行工具列表。因此纯文字任务中请先单独调用 `vision_activate`，等待该次调用完成，再在**下一模型步骤**调用 `vision_describe` 等深度工具；同一批并行调用会被宿主拒绝为 `UNKNOWN_TOOL`。图片消息正常会在模型步骤前提前挂载工具。首次激活完成后，工具注册会保持到插件 Fiber 卸载，并非仅对当前会话单独挂载。

### 长会话中切换 Vision：优先使用 Host 原生 PTC（有条件）

全局稳定注册与每个 Session 的可见工具表是两件事。默认 Native
executor 在 Vision OFF/ON 时仍需移除/加入 DVR 工具；DeepSeek
Flash 声明的 `addition-only` 工具更新不能在移除后保持同一工具基线。
请不要为了缓存命中率取消 OFF 的真实权限隔离。

如果你的 DSH 安装提供官方 PTC Agent preset，可从**新会话**主动选用它。
PTC 用固定的 `run_code` 传输 schema，实际工具列表由 Host 生成 SDK，
并与执行绑定共享 Session 权限。对实际支持
`systemPromptUpdate: in-history` 的模型，SDK 的变化可以由 Host
追加到历史，而不是改写旧前缀。不需要 DVR 再包装一个 PTC executor
或替换 SDK。不要仅为了缓存强制转换正在运行的 Native 会话，也不要
伪造模型支持的协议能力。

在 #886 的固定实验提交 `17a607dd88ddbe13d3ac4ba4c089910d7f7352d3`
上，[真实 DSH Host Ubuntu 验收](https://github.com/ysr666/dsh-vision-router/actions/runs/45294768087/job/138112468262)
使用实际 DVR、Host PTC executor、离线模型及本地 PNG：三次切换均保持
旧序列化请求的头和历史不变；ON 下本地取色成功，OFF 下不存在视觉执行绑定，
过期绑定不能执行。每个普通文本轮只有一个源模型请求。历史里可能保留
以前 ON 时的 SDK 内容，但这并不赋予当前执行权限。该证据只覆盖已测
Host/协议/路径，不能等同真实服务端缓存命中率或账单下降。

普通 Native、无 in-history 能力的模型以及外部模型协议仍需分别验收。
真实 provider/model 切换、历史压缩、其他插件或工具变动、缓存淘汰仍
可能引入新的请求基线。用户有权保留原 Native 模式；DVR 不自动修改
Host executor 或现有会话的 preset。

## English

Vision Router keeps the complete vision tool schema stable from the beginning of a session by default. Normal DSH bundle installs provide this composition layer:

```yaml
- id: vision-router
  name: dsh-vision-router
  config:
    progressiveTools: false
```

The public plugin entrypoint also makes `false` the schema default. Therefore a later profile patch that replaces the bundle `config` without restating this field cannot accidentally fall back to progressive mode.

Many model providers include tool schemas in the KV/prefix-cacheable request prefix. If a long conversation starts with only `vision_activate` and the first image turn later mounts the complete vision tool set, that prefix change can invalidate a large cached history.

Progressive exposure remains available as an advanced opt-in. If minimizing the always-present tool schema matters more than long-context prefix-cache stability, explicitly set it in the **profile/composition `cordis.patch.yml`**:

```yaml
- id: vision-router
  config:
    progressiveTools: true
```

`progressiveTools` determines which tools are registered at plugin startup, so it is a **boot-time setting**; do not rely on changing this field through live Web settings. Restart DSH after changing the profile patch.

When enabled, only `vision_activate` is exposed initially and the complete vision tool set mounts on first use. With the default disabled mode, the complete vision tool set is present from the start. The vision capabilities themselves are unchanged.

**DSH 0.2.x step-snapshot contract:** The Host freezes the callable tool set at the start of each model step. On text-only turns, call `vision_activate` **alone**, wait for its result, and use `vision_describe` or another deep tool **in the next model step**. Batching the activation and deep-tool calls together produces Host `UNKNOWN_TOOL`. Image turns normally mount the tools before step admission. Once mounted, registration persists until the plugin Fiber is disposed; it is not scoped only to the current conversation.

### Vision switches in long Sessions: prefer the stock Host PTC path when applicable

Stable global registration does not imply a stable Session-visible tool set.
The Native executor must still add/remove DVR declarations on OFF/ON.
DeepSeek Flash's declared addition-only capability rebases on tool removal.
Do not weaken OFF authorization to improve cache metrics.

If the installed DSH exposes its stock PTC Agent preset, users may explicitly
select it for a **new Session**. PTC keeps the run_code transport schema fixed
and derives SDK bindings from actual scoped tool admission. For an adapter
that truthfully supports systemPromptUpdate: in-history, the Host can append
SDK updates without rewriting the existing serialized prefix. DVR does not
need a replacement executor or a private SDK projection. Do not automatically
change the executor of an established Native Session.

The [exact Host experiment](https://github.com/ysr666/dsh-vision-router/actions/runs/45294768087/job/138112468262)
on commit 17a607dd88ddbe13d3ac4ba4c089910d7f7352d3 verified all three
OFF/ON transitions with stock PTC on the current pinned Host, including local
color-tool execution ON, absent bindings OFF, rejection of a stale binding,
and one source request per ordinary text turn. Old ON SDK descriptions can
remain in history; they are not current authorization. This is local wire
and execution evidence using an offline model/program driver, not paid
provider-cache or billing evidence. Other model routes, Native mode and
other Host floors must be qualified independently.

DVR never silently switches the Host executor or claims universal cache
continuity. Genuine route, compaction or unrelated tool changes can still
require a new baseline, and providers may evict caches.


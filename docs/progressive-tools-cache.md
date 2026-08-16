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

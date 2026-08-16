# Progressive tools and prefix cache

中文 | English

## 中文

Vision Router 默认让完整视觉工具表从会话开始就保持稳定。正常通过 DSH bundle 安装时，`cordis.patch.yml` 会提供：

```yaml
vision-router:
  progressiveTools: false
```

原因是很多模型服务的 KV / prefix cache 会把工具 schema 视为请求前缀的一部分。若长会话一开始只暴露 `vision_activate`，第一次图片轮再挂载完整视觉工具，工具列表发生变化后可能导致此前的大段会话前缀无法命中缓存。

渐进式暴露仍然保留为高级 opt-in。如果你更在意平时请求中少携带工具 schema，而不依赖长会话前缀缓存，可以在 `settings.yaml` 或 profile patch 中显式设置：

```yaml
vision-router:
  progressiveTools: true
```

这不会改变视觉工具本身，只改变它们是从会话开始常驻，还是第一次需要时再挂载。

## English

Vision Router keeps the complete vision tool schema stable from the beginning of a session by default. Normal DSH bundle installs provide:

```yaml
vision-router:
  progressiveTools: false
```

Many model providers include tool schemas in the KV/prefix-cacheable request prefix. If a long conversation starts with only `vision_activate` and the first image turn later mounts the complete vision tool set, that prefix change can invalidate a large cached history.

Progressive exposure remains available as an advanced opt-in. If minimizing the always-present tool schema matters more than long-context prefix-cache stability, explicitly set the following in `settings.yaml` or a profile patch:

```yaml
vision-router:
  progressiveTools: true
```

This changes only when the tools are mounted; it does not change the vision tools themselves.

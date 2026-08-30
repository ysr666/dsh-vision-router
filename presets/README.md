# presets/

每个文件是 `$DSH_HOME/settings.yaml` 中 `llm-pi-ai` 段的一份即插即用片段：
把它合并进你自己的 `settings.yaml`（或复制整个段），填一个 `apiKeyEnv` 对应的 Key 即可。
**仓库绝不内置任何第三方 Key**。

> [!IMPORTANT]
> DSH 当前的 Web「设置 → 模型 → 添加自定义提供方」表单不会写入图片输入能力元数据。即使端点实际是智谱 GLM-4.6V、Qwen-VL 等视觉模型，如果模型没有显式的 `input: [text, image]`（或提供方没有 `defaultInput: [text, image]`），DSH 仍会把它报告为纯文本模型，Vision Router 会为安全起见从视觉后端下拉中隐藏它。下面这些 preset 已经带好 `input` 声明；如果你是通过 Web 手动添加的自定义视觉提供方，请在 `$DSH_HOME/settings.yaml` 补上该字段。

- `dashscope.yaml` —— 阿里云百炼，大陆直连，新用户每系列 100 万 token/90 天（推荐首选）
- `zhipu.yaml` —— 智谱 bigmodel.cn，`glm-4.6v-flash` 永久免费（provider key 用 `zhipu`，避免与 pi-ai 内置目录里的 `zai` 编码端点冲突）
- `siliconflow.yaml` —— 硅基流动，¥14 赠金覆盖 Qwen2.5-VL
- `openrouter.yaml` —— OpenRouter 免费模型（50 次/天，名单会轮换）
- `ovh.yaml` —— OVHcloud AI Endpoints 匿名层：**无需账号、无需 Key**，匿名额度为每个 IP、每个模型每分钟 2 次；
  该端点已内置为插件的默认 `httpProviders`，通常无需手动配置

用法示例（以 dashscope 为例，合并进 `settings.yaml`）：

```yaml
llm-pi-ai:
  providers:
    dashscope:
      api: openai-completions
      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
      apiKeyEnv: DASHSCOPE_API_KEY
      models:
        - id: qwen-vl-plus
          name: "百炼: Qwen-VL-Plus"
          contextWindow: 8000
          maxTokens: 8192
          input: [text, image]
```

Key 放在 `~/.dsh/.credentials.yaml`（或用环境变量导出），然后重启 `dsh web`。
之后既可在模型选择器里手动使用，也可把 `provider: dashscope` 加进本插件的
`providers` 链路。

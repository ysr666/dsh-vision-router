# 免费视觉API调研（2026年8月）——历史资料

> 本文件仅为历史来源索引，**不再是当前厂商、模型、额度或价格推荐表**。原报告随[2026-08-13提交16e29d07](https://github.com/ysr666/dsh-vision-router/commit/16e29d07b943d2b2e1dfb615683ab07f24cc96af)产生，帮助当时需要手工配置多模态模型的用户；其模型ID、免费额度与地区可用性可能已过期。

[查看原始报告的不可变历史版本](https://github.com/ysr666/dsh-vision-router/blob/16e29d07b943d2b2e1dfb615683ab07f24cc96af/docs/free-models.zh-CN.md)

当前在DSH「设置 → 模型」配置供应商、模型和凭据，再在Vision Router中选择DSH模型目录里的视觉后端，使用「测试识图」核验实际图片投递。真实视觉模型若被Host错误标为纯文本，请优先在DSH模型选项中声明图片输入；旧Host可按[PR #89](https://github.com/ysr666/dsh-vision-router/pull/89)对已验证视觉模型使用`input: [text, image]`。匿名OVH默认兜底仍是插件运行时工具后端，并未删除。

见[架构决策和历史回溯](architecture/model-catalog-ownership.md)。

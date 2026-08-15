# 更新检查

Vision Router 会检查是否有新的已发布版本，但**不会修改或自动升级用户的安装**。

- 插件随 DSH 启动时，会异步检查一次，不阻塞启动和识图功能。
- 打开设置卡时复用本进程的检查结果；若启动检查尚未完成，则加入同一个请求，不重复访问 registry。
- 点击“检查更新”可手动刷新；已有检查正在进行时不会并发发第二个请求。
- 若 DSH 进程继承了 `npm_config_registry` / `NPM_CONFIG_REGISTRY`，会沿用该 registry；否则使用 npm 官方 registry。
- 网络或 registry 失败只显示检查失败，不影响插件运行。
- 版本比较遵循 SemVer；源码/预发布构建若高于 registry 版本，不会提示用户降级。

## 为什么不做固定的一键更新命令

用户的 DSH/插件可能通过不同方式安装，例如：

- `npx @deepseek-ai/dsh ...`
- 全局安装的 `dsh` CLI
- DeepSeek Harness 源码仓库中的 `pnpm dsh ...`
- 其他包管理器或包装方式

因此检查器只显示当前版本、最新版本和 Release Notes，并提示用户**沿用原来的 DSH/插件安装方式更新**。插件不会擅自执行 `npm`、`pnpm`、`npx`、`bun` 等命令，也不会猜测 profile、全局/本地安装位置或源码仓库布局。

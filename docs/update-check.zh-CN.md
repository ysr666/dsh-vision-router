# 更新检查

Vision Router 会检查是否有新的已发布版本；当当前运行中的 DSH CLI 可以被可靠验证时，还会提供安全的一键更新。

- 插件随 DSH 启动时，会异步检查一次，不阻塞启动和识图功能。
- 打开设置卡时复用本进程的检查结果；若启动检查尚未完成，则加入同一个请求，不重复访问 registry。
- 点击“检查更新”可手动刷新；已有检查正在进行时不会并发发第二个请求。
- 若 DSH 进程继承了 `npm_config_registry` / `NPM_CONFIG_REGISTRY`，会沿用该 registry；否则使用 npm 官方 registry。
- 网络或 registry 失败只显示检查失败，不影响插件运行。
- 版本比较遵循 SemVer；源码/预发布构建若高于 registry 版本，不会提示用户降级。

## 一键更新如何兼容不同安装方式

用户可能通过 `npx`、全局 CLI、源码仓库里的 pnpm 或其他包装方式启动 DSH，所以 Vision Router **不会猜测 npm / pnpm / npx / bun 命令**。

发现新版本后，插件会检查当前进程真正使用的 DSH CLI 入口。只有该入口能够向上验证到真实的 `@deepseek-ai/dsh` 包，并且可以由当前 Node 运行时安全执行时，设置卡才显示“一键更新”。此时调用的不是某个猜出来的包管理器，而是**当前正在托管插件的同一套 DSH CLI**：

```sh
dsh plugin --profile <当前 profile> update dsh-vision-router
```

子进程通过 `execFile` 且 `shell: false` 启动，不会把浏览器输入拼成 shell 命令。更新接口还要求由同源更新检查接口返回的本进程临时 token，避免网页跨站请求直接触发更新。更新命令成功后，设置卡会提示用户重启 DSH，让新插件 bundle 真正加载。

若无法可靠验证当前 CLI——例如直接运行需要 workspace 专用 loader 的 TypeScript 源码入口——就不会显示一键更新按钮。此时仍会显示当前/最新版本和 Release Notes，并提示用户沿用原来的 DSH 安装方式手动更新。

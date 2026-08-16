# 更新检查

Vision Router 会检查是否有新的已发布版本；当当前运行中的 DSH CLI 可以被可靠验证时，还会提供安全的一键更新。

- 插件随 DSH 启动时，会异步检查一次，不阻塞启动和识图功能。
- 打开设置卡时复用本进程的检查结果；若启动检查尚未完成，则加入同一个请求，不重复访问 registry。
- 点击“检查更新”可手动刷新；已有检查正在进行时不会并发发第二个请求。
- 若 DSH 进程继承了 `npm_config_registry` / `NPM_CONFIG_REGISTRY`，会先沿用该 registry；否则使用 npm 官方 registry。
- 如果继承的镜像/registry 超时、无法访问，或返回不可用的版本元数据，只读的版本检查会自动再试 npm 官方 registry；每次尝试都有独立的超时上限。
- 若所有 registry 都失败，设置页会把实际尝试过的 registry 写进错误信息，方便判断是镜像、代理还是网络问题。
- 网络或 registry 失败只显示检查失败，不影响插件运行。
- 版本比较遵循 SemVer；源码/预发布构建若高于 registry 版本，不会提示用户降级。

## 一键更新如何兼容不同安装方式

用户可能通过 `npx`、全局 CLI、源码仓库里的 pnpm 或其他包装方式启动 DSH，所以 Vision Router **不会猜测 npm / pnpm / npx / bun 命令**。

发现新版本后，插件会检查当前进程真正使用的 DSH CLI 入口。只有该入口能够向上验证到真实的 `@deepseek-ai/dsh` 包，并且可以由当前 Node 运行时安全执行时，设置卡才显示“一键更新”。此时调用的不是某个猜出来的包管理器，而是**当前正在托管插件的同一套 DSH CLI**：

```sh
dsh plugin --profile <当前 profile> add dsh-vision-router@<最新版>
```

这里会**显式安装 registry 已确认的目标版本**，而不是裸 `update`。原因是 pnpm 11 默认启用 `minimumReleaseAge`（1440 分钟）：当候选新版本发布不足 24 小时时，裸 `pnpm update` 会静默保留当前版本并仍然以退出码 0 结束（输出 “Already up to date”）——这就是“点了更新、提示成功、重启后版本没变”的假成功。`add <包名>@<版本>` 会安装确认过的发布版（pnpm 需要时会自动为新版本写入策略豁免）。对于非 registry 安装（git / file / link / workspace 规格），更新器保持 `update` 语义、只校验结果。

子进程通过 `execFile` 且 `shell: false` 启动，不会把浏览器输入拼成 shell 命令。更新接口还要求由同源更新检查接口返回的本进程临时 token，避免网页跨站请求直接触发更新。更新命令退出后，插件会读取 profile `node_modules` 下 `dsh-vision-router` 的清单并核对安装版本确实达到目标——**仅凭退出码 0 永远不会被当作成功**。只有校验通过的更新才会提示用户重启 DSH，让新插件 bundle 真正加载。

若无法可靠验证当前 CLI——例如直接运行需要 workspace 专用 loader 的 TypeScript 源码入口——就不会显示一键更新按钮。**源码仓库里通过 `pnpm dsh` 启动通常属于这种情况：版本检查仍然可以正常工作，只是一键更新继续交给源码工作区自己的 pnpm 流程。** 此时仍会显示当前/最新版本和 Release Notes，并提示用户沿用原来的 DSH 安装方式手动更新。

## 手动兜底

如果自动更新不可用、版本检查失败，或一键更新失败，设置卡仍会直接显示项目主页 / Releases 入口和可执行的手动命令。发现新版本时，显示的命令会带版本号显式安装，从而绕过上面描述的发布龄拦截。DeepSeek Harness 源码仓库通过 pnpm 启动时使用：

```sh
pnpm dsh plugin --profile web add dsh-vision-router@<最新版>
```

普通 npm / npx DSH 使用：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router@<最新版>
```

如果插件能识别当前 profile，设置页会把命令里的 `web` 自动替换成实际 profile。若执行后版本仍未变化，请检查 profile 的 `pnpm-workspace.yaml` 里是否有版本钉住的 `minimumReleaseAgeExclude` 条目——`npx dsh-vision-router repair` 会把过期的钉住条目改写为裸名，让后续新版本恢复正常解析（见 `docs/doctor.md`）。

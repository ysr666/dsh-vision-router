from pathlib import Path
import json


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

pkg_path = Path('package.json')
pkg = pkg_path.read_text()
pkg = replace_once(pkg, '  "version": "1.5.0",', '  "version": "1.5.1",', 'package version')
pkg_path.write_text(pkg)

readme_path = Path('README.md')
readme = readme_path.read_text()
readme = replace_once(
    readme,
    'DeepSeek keeps thinking; the built-in free vision chain and thirteen deep tools do the seeing.',
    'DeepSeek keeps thinking; the built-in free vision chain and fourteen deep tools do the seeing.',
    'english hero tool count',
)
readme = replace_once(
    readme,
    'All thirteen deep tools are registered from session start by default',
    'All fourteen deep tools are registered from session start by default',
    'english highlight tool count',
)
readme = replace_once(
    readme,
    '<a href="https://github.com/ysr666/dsh-vision-router/releases/tag/v1.5.0"><img src="https://img.shields.io/badge/release-v1.5.0-5B4CF0?style=flat-square" alt="Release v1.5.0" /></a>',
    '<a href="https://github.com/ysr666/dsh-vision-router/releases/tag/v1.5.1"><img src="https://img.shields.io/badge/release-v1.5.1-5B4CF0?style=flat-square" alt="Release v1.5.1" /></a>',
    'english release badge',
)
readme = replace_once(
    readme,
    '> 📌 **Announcement (v1.5.0)**\n>\n> **v1.5.0:** Adds local Ollama / LM Studio vision and desktop screenshots, with stronger Settings and lifecycle reliability.',
    '> 📌 **Announcement (v1.5.1)**\n>\n> **v1.5.1:** Hardens update recovery, stops hidden Settings write loops, and adds offline attachment recovery.',
    'english announcement',
)
readme_path.write_text(readme)

zh_path = Path('README.zh.md')
zh = zh_path.read_text()
if zh.count('13 个深看工具') < 1:
    raise SystemExit('chinese tool count: expected at least one match')
zh = zh.replace('13 个深看工具', '14 个深看工具')
zh = replace_once(
    zh,
    '<a href="https://github.com/ysr666/dsh-vision-router/releases/tag/v1.5.0"><img src="https://img.shields.io/badge/release-v1.5.0-5B4CF0?style=flat-square" alt="Release v1.5.0" /></a>',
    '<a href="https://github.com/ysr666/dsh-vision-router/releases/tag/v1.5.1"><img src="https://img.shields.io/badge/release-v1.5.1-5B4CF0?style=flat-square" alt="Release v1.5.1" /></a>',
    'chinese release badge',
)
zh = replace_once(
    zh,
    '> 📌 **公告（v1.5.0）**\n>\n> **v1.5.0：新增 Ollama / LM Studio 本地视觉与桌面截图，强化设置和生命周期稳定性。**',
    '> 📌 **公告（v1.5.1）**\n>\n> **v1.5.1：修复更新兜底、设置循环写入，并新增离线附件落地。**',
    'chinese announcement',
)
zh_path.write_text(zh)

changelog_path = Path('CHANGELOG.md')
changelog = changelog_path.read_text()
section = '''## v1.5.1

> 本节为 **v1.5.0 → v1.5.1** 的补丁版本说明，覆盖 v1.5.0 发布后合入的全部用户可见修复。
> This is the **v1.5.0 → v1.5.1** patch release summary, covering all user-visible fixes merged after v1.5.0.

### 更新与安装 / Update & Install

- **更新恢复彻底改为精确版本（#151 / #158）**：设置页手动兜底不再生成裸 `update dsh-vision-router`，正常版本发现会始终生成 `add dsh-vision-router@<具体版本>`；配置 registry 失败后会依次尝试 npm 官方源与 GitHub Releases 获取精确版本。若三路版本源全部失败，则只显示 `@<version>` 模板并要求用户先确认 Release，彻底移除可能被 pnpm 11 `minimumReleaseAge` 静默拦截的 `@latest` 最后兜底。同时补齐无效响应校验与可读错误，不再显示 `unknown`。
- **Exact-version update recovery (#151 / #158)**: manual recovery no longer emits bare `update dsh-vision-router`; when a version can be resolved it always uses `add dsh-vision-router@<exact-version>`. Version discovery now falls through configured registry → official npm → GitHub Releases. If all three are unavailable, the UI shows only an `@<version>` template and requires a confirmed Release instead of falling back to ambiguous `@latest`, eliminating the remaining pnpm 11 `minimumReleaseAge` false-success path. Invalid responses and missing diagnostics now surface readable errors instead of `unknown`.

### 稳定性与离线兜底 / Reliability & Offline Recovery

- **隐藏设置写入不再形成循环（#155 / #156）**：首次引导 / walkthrough 的隐藏状态持久化改为幂等写入，并记住页面生命周期内已经尝试过的相同 mutation。即使宿主拒绝写入或返回旧状态，也不会被 subscriber churn 反复触发；真实状态迁移（如 `step1 → step2 → unset`）仍可正常保存。
- **Hidden Settings mutations no longer loop (#155 / #156)**: onboarding / walkthrough hidden-state persistence is idempotent and remembers identical mutations already attempted during the page lifetime. Rejected or stale host readback can no longer trigger endless `settings.mutate` churn, while legitimate transitions such as `step1 → step2 → unset` still persist normally.

- **新增离线附件落地兜底 `vision_materialize`（#153 / #157）**：当 `vision_describe` / `vision_bootstrap` 的视觉基础设施不可用时，失败结果会携带精确 attachment ID，并引导 Agent 使用 `vision_materialize` 将已授权上传附件复制到会话 workspace，获得真实文件路径后交给本地 OCR / parser 等离线流程。该桥接不发起网络或视觉请求，也不暴露 DSH 私有 `~/.dsh/attachments/...` 存储布局；工具结果已接入聊天内工具 UI。默认常驻深看工具总数因此为 14 个。
- **Offline attachment materialization with `vision_materialize` (#153 / #157)**: when `vision_describe` / `vision_bootstrap` infrastructure is unavailable, failures carry the exact attachment IDs and direct the agent to copy an authorized upload into the session workspace, yielding a real filesystem path for local OCR/parsers. The bridge performs no network or vision call, does not expose DSH's private attachment-storage layout, and renders materialized artifacts in the tool UI. The default always-mounted deep-tool set is now 14 tools.

### 验证 / Validation

- Node 22 / Node 24 全量测试通过；Windows / macOS / Ubuntu 的宿主打包与 shared-sharp 回归全部通过。新增回归覆盖更新精确版本兜底、三路版本源全失败、隐藏设置 mutation 幂等，以及 attachment ID 离线落地契约。
- Full tests pass on Node 22 / Node 24, with packed-host + shared-sharp regression green on Windows, macOS, and Ubuntu. New coverage locks down exact-version update recovery, all-version-source failure behavior, idempotent hidden Settings mutations, and attachment-ID materialization contracts.

'''
changelog = replace_once(changelog, '\n## v1.5.0\n', '\n' + section + '## v1.5.0\n', 'changelog insertion')
changelog_path.write_text(changelog)

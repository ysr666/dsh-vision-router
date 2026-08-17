from pathlib import Path
import json

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text())
assert pkg['version'] == '1.5.1', pkg['version']
pkg['version'] = '1.5.2'
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')

replacements = {
    'README.md': [
        ('releases/tag/v1.5.1', 'releases/tag/v1.5.2'),
        ('release-v1.5.1-5B4CF0', 'release-v1.5.2-5B4CF0'),
        ('alt="Release v1.5.1"', 'alt="Release v1.5.2"'),
        ('verified-354%20tests', 'verified-355%20tests'),
        ('alt="Verified: 354 tests"', 'alt="Verified: 355 tests"'),
        ('📌 **Announcement (v1.5.1)**', '📌 **Announcement (v1.5.2)**'),
        ('**v1.5.1:** Hardens update recovery, stops hidden Settings write loops, and adds offline attachment recovery.', '**v1.5.2:** Fixes DSH Settings keyed-slot loading.'),
    ],
    'README.zh.md': [
        ('releases/tag/v1.5.1', 'releases/tag/v1.5.2'),
        ('release-v1.5.1-5B4CF0', 'release-v1.5.2-5B4CF0'),
        ('alt="Release v1.5.1"', 'alt="Release v1.5.2"'),
        ('verified-354%20tests', 'verified-355%20tests'),
        ('alt="Verified: 354 tests"', 'alt="Verified: 355 tests"'),
        ('📌 **公告（v1.5.1）**', '📌 **公告（v1.5.2）**'),
        ('**v1.5.1：修复更新兜底、设置循环写入，并新增离线附件落地。**', '**v1.5.2：修复 DSH 设置页 keyed-slot 加载失败。**'),
    ],
}
for name, pairs in replacements.items():
    path = Path(name)
    text = path.read_text()
    for old, new in pairs:
        assert old in text, f'{name}: missing {old}'
        text = text.replace(old, new, 1)
    path.write_text(text)

changelog = Path('CHANGELOG.md')
text = changelog.read_text()
marker = '\n## v1.5.1\n'
assert marker in text
section = '''## v1.5.2

> **v1.5.1 → v1.5.2 紧急补丁**：修复当前 DSH keyed Settings slot 契约下会导致客户端插件直接加载失败的问题。
> **v1.5.1 → v1.5.2 emergency hotfix**: fixes a client-loader failure under the current DSH keyed Settings-slot contract.

### 客户端加载 / Client loading

- **修复 `settings.plugin.item` keyed-slot 注册（#160 / #162）**：Vision Router 的设置卡注册现在显式携带 `key: 'vision-router'`，不再只提供 `id`。这修复了 Harness 启动时的 `Failed to load plugins` / `keyed slot "settings.plugin.item" requires options.key`，避免插件在进入设置卡之前就被 loader 拒绝。现有 `id`、排序、文案、注入与视觉运行时行为均保持不变。
- **Fix keyed `settings.plugin.item` registration (#160 / #162)**: the Vision Router Settings card now supplies the required `key: 'vision-router'` in addition to its existing `id`. This fixes the Harness startup error `Failed to load plugins` / `keyed slot "settings.plugin.item" requires options.key`, where the loader rejected the client plugin before the Settings card could mount. Existing ordering, labels, injection, and vision runtime behavior are unchanged.

### 验证 / Validation

- 新增 keyed-slot 回归测试；全量套件为 **355 tests：350 pass + 5 macOS-only skips + 0 fail**，Node 22 / Node 24 均通过。发布仍由既有 immutable Release workflow 在 tag 上再次执行完整验证，并通过 npm Trusted Publishing（OIDC）发布。
- Added a keyed-slot regression guard. The full suite is **355 tests: 350 pass + 5 macOS-only skips + 0 fail** on Node 22 and Node 24. The existing immutable tag-based Release workflow re-runs full verification and publishes through npm Trusted Publishing (OIDC).
'''
text = text.replace(marker, '\n' + section + marker, 1)
changelog.write_text(text)

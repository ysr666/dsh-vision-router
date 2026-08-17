from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


client_path = Path('lib/client.js')
client = client_path.read_text()

client = replace_once(
    client,
    "      updateReleaseFallback: 'npm registry 检查失败，已通过 GitHub Releases 获取最新版本号；安装仍需 npm registry 可访问。',\n      updateManualTitle: '手动更新',\n",
    "      updateReleaseFallback: 'npm registry 检查失败，已通过 GitHub Releases 获取最新版本号；安装仍需 npm registry 可访问。',\n      updateManualUnknownTarget: '无法确认最新版本，因此不会生成 @latest 或普通 update 命令。请先打开 Releases 确认最新版本号，再把下方 <version> 替换为该版本。',\n      updateManualTitle: '手动更新',\n",
    'zh unknown-target copy',
)
client = replace_once(
    client,
    "      updateManualAgeHint: '上方会优先使用检测到的具体版本号；只有所有版本源都失败时才退回 @latest。pnpm 11 默认会在新版本发布 24 小时内静默拦截 @latest / 普通 update（minimumReleaseAge 策略，但命令仍可能显示成功）。若只能看到 @latest，请打开 Releases 把 latest 换成最新具体版本号，或运行 npx dsh-vision-router repair 后重试。',\n",
    "      updateManualAgeHint: '上方只会使用已确认的具体版本号；若无法确认版本，则只提供 <version> 模板。pnpm 11 默认会在新版本发布 24 小时内静默拦截 @latest / 普通 update（minimumReleaseAge 策略，但命令仍可能显示成功），所以这里不再推荐这两种模糊更新方式。',\n",
    'zh manual hint',
)
client = replace_once(
    client,
    "      updateReleaseFallback: 'npm registry checks failed, so the latest version was resolved from GitHub Releases; installation still requires an accessible npm registry.',\n      updateManualTitle: 'Manual update',\n",
    "      updateReleaseFallback: 'npm registry checks failed, so the latest version was resolved from GitHub Releases; installation still requires an accessible npm registry.',\n      updateManualUnknownTarget: 'The latest version could not be confirmed, so no @latest or plain update command is generated. Open Releases first, confirm the newest version, then replace <version> in the template below.',\n      updateManualTitle: 'Manual update',\n",
    'en unknown-target copy',
)
client = replace_once(
    client,
    "      updateManualAgeHint: 'The command above prefers an exact detected version and falls back to @latest only when every version source fails. pnpm 11 can silently withhold @latest / plain update for releases younger than 24h (minimumReleaseAge) even while reporting success. If you only see @latest, open Releases and replace latest with the exact newest version, or run npx dsh-vision-router repair and retry.',\n",
    "      updateManualAgeHint: 'The command above only uses a confirmed exact version; if no version can be confirmed, the UI shows a <version> template instead. pnpm 11 can silently withhold @latest / plain update for releases younger than 24h (minimumReleaseAge) even while reporting success, so those ambiguous update forms are no longer recommended here.',\n",
    'en manual hint',
)

old_block = '''        // When a newer version is known, the manual commands install it
        // explicitly: plain `update` can be silently withheld by pnpm 11's
        // minimumReleaseAge policy while still reporting success.
        const manualPackageSpec =
          result && typeof result.latestVersion === 'string' && result.latestVersion
            ? 'dsh-vision-router@' + result.latestVersion
            : result && typeof result.packageSpec === 'string' && result.packageSpec.startsWith('dsh-vision-router@')
              ? result.packageSpec
              : 'dsh-vision-router@latest'
        // Never show a bare `update dsh-vision-router` recovery command: pnpm
        // 11 can report success while minimumReleaseAge silently keeps the old
        // version. `add <package>@<target>` is explicit; normally <target> is
        // the exact registry/GitHub-release version, with @latest only as the
        // last-resort display when no version source is reachable.
        const manualAction = 'add ' + manualPackageSpec
'''
new_block = '''        // Manual recovery is executable only when an exact target was
        // confirmed by npm metadata or GitHub Releases. If every version source
        // is unavailable, show a non-executable <version> template instead of
        // falling back to @latest / plain update, both of which pnpm 11 may
        // silently withhold while still reporting success.
        const manualVersion =
          result && typeof result.latestVersion === 'string' && result.latestVersion.trim()
            ? result.latestVersion.trim()
            : ''
        const manualTargetKnown = manualVersion !== ''
        const manualPackageSpec = 'dsh-vision-router@' + (manualTargetKnown ? manualVersion : '<version>')
        const manualAction = 'add ' + manualPackageSpec
'''
client = replace_once(client, old_block, new_block, 'manual package target block')

client = replace_once(
    client,
    "              h('div', { className: 'vr-update-manual-title' }, t('updateManualTitle')),\n              auto && auto.reason === 'source-cli-needs-loader'\n",
    "              h('div', { className: 'vr-update-manual-title' }, t('updateManualTitle')),\n              !manualTargetKnown\n                ? h('p', { className: 'vr-update-note' }, t('updateManualUnknownTarget'))\n                : null,\n              auto && auto.reason === 'source-cli-needs-loader'\n",
    'manual unknown-target note',
)
client_path.write_text(client)

update_path = Path('lib/update-check.js')
update = update_path.read_text()
update = replace_once(
    update,
    "      releasesUrl: RELEASES_URL,\n      packageSpec: `${PACKAGE_NAME}@latest`,\n      installMethodAgnostic: true,\n      error: errorMessage(error),\n",
    "      releasesUrl: RELEASES_URL,\n      // No ambiguous package target when every version source failed. The UI\n      // must require the user to confirm an exact release before constructing\n      // a recovery command.\n      installMethodAgnostic: true,\n      error: errorMessage(error),\n",
    'cached failure packageSpec',
)
update_path.write_text(update)

client_test_path = Path('tests/client.test.js')
client_test = client_test_path.read_text()
client_test = replace_once(
    client_test,
    "  assert.equal(source.includes(\"'dsh-vision-router@latest'\"), true)\n",
    "  assert.equal(source.includes(\"'dsh-vision-router@latest'\"), false)\n  assert.equal(source.includes(\"'<version>'\"), true)\n  assert.equal(source.includes('const manualTargetKnown = manualVersion !=='), true)\n  assert.equal(source.includes('updateManualUnknownTarget'), true)\n",
    'client test ambiguous fallback assertion',
)
client_test_path.write_text(client_test)

update_test_path = Path('tests/update-check.test.js')
update_test = update_test_path.read_text()
update_test = replace_once(
    update_test,
    "  assert.equal(result.currentVersion, '1.1.1')\n  assert.match(result.error, /offline/)\n",
    "  assert.equal(result.currentVersion, '1.1.1')\n  assert.equal(result.packageSpec, undefined)\n  assert.match(result.error, /offline/)\n",
    'update-check failure target assertion',
)
update_test_path.write_text(update_test)

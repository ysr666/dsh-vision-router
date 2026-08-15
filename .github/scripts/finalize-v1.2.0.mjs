import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`)
  return source.replace(from, to)
}

function replaceRange(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`${label}: start marker not found`)
  const end = source.indexOf(endMarker, start)
  if (end < 0) throw new Error(`${label}: end marker not found`)
  return source.slice(0, start) + replacement + source.slice(end)
}

// ── Settings UX / update recovery ───────────────────────────────────────────
const clientPath = 'lib/client.js'
let client = readFileSync(clientPath, 'utf8')
client = replaceOnce(client, "desc: '会话模型负责聊天，视觉后端负责看图；两者分开设置 · 面板 v7'", "desc: '会话模型负责聊天，视觉后端负责看图；两者分开设置 · 面板 v8'", 'zh panel version')
client = replaceOnce(client, "quickStartTitle: '先分清两个模型'", "quickStartTitle: '聊天与看图分别设置'", 'zh quick-start title')
client = replaceOnce(client, "desc: 'The session model chats; the vision backend sees images. They are configured separately · panel v7'", "desc: 'The session model chats; the vision backend sees images. They are configured separately · panel v8'", 'en panel version')
client = replaceOnce(client, "quickStartTitle: 'Know the two model settings'", "quickStartTitle: 'Chat and vision are configured separately'", 'en quick-start title')

client = replaceOnce(
  client,
  "      updateReleaseNotes: '查看更新说明',\n",
  "      updateReleaseNotes: '查看更新说明',\n" +
  "      updateRegistryFallback: '当前配置的 registry 不可用，已自动改用 npm 官方源完成检查。',\n" +
  "      updateManualTitle: '手动更新',\n" +
  "      updateManualSource: '源码仓库 / pnpm DSH：',\n" +
  "      updateManualNpx: '普通 npm / npx DSH：',\n" +
  "      updateProject: '项目主页',\n" +
  "      updateReleases: 'Releases',\n",
  'zh update recovery copy',
)
client = replaceOnce(
  client,
  "      updateReleaseNotes: 'View release notes',\n",
  "      updateReleaseNotes: 'View release notes',\n" +
  "      updateRegistryFallback: 'The configured registry failed; the check succeeded through the official npm registry.',\n" +
  "      updateManualTitle: 'Manual update',\n" +
  "      updateManualSource: 'DSH source checkout / pnpm:',\n" +
  "      updateManualNpx: 'Normal npm / npx DSH:',\n" +
  "      updateProject: 'Project',\n" +
  "      updateReleases: 'Releases',\n",
  'en update recovery copy',
)

const updatePanel = `      const updatePanel = () => {
        const result = updateState.result
        const auto = result && result.autoUpdate
        const profile = auto && typeof auto.profile === 'string' && auto.profile ? auto.profile : 'web'
        const projectUrl = 'https://github.com/ysr666/dsh-vision-router'
        const releasesUrl =
          result && typeof result.releasesUrl === 'string' && result.releasesUrl
            ? result.releasesUrl
            : projectUrl + '/releases/latest'
        const pnpmCommand = 'pnpm dsh plugin --profile ' + profile + ' update dsh-vision-router'
        const npxCommand = 'npx @deepseek-ai/dsh plugin --profile ' + profile + ' update dsh-vision-router'
        let status
        let failedUpdate = false
        if (updateState.status === 'running') {
          status = t('updateChecking')
        } else if (result && result.ok === true) {
          if (result.updateAvailable === true) {
            status = t('updateAvailable', { current: result.currentVersion, latest: result.latestVersion })
          } else if (result.aheadOfRegistry === true) {
            status = t('updateAhead', { current: result.currentVersion, latest: result.latestVersion })
          } else {
            status = t('updateCurrent', { current: result.currentVersion })
          }
        } else if (updateState.status === 'done') {
          failedUpdate = true
          status = t('updateFailed', { error: result && result.error ? result.error : 'unknown' })
        }
        let selfUpdateStatus
        let selfUpdateFailed = false
        if (selfUpdateState.status === 'running') {
          selfUpdateStatus = t('updateRunning')
        } else if (selfUpdateState.status === 'done' && selfUpdateState.result && selfUpdateState.result.ok === true) {
          selfUpdateStatus = t('updateSuccess', {
            latest: selfUpdateState.result.targetVersion || (result && result.latestVersion) || '',
          })
        } else if (selfUpdateState.status === 'error') {
          selfUpdateFailed = true
          selfUpdateStatus = t('updateActionFailed', {
            error: selfUpdateState.result && selfUpdateState.result.error ? selfUpdateState.result.error : 'unknown',
          })
        }
        const showManualHelp =
          failedUpdate ||
          selfUpdateState.status === 'error' ||
          (result && result.ok === true && result.updateAvailable === true && (!auto || auto.supported !== true))
        const commandStyle = {
          display: 'block',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          padding: '8px 10px',
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-3)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 12,
        }
        const manualHelp = showManualHelp
          ? h('div', { className: 'vr-catalog-error' },
              h('div', { className: 'vr-label' }, t('updateManualTitle')),
              auto && auto.reason === 'source-cli-needs-loader'
                ? h('div', null,
                    h('p', { className: 'vr-hint' }, t('updateManualSource')),
                    h('code', { style: commandStyle }, pnpmCommand),
                  )
                : null,
              h('p', { className: 'vr-hint' }, t('updateManualNpx')),
              h('code', { style: commandStyle }, npxCommand),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
                h('button', {
                  type: 'button', className: 'vr-btn',
                  onClick: () => window.open(projectUrl, '_blank', 'noopener,noreferrer'),
                }, t('updateProject')),
                h('button', {
                  type: 'button', className: 'vr-btn',
                  onClick: () => window.open(releasesUrl, '_blank', 'noopener,noreferrer'),
                }, t('updateReleases')),
              ),
            )
          : null
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('span', { className: 'vr-label' }, t('updateTitle')),
            h('button', {
              type: 'button', className: 'vr-btn',
              disabled: updateState.status === 'running' || selfUpdateState.status === 'running',
              onClick: () => runUpdateCheck(true),
            }, updateState.status === 'running' ? t('updateChecking') : t('checkUpdate')),
          ),
          status ? h('p', { className: failedUpdate ? 'vr-failed' : 'vr-hint' }, status) : null,
          result && result.ok === true && result.registryFallbackFrom
            ? h('p', { className: 'vr-hint' }, t('updateRegistryFallback'))
            : null,
          result && result.ok === true && result.updateAvailable === true
            ? h('div', { className: 'vr-catalog-error' },
                h('p', { className: 'vr-hint' }, auto && auto.supported === true ? t('updateInstallHint') : t('updateAutoUnavailable')),
                auto && auto.supported === true && auto.token
                  ? h('button', {
                      type: 'button', className: 'vr-btn vr-btn-save',
                      disabled: selfUpdateState.status === 'running',
                      onClick: runSelfUpdate,
                    }, selfUpdateState.status === 'running'
                      ? t('updateRunning')
                      : t('updateNow', { latest: result.latestVersion }))
                  : null,
                releasesUrl
                  ? h('button', {
                      type: 'button', className: 'vr-btn',
                      disabled: selfUpdateState.status === 'running',
                      onClick: () => window.open(releasesUrl, '_blank', 'noopener,noreferrer'),
                    }, t('updateReleaseNotes'))
                  : null,
                selfUpdateStatus
                  ? h('p', { className: selfUpdateFailed ? 'vr-failed' : 'vr-hint' }, selfUpdateStatus)
                  : null,
              )
            : selfUpdateStatus
              ? h('p', { className: selfUpdateFailed ? 'vr-failed' : 'vr-hint' }, selfUpdateStatus)
              : null,
          manualHelp,
        )
      }

`
client = replaceRange(
  client,
  '      const updatePanel = () => {',
  '      const stealthNotice = () => {',
  updatePanel,
  'update panel',
)
writeFileSync(clientPath, client)

// Preserve the profile even when source-checkout DSH cannot be safely re-executed.
const selfUpdatePath = 'lib/self-update.js'
let selfUpdate = readFileSync(selfUpdatePath, 'utf8')
selfUpdate = replaceOnce(
  selfUpdate,
  `  const cliEntry = safeRealpath(cliArg)\n  if (!cliEntry) return { available: false, reason: 'cli-entry-unresolved' }\n\n  // Running a raw TS/TSX source entry with plain Node may require a loader\n  // owned by the source workspace. Do not guess that loader; fall back to the\n  // manual update instructions instead.\n  const extension = path.extname(cliEntry).toLowerCase()\n  if (extension === '.ts' || extension === '.tsx') {\n    return { available: false, reason: 'source-cli-needs-loader' }\n  }\n\n  const owner = findDshPackageRoot(cliEntry)\n  if (!owner) return { available: false, reason: 'unverified-dsh-cli' }\n  const profile = profileFromArgv(argv)\n  if (!profile) return { available: false, reason: 'profile-unresolved' }\n`,
  `  const cliEntry = safeRealpath(cliArg)\n  if (!cliEntry) return { available: false, reason: 'cli-entry-unresolved' }\n  const profile = profileFromArgv(argv)\n  if (!profile) return { available: false, reason: 'profile-unresolved' }\n\n  // Running a raw TS/TSX source entry with plain Node may require a loader\n  // owned by the source workspace. Do not guess that loader; fall back to the\n  // manual update instructions instead. Preserve the profile so the UI can\n  // print the exact pnpm command the user should run.\n  const extension = path.extname(cliEntry).toLowerCase()\n  if (extension === '.ts' || extension === '.tsx') {\n    return { available: false, reason: 'source-cli-needs-loader', profile }\n  }\n\n  const owner = findDshPackageRoot(cliEntry)\n  if (!owner) return { available: false, reason: 'unverified-dsh-cli' }\n`,
  'source self-update profile',
)
writeFileSync(selfUpdatePath, selfUpdate)

const indexPath = 'index.js'
let index = readFileSync(indexPath, 'utf8')
index = replaceOnce(
  index,
  "      profile: selfUpdatePlan.available === true ? selfUpdatePlan.profile : undefined,",
  "      profile: selfUpdatePlan.profile,",
  'client update profile exposure',
)
writeFileSync(indexPath, index)

// ── Tests ───────────────────────────────────────────────────────────────────
const clientTestPath = 'tests/client.test.js'
let clientTest = readFileSync(clientTestPath, 'utf8')
clientTest = replaceOnce(
  clientTest,
  "  assert.equal(source.includes(\"onboardingStep1Title: '1 · 会话 / 文字模型'\"), true)\n",
  "  assert.equal(source.includes(\"onboardingStep1Title: '1 · 会话 / 文字模型'\"), true)\n" +
  "  assert.equal(source.includes(\"quickStartTitle: '聊天与看图分别设置'\"), true)\n" +
  "  assert.equal(source.includes(\"quickStartTitle: 'Chat and vision are configured separately'\"), true)\n" +
  "  assert.equal(source.includes(\"updateProject: '项目主页'\"), true)\n" +
  "  assert.equal(source.includes(\"updateManualSource: '源码仓库 / pnpm DSH：'\"), true)\n" +
  "  assert.equal(source.includes('pnpm dsh plugin --profile '), true)\n" +
  "  assert.equal(source.includes('npx @deepseek-ai/dsh plugin --profile '), true)\n",
  'client recovery regression assertions',
)
writeFileSync(clientTestPath, clientTest)

const selfTestPath = 'tests/self-update.test.js'
let selfTest = readFileSync(selfTestPath, 'utf8')
selfTest = replaceOnce(
  selfTest,
  "    { available: false, reason: 'source-cli-needs-loader' },",
  "    { available: false, reason: 'source-cli-needs-loader', profile: 'web' },",
  'source self-update test',
)
writeFileSync(selfTestPath, selfTest)

// ── Docs for update fallback ────────────────────────────────────────────────
const updateDocPath = 'docs/update-check.md'
let updateDoc = readFileSync(updateDocPath, 'utf8')
updateDoc += `\n## Manual recovery\n\nIf automatic update is unavailable, the version check fails, or a one-click update fails, the settings card still shows direct Project/Releases links and a manual command. For a DeepSeek Harness source checkout run:\n\n\`\`\`sh\npnpm dsh plugin --profile web update dsh-vision-router\n\`\`\`\n\nFor normal npm/npx DSH usage run:\n\n\`\`\`sh\nnpx @deepseek-ai/dsh plugin --profile web update dsh-vision-router\n\`\`\`\n\nThe settings card substitutes the active profile when it can determine one.\n`
writeFileSync(updateDocPath, updateDoc)

const updateZhPath = 'docs/update-check.zh-CN.md'
let updateZh = readFileSync(updateZhPath, 'utf8')
updateZh += `\n## 手动兜底\n\n如果自动更新不可用、版本检查失败，或一键更新失败，设置卡仍会直接显示项目主页 / Releases 入口和可执行的手动命令。DeepSeek Harness 源码仓库通过 pnpm 启动时使用：\n\n\`\`\`sh\npnpm dsh plugin --profile web update dsh-vision-router\n\`\`\`\n\n普通 npm / npx DSH 使用：\n\n\`\`\`sh\nnpx @deepseek-ai/dsh plugin --profile web update dsh-vision-router\n\`\`\`\n\n如果插件能识别当前 profile，设置页会把命令里的 \`web\` 自动替换成实际 profile。\n`
writeFileSync(updateZhPath, updateZh)

// ── v1.2.0 release metadata ─────────────────────────────────────────────────
const packagePath = 'package.json'
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
pkg.version = '1.2.0'
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')

const changelogPath = 'CHANGELOG.md'
let changelog = readFileSync(changelogPath, 'utf8')
const changelogMarker = '## v1.1.1\n'
const v120 = `## v1.2.0\n\n### 新增 / Added\n\n- **真正零配置的匿名视觉兜底**：内置 OVHcloud 五模型视觉链固定作为最终兜底，免注册、免 Key；用户自己配置的视觉模型仍优先。OVH 匿名额度按每 IP、每模型 2 次/分钟独立计算，五个模型理论合计约 10 RPM，实际以 OVH 限流为准。\n- **Zero-config anonymous vision fallback**: a five-model OVHcloud image chain is now the fixed final fallback with no signup or API key; user-configured vision models still run first. Anonymous OVH buckets are 2 RPM per IP per model, roughly 10 RPM in theory across five independent models, subject to OVH rate limiting.\n- **安全的图片展示**：新增 \`vision_present\`，生成 / 编辑 / 截图得到的图片可作为 DSH 持久附件直接内联展示；刷新后仍可查看，并避免把展示图片塞回纯文本 DeepSeek 请求。\n- **Safe image presentation**: \`vision_present\` stores generated/edited/screenshot images as durable DSH attachments for inline display and refresh persistence without feeding display images back into text-only DeepSeek requests.\n- **诊断与修复工具**：新增 \`npx dsh-vision-router doctor\` / \`repair\`，可在 DSH 因 profile UTF-8 BOM 无法启动时独立检测并安全移除 BOM。\n- **Doctor / repair CLI**: \`npx dsh-vision-router doctor\` and \`repair\` can diagnose and safely remove a profile UTF-8 BOM even when DSH cannot boot.\n- **版本检查与安全更新**：设置页会明确提示发现的新版本；继承的 npm/pnpm registry 失败时自动回退 npm 官方源；自动更新不可用或失败时显示 pnpm / npx 手动命令、项目主页与 Releases。\n- **Update checks and safe updates**: the settings card explicitly reports newer versions, falls back from a broken inherited npm/pnpm registry to npmjs, and shows pnpm/npx manual commands plus Project/Releases links when automatic update is unavailable or fails.\n\n### 改进 / Changed\n\n- **聊天模型和看图模型彻底分开**：聊天页右下角只负责会话模型；设置页「视觉后端链」一行一个用户视觉模型；内部 \`Vision HTTP\` 不再暴露给用户，OVH 匿名链固定在最后自动兜底。\n- **Chat and vision model UX is fully separated**: the lower-right chat picker only chooses the conversation model; settings rows choose user vision models; internal \`Vision HTTP\` is hidden and the anonymous OVH chain remains the automatic final fallback.\n- 首次引导升级为三步模型说明，标题统一为 **“Vision Router 已准备好 🎉”**；设置卡提示改为更自然的「聊天与看图分别设置」。\n- First-run guidance now explains the two model roles in three steps under **“Vision Router is ready 🎉”**; the permanent settings hint is now “Chat and vision are configured separately.”\n- OpenAI-compatible 视觉 HTTP 后端现在保留用户问题，GLM 等模型的输出 token 差异通过集中兼容规则与有限纠错处理。\n- OpenAI-compatible vision HTTP calls now preserve the user's question, with centralized compatibility handling for GLM-style output-token limits and bounded corrective retries.\n\n### 修复 / Fixed\n\n- **修复纯文本 DeepSeek 会话被图片工具结果永久污染**：递归清理嵌套 \`tool-result\` 中的图片块，保留原始会话附件供 UI / \`vision_describe\` 使用，同时确保纯文本适配器永远收不到不支持的 image content。\n- **Fixed text-only DeepSeek history poisoning from image tool results**: nested \`tool-result\` image blocks are sanitized before model calls while durable attachments remain available to the UI and \`vision_describe\`.\n- 匿名 OVH 429 不再在单模型内部长时间等待，立即切换到下一个独立限额模型；Windows/macOS/Linux 的 Chrome/Edge 截图路径发现也更完整。\n- Anonymous OVH 429 responses now move immediately to the next independently rate-limited model instead of sleeping inside one bucket; Chrome/Edge discovery for screenshots is also broader across Windows/macOS/Linux.\n\n`
changelog = replaceOnce(changelog, changelogMarker, v120 + changelogMarker, 'v1.2.0 changelog section')
writeFileSync(changelogPath, changelog)

function updateReadme(path, lang) {
  let text = readFileSync(path, 'utf8')
  text = text.replaceAll('releases/tag/v1.1.1', 'releases/tag/v1.2.0')
  text = text.replaceAll('release-v1.1.1', 'release-v1.2.0')
  text = text.replaceAll('Release v1.1.1', 'Release v1.2.0')
  text = text.replaceAll('verified-102%20tests', 'verified-144%20tests')
  text = text.replaceAll('Verified: 102 tests', 'Verified: 144 tests')
  if (lang === 'zh') {
    text = replaceRange(
      text,
      '> [!WARNING]\n> 📌 **公告（v1.1.1）**',
      '<p align="center">\n  <img src="assets/vision-demo.gif"',
      `> [!WARNING]\n> 📌 **公告（v1.2.0）**\n>\n> v1.2.0 把“开箱即用”这条链路完整收口：聊天页右下角只选会话模型，设置页只选用户视觉模型，内部 \`Vision HTTP\` 不再暴露；内置 5 模型 OVH 匿名免费链固定在最后兜底，免注册、免 Key。新增三步模型引导、\`vision_present\` 持久内联图片、BOM doctor/repair、版本检查/安全更新，并修复图片工具结果污染纯文本 DeepSeek 历史导致后续对话崩溃的问题。\n\n<p align="center">\n  <img src="assets/vision-demo.gif"`,
      'zh v1.2 announcement',
    )
    text = text.replace('| 测试 | 86 | 162 |', '| 测试 | 144 | 162 |')
    text = text.replace(
      '- **默认免费。** 视觉链内置 OVHcloud 匿名端点（`Qwen2.5-VL-72B-Instruct`，免注册、免 Key，每 IP 2 次/分钟）。付费链路（OpenRouter、Pi-AI 供应商、任意 OpenAI 兼容直连端点）是可选升级。',
      '- **默认免费。** 视觉工具最终兜底为 5 个 OVHcloud 匿名视觉模型：免注册、免 Key，每 IP、每模型 2 次/分钟，独立限额理论合计约 10 次/分钟；用户自备视觉模型会优先调用。',
    )
  } else {
    text = replaceRange(
      text,
      '> [!WARNING]\n> 📌 **Announcement (v1.1.1)**',
      '<p align="center">\n  <img src="assets/vision-demo.gif"',
      `> [!WARNING]\n> 📌 **Announcement (v1.2.0)**\n>\n> v1.2.0 closes the loop on zero-config vision: the lower-right chat picker only selects conversation models, settings only select user vision models, internal \`Vision HTTP\` is hidden, and a five-model anonymous OVH chain remains the final no-signup/no-key fallback. It also adds the three-step model guide, durable inline \`vision_present\` images, BOM doctor/repair, resilient update checks/safe updates, and fixes image tool results poisoning text-only DeepSeek histories.\n\n<p align="center">\n  <img src="assets/vision-demo.gif"`,
      'en v1.2 announcement',
    )
    text = text.replace('| Tests | 86 | 162 |', '| Tests | 144 | 162 |')
    text = text.replace(
      '- **Free by default.** The vision chain starts with a built-in OVHcloud anonymous endpoint (`Qwen2.5-VL-72B-Instruct`, no account, no key, 2 req/min per IP). Paid chains (OpenRouter, Pi-AI providers, direct OpenAI-compatible endpoints) are optional upgrades.',
      '- **Free by default.** Vision tools end with a five-model OVHcloud anonymous fallback: no account, no key, 2 requests/minute per IP per model, roughly 10 RPM in theory across independent buckets. User-provided vision models run first.',
    )
  }
  writeFileSync(path, text)
}

updateReadme('README.md', 'en')
updateReadme('README.zh.md', 'zh')

console.log('v1.2.0 finalization patch applied')

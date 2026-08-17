from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# ── lib/update-check.js ──────────────────────────────────────────────────────
path = Path('lib/update-check.js')
text = path.read_text()

text = replace_once(
    text,
    "export const RELEASES_URL = 'https://github.com/ysr666/dsh-vision-router/releases/latest'\n",
    "export const RELEASES_URL = 'https://github.com/ysr666/dsh-vision-router/releases/latest'\n"
    "export const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/ysr666/dsh-vision-router/releases/latest'\n",
    'add GitHub release API constant',
)

anchor = """async function fetchLatestVersion({ fetchImpl, registryBase, signal, timeoutMs }) {
  const endpoint = `${registryBase}/${encodeURIComponent(PACKAGE_NAME)}/latest`
  // Give every registry attempt its own timeout. In particular, a slow mirror
  // must not consume the signal used by the npmjs fallback attempt.
  const requestSignal = signal ?? AbortSignal.timeout(timeoutMs)
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: requestSignal,
  })
  if (!response.ok) throw new Error(`update registry returned HTTP ${response.status}`)
  const body = await response.json().catch(() => undefined)
  const latestVersion = body && typeof body.version === 'string' ? body.version.trim() : ''
  if (!parseSemver(latestVersion)) throw new Error('update registry returned an invalid version')
  return latestVersion
}
"""
replacement = anchor + """

async function fetchLatestReleaseVersion({ fetchImpl, releaseApi, signal, timeoutMs }) {
  const requestSignal = signal ?? AbortSignal.timeout(timeoutMs)
  const response = await fetchImpl(releaseApi, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-vision-router-update-check',
    },
    signal: requestSignal,
  })
  if (!response.ok) throw new Error(`GitHub releases API returned HTTP ${response.status}`)
  const body = await response.json().catch(() => undefined)
  const tag = body && typeof body.tag_name === 'string' ? body.tag_name.trim() : ''
  const latestVersion = tag.replace(/^v/i, '')
  if (!parseSemver(latestVersion)) throw new Error('GitHub latest release returned an invalid tag')
  return latestVersion
}
"""
text = replace_once(text, anchor, replacement, 'add GitHub release fallback helper')

text = replace_once(
    text,
    "  fallbackRegistry = DEFAULT_NPM_REGISTRY,\n  signal,\n",
    "  fallbackRegistry = DEFAULT_NPM_REGISTRY,\n  releaseApi = GITHUB_LATEST_RELEASE_API,\n  signal,\n",
    'add releaseApi option to checkPackageUpdate',
)

old_tail = """  throw new Error(
    'update check failed: ' +
      failures.map((item) => `${item.registry} (${item.error})`).join(' -> '),
  )
}
"""
new_tail = """  // Registry metadata is the source of truth for installability, but a user's
  // registry path can be blocked while GitHub remains reachable. Use the
  // project's latest release only as a read-only version fallback so the UI
  // can still show an exact `@<version>` recovery command instead of falling
  // back to a bare `update` (which pnpm 11 may silently withhold for 24h).
  if (signal?.aborted) throw signal.reason ?? new Error('update check aborted')
  try {
    const latestVersion = await fetchLatestReleaseVersion({
      fetchImpl,
      releaseApi,
      signal,
      timeoutMs,
    })
    const precedence = compareSemver(currentVersion, latestVersion)
    return {
      ok: true,
      packageName: PACKAGE_NAME,
      currentVersion,
      latestVersion,
      updateAvailable: precedence === -1,
      aheadOfRegistry: precedence === 1,
      checkedAt: Date.now(),
      latestSource: 'github-release',
      releaseFallback: true,
      registryFailures: failures,
      releasesUrl: RELEASES_URL,
      // Exact on purpose: `@latest` can still be filtered by pnpm 11's
      // minimumReleaseAge policy, while an explicit version is exempted.
      packageSpec: `${PACKAGE_NAME}@${latestVersion}`,
      installMethodAgnostic: true,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const releaseFailure = errorMessage(error)
    throw new Error(
      'update check failed: ' +
        [
          ...failures.map((item) => `${item.registry} (${item.error})`),
          `${releaseApi} (${releaseFailure})`,
        ].join(' -> '),
    )
  }
}
"""
text = replace_once(text, old_tail, new_tail, 'add GitHub release fallback')

text = replace_once(
    text,
    "  fallbackRegistry = DEFAULT_NPM_REGISTRY,\n  successTtlMs = 6 * 60 * 60 * 1000,\n",
    "  fallbackRegistry = DEFAULT_NPM_REGISTRY,\n  releaseApi = GITHUB_LATEST_RELEASE_API,\n  successTtlMs = 6 * 60 * 60 * 1000,\n",
    'add releaseApi option to cached checker',
)
text = replace_once(
    text,
    "      registry,\n      fallbackRegistry,\n      timeoutMs,\n",
    "      registry,\n      fallbackRegistry,\n      releaseApi,\n      timeoutMs,\n",
    'pass releaseApi to checkPackageUpdate',
)
path.write_text(text)


# ── lib/client.js ────────────────────────────────────────────────────────────
path = Path('lib/client.js')
text = path.read_text()

text = replace_once(
    text,
    "      updateFailed: '更新检查失败：{error}',\n",
    "      updateFailed: '更新检查失败：{error}',\n"
    "      updateNoDiagnostic: '更新检查接口未返回可诊断的错误详情',\n"
    "      updateInvalidResponse: '更新检查接口返回了无效响应',\n",
    'add Chinese update diagnostics copy',
)
text = replace_once(
    text,
    "      updateRegistryFallback: '当前配置的 registry 不可用，已自动改用 npm 官方源完成检查。',\n",
    "      updateRegistryFallback: '当前配置的 registry 不可用，已自动改用 npm 官方源完成检查。',\n"
    "      updateReleaseFallback: 'npm registry 检查失败，已通过 GitHub Releases 获取最新版本号；安装仍需 npm registry 可访问。',\n",
    'add Chinese release fallback copy',
)
text = replace_once(
    text,
    "      updateManualAgeHint: '若执行后版本仍未变化：pnpm 11 默认在新版本发布 24 小时内静默拦截更新（minimumReleaseAge 策略，但命令仍显示成功）。请使用上方带版本号的安装命令，或运行 npx dsh-vision-router repair 清理过期的版本钉住豁免后重试。',\n",
    "      updateManualAgeHint: '上方会优先使用检测到的具体版本号；只有所有版本源都失败时才退回 @latest。pnpm 11 默认会在新版本发布 24 小时内静默拦截 @latest / 普通 update（minimumReleaseAge 策略，但命令仍可能显示成功）。若只能看到 @latest，请打开 Releases 把 latest 换成最新具体版本号，或运行 npx dsh-vision-router repair 后重试。',\n",
    'update Chinese release-age hint',
)

text = replace_once(
    text,
    "      updateFailed: 'Update check failed: {error}',\n",
    "      updateFailed: 'Update check failed: {error}',\n"
    "      updateNoDiagnostic: 'The update-check endpoint returned no diagnostic error details',\n"
    "      updateInvalidResponse: 'The update-check endpoint returned an invalid response',\n",
    'add English update diagnostics copy',
)
text = replace_once(
    text,
    "      updateRegistryFallback: 'The configured registry failed; the check succeeded through the official npm registry.',\n",
    "      updateRegistryFallback: 'The configured registry failed; the check succeeded through the official npm registry.',\n"
    "      updateReleaseFallback: 'npm registry checks failed, so the latest version was resolved from GitHub Releases; installation still requires an accessible npm registry.',\n",
    'add English release fallback copy',
)
text = replace_once(
    text,
    "      updateManualAgeHint: 'If the version still has not changed after running this: pnpm 11 silently withholds releases younger than 24h (minimumReleaseAge policy, default 1440 minutes) while the command still reports success. Use the versioned install command above, or run npx dsh-vision-router repair to clean up a stale version-pinned exemption, then retry.',\n",
    "      updateManualAgeHint: 'The command above prefers an exact detected version and falls back to @latest only when every version source fails. pnpm 11 can silently withhold @latest / plain update for releases younger than 24h (minimumReleaseAge) even while reporting success. If you only see @latest, open Releases and replace latest with the exact newest version, or run npx dsh-vision-router repair and retry.',\n",
    'update English release-age hint',
)

run_check_anchor = """      const runUpdateCheck = async (force = false) => {
        if (updateState.status === 'running') return
"""
run_check_replacement = """      const diagnosticError = (value, fallback) => {
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
        if (value && typeof value.message === 'string' && value.message.trim() !== '') {
          return value.message.trim()
        }
        return fallback
      }

      const runUpdateCheck = async (force = false) => {
        if (updateState.status === 'running') return
"""
text = replace_once(text, run_check_anchor, run_check_replacement, 'add update diagnostic helper')

text = replace_once(
    text,
    """          if (!response.ok) {
            throw new Error(result && result.error ? result.error : `HTTP ${response.status}`)
          }
          setUpdateState({ status: 'done', result })
""",
    """          if (!response.ok) {
            throw new Error(diagnosticError(result && result.error, `HTTP ${response.status}`))
          }
          if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
            throw new Error(t('updateInvalidResponse'))
          }
          setUpdateState({ status: 'done', result })
""",
    'validate update-check response',
)

text = replace_once(
    text,
    """          if (!response.ok) {
            throw new Error(result && result.error ? result.error : `HTTP ${response.status}`)
          }
          setSelfUpdateState({ status: 'done', result })
""",
    """          if (!response.ok) {
            throw new Error(diagnosticError(result && result.error, `HTTP ${response.status}`))
          }
          if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
            throw new Error(t('updateInvalidResponse'))
          }
          setSelfUpdateState({ status: 'done', result })
""",
    'validate self-update response',
)

old_manual = """        const manualAction =
          result && typeof result.latestVersion === 'string' && result.latestVersion
            ? 'add dsh-vision-router@' + result.latestVersion
            : 'update dsh-vision-router'
        const pnpmCommand = 'pnpm dsh plugin --profile ' + profile + ' ' + manualAction
"""
new_manual = """        const manualPackageSpec =
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
        const pnpmCommand = 'pnpm dsh plugin --profile ' + profile + ' ' + manualAction
"""
text = replace_once(text, old_manual, new_manual, 'make manual update command explicit')

text = replace_once(
    text,
    "          status = t('updateFailed', { error: result && result.error ? result.error : 'unknown' })\n",
    "          status = t('updateFailed', { error: diagnosticError(result && result.error, t('updateNoDiagnostic')) })\n",
    'remove unknown from update-check status',
)
text = replace_once(
    text,
    "            error: selfUpdateState.result && selfUpdateState.result.error ? selfUpdateState.result.error : 'unknown',\n",
    "            error: diagnosticError(selfUpdateState.result && selfUpdateState.result.error, t('updateNoDiagnostic')),\n",
    'remove unknown from self-update status',
)

text = replace_once(
    text,
    """          result && result.ok === true && result.registryFallbackFrom
            ? h('p', { className: 'vr-hint' }, t('updateRegistryFallback'))
            : null,
""",
    """          result && result.ok === true && result.registryFallbackFrom
            ? h('p', { className: 'vr-hint' }, t('updateRegistryFallback'))
            : null,
          result && result.ok === true && result.releaseFallback === true
            ? h('p', { className: 'vr-hint' }, t('updateReleaseFallback'))
            : null,
""",
    'render GitHub release fallback note',
)
path.write_text(text)


# ── tests/update-check.test.js ──────────────────────────────────────────────
path = Path('tests/update-check.test.js')
text = path.read_text()
text = replace_once(
    text,
    "  createCachedUpdateChecker,\n",
    "  createCachedUpdateChecker,\n  GITHUB_LATEST_RELEASE_API,\n",
    'import GitHub release API constant',
)

insert_after = """test('checkPackageUpdate falls back to npmjs when an inherited pnpm/npm registry fails', async () => {
  const requests = []
  const result = await checkPackageUpdate({
    currentVersion: '1.1.1',
    registry: 'https://slow-mirror.example.test/',
    fetchImpl: async (url) => {
      requests.push(url)
      if (url.startsWith('https://slow-mirror.example.test/')) {
        throw new Error('The operation was aborted due to timeout')
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { version: '1.2.0' }
        },
      }
    },
  })
  assert.deepEqual(requests, [
    'https://slow-mirror.example.test/dsh-vision-router/latest',
    'https://registry.npmjs.org/dsh-vision-router/latest',
  ])
  assert.equal(result.ok, true)
  assert.equal(result.latestVersion, '1.2.0')
  assert.equal(result.registry, 'https://registry.npmjs.org')
  assert.equal(result.registryFallbackFrom, 'https://slow-mirror.example.test')
})
"""
new_test = """

test('checkPackageUpdate uses GitHub Releases to recover an exact target when registries fail', async () => {
  const requests = []
  const result = await checkPackageUpdate({
    currentVersion: '1.4.0',
    registry: 'https://offline-mirror.example.test/',
    fetchImpl: async (url) => {
      requests.push(url)
      if (url === GITHUB_LATEST_RELEASE_API) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { tag_name: 'v1.5.0' }
          },
        }
      }
      throw new Error('registry offline')
    },
  })
  assert.deepEqual(requests, [
    'https://offline-mirror.example.test/dsh-vision-router/latest',
    'https://registry.npmjs.org/dsh-vision-router/latest',
    GITHUB_LATEST_RELEASE_API,
  ])
  assert.equal(result.ok, true)
  assert.equal(result.latestVersion, '1.5.0')
  assert.equal(result.updateAvailable, true)
  assert.equal(result.latestSource, 'github-release')
  assert.equal(result.releaseFallback, true)
  assert.equal(result.packageSpec, 'dsh-vision-router@1.5.0')
  assert.equal(result.registryFailures.length, 2)
})
"""
text = replace_once(text, insert_after, insert_after + new_test, 'add GitHub release fallback regression test')
path.write_text(text)


# ── tests/client.test.js ────────────────────────────────────────────────────
path = Path('tests/client.test.js')
text = path.read_text()
old_test = """test('manual update help uses a dedicated vertical command card', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("className: 'vr-update-manual'"), true)
  assert.equal(source.includes("className: 'vr-update-command'"), true)
  assert.equal(source.includes("className: 'vr-update-code'"), true)
  assert.equal(source.includes("className: 'vr-update-note'"), true)
  assert.equal(source.includes("className: 'vr-update-actions'"), true)
  assert.equal(source.includes("const commandStyle = {"), false)
})
"""
new_client_test = """test('manual update help uses a dedicated vertical command card and never falls back to bare update', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("className: 'vr-update-manual'"), true)
  assert.equal(source.includes("className: 'vr-update-command'"), true)
  assert.equal(source.includes("className: 'vr-update-code'"), true)
  assert.equal(source.includes("className: 'vr-update-note'"), true)
  assert.equal(source.includes("className: 'vr-update-actions'"), true)
  assert.equal(source.includes("const commandStyle = {"), false)
  assert.equal(source.includes(": 'update dsh-vision-router'"), false)
  assert.equal(source.includes("const manualAction = 'add ' + manualPackageSpec"), true)
  assert.equal(source.includes("'dsh-vision-router@latest'"), true)
  assert.equal(source.includes("updateNoDiagnostic: '更新检查接口未返回可诊断的错误详情'"), true)
  assert.equal(source.includes("updateInvalidResponse: '更新检查接口返回了无效响应'"), true)
  assert.equal(source.includes("typeof result.ok !== 'boolean'"), true)
  assert.equal(source.includes("result.releaseFallback === true"), true)
})
"""
text = replace_once(text, old_test, new_client_test, 'harden manual update client regression test')
path.write_text(text)

import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from)
  if (first === -1) throw new Error(`missing patch anchor: ${label}`)
  if (text.indexOf(from, first + from.length) !== -1) throw new Error(`duplicate patch anchor: ${label}`)
  return text.slice(0, first) + to + text.slice(first + from.length)
}

let index = readFileSync('index.js', 'utf8')
index = replaceOnce(
  index,
  "import { createCachedUpdateChecker } from './lib/update-check.js'\n",
  "import { createCachedUpdateChecker } from './lib/update-check.js'\n" +
    "import { detectDshSelfUpdatePlan, runDshPluginUpdate } from './lib/self-update.js'\n" +
    "import { randomBytes } from 'node:crypto'\n",
  'index imports',
)

const oldChecker = `  // Version checks never mutate the installation. They only compare this
  // package's own version with the configured/inherited npm registry, so the
  // behavior is identical for npx/global CLI/source-checkout/bun-style DSH
  // launches. The process-local cache keeps card opens from spamming registry.
  const updateChecker = createCachedUpdateChecker({
    fetchImpl: (...args) => globalThis.fetch(...args),
  })
  void updateChecker.check(false).then((result) => {
    if (result && result.ok === true && result.updateAvailable === true) {
      ctx.logger?.info(
        'vision-router: update available %s -> %s',
        result.currentVersion,
        result.latestVersion,
      )
    }
  })
`
const newChecker = `  // Version checks are install-method agnostic. One-click update is stricter:
  // it is exposed only when the exact CLI entry hosting this process can be
  // traced back to @deepseek-ai/dsh, so we never guess npm/pnpm/npx/bun.
  const updateChecker = createCachedUpdateChecker({
    fetchImpl: (...args) => globalThis.fetch(...args),
  })
  const selfUpdatePlan = detectDshSelfUpdatePlan()
  let selfUpdateToken = randomBytes(24).toString('base64url')
  let selfUpdateInFlight
  const updateResultForClient = (result) => ({
    ...result,
    autoUpdate: {
      supported: selfUpdatePlan.available === true,
      method: selfUpdatePlan.available === true ? selfUpdatePlan.method : undefined,
      profile: selfUpdatePlan.available === true ? selfUpdatePlan.profile : undefined,
      reason: selfUpdatePlan.available === true ? undefined : selfUpdatePlan.reason,
      token:
        selfUpdatePlan.available === true &&
        result &&
        result.ok === true &&
        result.updateAvailable === true
          ? selfUpdateToken
          : undefined,
    },
  })
  void updateChecker.check(false).then((result) => {
    if (result && result.ok === true && result.updateAvailable === true) {
      ctx.logger?.info(
        'vision-router: update available %s -> %s',
        result.currentVersion,
        result.latestVersion,
      )
    }
  })
`
index = replaceOnce(index, oldChecker, newChecker, 'update checker')

const oldRoute = `  // Install-method-agnostic update status for the settings card. Manual
  // checks pass ?force=1; startup/card-open checks share the process cache.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/_dsh/vision-router/update-check',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.setHeader('Allow', 'GET')
              res.writeHead(405)
              res.end()
              return
            }
            const force = /(?:[?&])force=1(?:&|$)/.test(String(req.url ?? ''))
            const result = await updateChecker.check(force)
            res.writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(result))
          },
        }),
      'vision-router: update-check route',
    )
  })
`
const newRoute = `  // Install-method-agnostic update status for the settings card. Manual
  // checks pass ?force=1; startup/card-open checks share the process cache.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/_dsh/vision-router/update-check',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.setHeader('Allow', 'GET')
              res.writeHead(405)
              res.end()
              return
            }
            const force = /(?:[?&])force=1(?:&|$)/.test(String(req.url ?? ''))
            const result = await updateChecker.check(force)
            res.writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(updateResultForClient(result)))
          },
        }),
      'vision-router: update-check route',
    )
  })

  // Safe one-click updater. The browser cannot choose a command, package or
  // target version: POST merely asks the server to refresh the registry and
  // run DSH's own updater for this package through the verified current CLI.
  // A process-local token plus a non-simple custom header prevents a random
  // cross-origin page from submitting a blind update request to localhost.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/_dsh/vision-router/self-update',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.setHeader('Allow', 'POST')
              res.writeHead(405)
              res.end()
              return
            }
            const fetchSite = String(req.headers?.['sec-fetch-site'] ?? '')
            if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
              res.writeHead(403, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'cross-origin update request rejected' }))
              return
            }
            const token = String(req.headers?.['x-dsh-vision-router-update-token'] ?? '')
            if (!token || token !== selfUpdateToken) {
              res.writeHead(403, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'invalid update token' }))
              return
            }
            if (selfUpdatePlan.available !== true) {
              res.writeHead(409, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'automatic update is not safe for this DSH launch' }))
              return
            }
            try {
              const fresh = await updateChecker.check(true)
              if (!fresh || fresh.ok !== true) {
                res.writeHead(502, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: fresh?.error || 'could not refresh update metadata' }))
                return
              }
              if (fresh.updateAvailable !== true) {
                res.writeHead(409, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: 'no newer version is currently available' }))
                return
              }
              if (!selfUpdateInFlight) {
                const pending = runDshPluginUpdate(selfUpdatePlan)
                  .then((result) => ({ ...result, targetVersion: fresh.latestVersion }))
                selfUpdateInFlight = pending
                void pending.finally(() => {
                  if (selfUpdateInFlight === pending) selfUpdateInFlight = undefined
                })
              }
              const result = await selfUpdateInFlight
              // Rotate the token after a successful mutation so a captured
              // request cannot be replayed. The current card already moves to
              // the restart-required state and no longer needs the old token.
              selfUpdateToken = randomBytes(24).toString('base64url')
              res.writeHead(200, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
              })
              res.end(JSON.stringify(result))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end(
                JSON.stringify({
                  ok: false,
                  error: error && error.message ? error.message : String(error),
                }),
              )
            }
          },
        }),
      'vision-router: self-update route',
    )
  })
`
index = replaceOnce(index, oldRoute, newRoute, 'update routes')
writeFileSync('index.js', index)

let client = readFileSync('lib/client.js', 'utf8')
const zhStrings = `      updateTitle: '版本更新',
      checkUpdate: '检查更新',
      updateChecking: '检查中…',
      updateAvailable: '发现新版本 v{latest}（当前 v{current}）',
      updateCurrent: '已是最新版本 v{current}',
      updateAhead: '当前 v{current} 高于 registry 最新 v{latest}；可能是源码或预发布构建，不会建议降级。',
      updateFailed: '更新检查失败：{error}',
      updateInstallHint: '检查与安装方式无关；发现新版本后，请沿用你原来安装 DSH / 插件的方式更新。本插件不会自动执行 npm、pnpm、npx 或 bun 命令。',
      updateReleaseNotes: '查看更新说明',
`
const zhStringsNew = `      updateTitle: '版本更新',
      checkUpdate: '检查更新',
      updateChecking: '检查中…',
      updateAvailable: '发现新版本 v{latest}（当前 v{current}）',
      updateCurrent: '已是最新版本 v{current}',
      updateAhead: '当前 v{current} 高于 registry 最新 v{latest}；可能是源码或预发布构建，不会建议降级。',
      updateFailed: '更新检查失败：{error}',
      updateInstallHint: '已安全识别当前 DSH CLI，可直接用这套 DSH 更新插件；完成后需要重启 DSH 才会加载新版本。',
      updateAutoUnavailable: '当前 DSH CLI 无法被安全识别，因此不执行自动更新。请沿用你原来安装 DSH / 插件的方式手动更新。',
      updateNow: '一键更新到 v{latest}',
      updateRunning: '正在更新…',
      updateConfirm: '将通过当前正在运行的 DSH 更新 Vision Router。更新完成后需要重启 DSH。继续吗？',
      updateSuccess: '更新命令已完成（目标 v{latest}）。请重启 DSH；重启后新版本才会生效。',
      updateActionFailed: '一键更新失败：{error}',
      updateReleaseNotes: '查看更新说明',
`
client = replaceOnce(client, zhStrings, zhStringsNew, 'Chinese update strings')

const enStrings = `      updateTitle: 'Updates',
      checkUpdate: 'Check for updates',
      updateChecking: 'Checking…',
      updateAvailable: 'Update available: v{latest} (current v{current})',
      updateCurrent: 'Up to date: v{current}',
      updateAhead: 'Current v{current} is ahead of registry v{latest}; this may be a source or prerelease build, so no downgrade is suggested.',
      updateFailed: 'Update check failed: {error}',
      updateInstallHint: 'Checking is independent of how DSH was installed. When an update is available, update through the same DSH/plugin installation path you originally used. This plugin never runs npm, pnpm, npx, or bun update commands automatically.',
      updateReleaseNotes: 'View release notes',
`
const enStringsNew = `      updateTitle: 'Updates',
      checkUpdate: 'Check for updates',
      updateChecking: 'Checking…',
      updateAvailable: 'Update available: v{latest} (current v{current})',
      updateCurrent: 'Up to date: v{current}',
      updateAhead: 'Current v{current} is ahead of registry v{latest}; this may be a source or prerelease build, so no downgrade is suggested.',
      updateFailed: 'Update check failed: {error}',
      updateInstallHint: 'The current DSH CLI was verified, so Vision Router can update through this same DSH installation. Restart DSH after the update to load the new plugin bundle.',
      updateAutoUnavailable: 'The current DSH CLI could not be verified safely, so automatic update is disabled. Update through the same DSH/plugin installation path you originally used.',
      updateNow: 'Update to v{latest}',
      updateRunning: 'Updating…',
      updateConfirm: 'Vision Router will update through the DSH CLI that is currently running. You will need to restart DSH afterward. Continue?',
      updateSuccess: 'The update command completed (target v{latest}). Restart DSH to load the new version.',
      updateActionFailed: 'One-click update failed: {error}',
      updateReleaseNotes: 'View release notes',
`
client = replaceOnce(client, enStrings, enStringsNew, 'English update strings')

client = replaceOnce(
  client,
  "      const [updateState, setUpdateState] = useState({ status: 'idle', result: undefined })\n",
  "      const [updateState, setUpdateState] = useState({ status: 'idle', result: undefined })\n" +
    "      const [selfUpdateState, setSelfUpdateState] = useState({ status: 'idle', result: undefined })\n",
  'self update state',
)

const runCheck = `      const runUpdateCheck = async (force = false) => {
        if (updateState.status === 'running') return
        setUpdateState({ status: 'running', result: updateState.result })
        try {
          const response = await fetch(
            '/_dsh/vision-router/update-check' + (force ? '?force=1' : ''),
            { cache: 'no-store' },
          )
          const result = await response.json().catch(() => undefined)
          if (!response.ok) {
            throw new Error(result && result.error ? result.error : \`HTTP \${response.status}\`)
          }
          setUpdateState({ status: 'done', result })
        } catch (error) {
          setUpdateState({
            status: 'done',
            result: {
              ok: false,
              error: error && error.message ? error.message : String(error),
            },
          })
        }
      }
`
const runCheckNew = runCheck + `
      const runSelfUpdate = async () => {
        if (selfUpdateState.status === 'running') return
        const checked = updateState.result
        const auto = checked && checked.autoUpdate
        if (!checked || checked.ok !== true || checked.updateAvailable !== true || !auto || !auto.token) return
        if (typeof window.confirm === 'function' && !window.confirm(t('updateConfirm'))) return
        setSelfUpdateState({ status: 'running', result: undefined })
        try {
          const response = await fetch('/_dsh/vision-router/self-update', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'x-dsh-vision-router-update-token': auto.token },
          })
          const result = await response.json().catch(() => undefined)
          if (!response.ok) {
            throw new Error(result && result.error ? result.error : \`HTTP \${response.status}\`)
          }
          setSelfUpdateState({ status: 'done', result })
        } catch (error) {
          setSelfUpdateState({
            status: 'error',
            result: { ok: false, error: error && error.message ? error.message : String(error) },
          })
        }
      }
`
client = replaceOnce(client, runCheck, runCheckNew, 'self update action')

const oldPanel = `      const updatePanel = () => {
        const result = updateState.result
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
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('span', { className: 'vr-label' }, t('updateTitle')),
            h('button', {
              type: 'button', className: 'vr-btn', disabled: updateState.status === 'running',
              onClick: () => runUpdateCheck(true),
            }, updateState.status === 'running' ? t('updateChecking') : t('checkUpdate')),
          ),
          status ? h('p', { className: failedUpdate ? 'vr-failed' : 'vr-hint' }, status) : null,
          result && result.ok === true && result.updateAvailable === true
            ? h('div', { className: 'vr-catalog-error' },
                h('p', { className: 'vr-hint' }, t('updateInstallHint')),
                result.releasesUrl
                  ? h('button', {
                      type: 'button', className: 'vr-btn',
                      onClick: () => window.open(result.releasesUrl, '_blank', 'noopener,noreferrer'),
                    }, t('updateReleaseNotes'))
                  : null,
              )
            : null,
        )
      }
`
const newPanel = `      const updatePanel = () => {
        const result = updateState.result
        const auto = result && result.autoUpdate
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
                result.releasesUrl
                  ? h('button', {
                      type: 'button', className: 'vr-btn',
                      disabled: selfUpdateState.status === 'running',
                      onClick: () => window.open(result.releasesUrl, '_blank', 'noopener,noreferrer'),
                    }, t('updateReleaseNotes'))
                  : null,
                selfUpdateStatus
                  ? h('p', { className: selfUpdateFailed ? 'vr-failed' : 'vr-hint' }, selfUpdateStatus)
                  : null,
              )
            : null,
        )
      }
`
client = replaceOnce(client, oldPanel, newPanel, 'update panel')
writeFileSync('lib/client.js', client)

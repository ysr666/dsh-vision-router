import { readFile, writeFile } from 'node:fs/promises'

async function patch(path, transforms) {
  let text = await readFile(path, 'utf8')
  for (const [label, before, after] of transforms) {
    const count = text.split(before).length - 1
    if (count !== 1) throw new Error(`${path}: ${label}: expected one match, found ${count}`)
    text = text.replace(before, after)
  }
  await writeFile(path, text)
}

await patch('index.js', [
  [
    'update checker import',
    "import { appendPromptToImageOnlyMessage, fetchWithOpenAICompatibility } from './lib/http-compat.js'\n",
    "import { appendPromptToImageOnlyMessage, fetchWithOpenAICompatibility } from './lib/http-compat.js'\nimport { createCachedUpdateChecker } from './lib/update-check.js'\n",
  ],
  [
    'startup update checker',
    `  const resolveCredential = async (ref) => {\n    const credentials = ctx.get('credentials')\n    if (credentials === undefined) return undefined\n    try {\n      return (await credentials.resolve(ref))?.value\n    } catch {\n      return undefined\n    }\n  }\n\n  // ── stealth takeover: serve \`deepseek-official\` ourselves ────────────────\n`,
    `  const resolveCredential = async (ref) => {\n    const credentials = ctx.get('credentials')\n    if (credentials === undefined) return undefined\n    try {\n      return (await credentials.resolve(ref))?.value\n    } catch {\n      return undefined\n    }\n  }\n\n  // Version checks never mutate the installation. They only compare this\n  // package's own version with the configured/inherited npm registry, so the\n  // behavior is identical for npx/global CLI/source-checkout/bun-style DSH\n  // launches. The process-local cache keeps card opens from spamming registry.\n  const updateChecker = createCachedUpdateChecker({\n    fetchImpl: (...args) => globalThis.fetch(...args),\n  })\n  void updateChecker.check(false).then((result) => {\n    if (result && result.ok === true && result.updateAvailable === true) {\n      ctx.logger?.info(\n        'vision-router: update available %s -> %s',\n        result.currentVersion,\n        result.latestVersion,\n      )\n    }\n  })\n\n  // ── stealth takeover: serve \`deepseek-official\` ourselves ────────────────\n`,
  ],
  [
    'update-check route',
    `  // Exact capability metadata for the settings card. DSH's public llm.models\n`,
    `  // Install-method-agnostic update status for the settings card. Manual\n  // checks pass ?force=1; startup/card-open checks share the process cache.\n  ctx.inject(['webServer'], (webCtx) => {\n    webCtx.effect(\n      () =>\n        webCtx.webServer.register({\n          kind: 'exact',\n          path: '/_dsh/vision-router/update-check',\n          handler: async (req, res) => {\n            if (req.method !== 'GET') {\n              res.setHeader('Allow', 'GET')\n              res.writeHead(405)\n              res.end()\n              return\n            }\n            const force = /(?:[?&])force=1(?:&|$)/.test(String(req.url ?? ''))\n            const result = await updateChecker.check(force)\n            res.writeHead(200, {\n              'content-type': 'application/json',\n              'cache-control': 'no-store',\n            })\n            res.end(JSON.stringify(result))\n          },\n        }),\n      'vision-router: update-check route',\n    )\n  })\n\n  // Exact capability metadata for the settings card. DSH's public llm.models\n`,
  ],
])

await patch('lib/client.js', [
  [
    'zh update labels',
    `      testOk: '连接正常',\n      testFailed: '连接失败',\n      save: '保存',\n`,
    `      testOk: '连接正常',\n      testFailed: '连接失败',\n      updateTitle: '版本更新',\n      checkUpdate: '检查更新',\n      updateChecking: '检查中…',\n      updateAvailable: '发现新版本 v{latest}（当前 v{current}）',\n      updateCurrent: '已是最新版本 v{current}',\n      updateAhead: '当前 v{current} 高于 registry 最新 v{latest}；可能是源码或预发布构建，不会建议降级。',\n      updateFailed: '更新检查失败：{error}',\n      updateInstallHint: '检查与安装方式无关；发现新版本后，请沿用你原来安装 DSH / 插件的方式更新。本插件不会自动执行 npm、pnpm、npx 或 bun 命令。',\n      updateReleaseNotes: '查看更新说明',\n      save: '保存',\n`,
  ],
  [
    'en update labels',
    `      testOk: 'Connected',\n      testFailed: 'Connection failed',\n      save: 'Save',\n`,
    `      testOk: 'Connected',\n      testFailed: 'Connection failed',\n      updateTitle: 'Updates',\n      checkUpdate: 'Check for updates',\n      updateChecking: 'Checking…',\n      updateAvailable: 'Update available: v{latest} (current v{current})',\n      updateCurrent: 'Up to date: v{current}',\n      updateAhead: 'Current v{current} is ahead of registry v{latest}; this may be a source or prerelease build, so no downgrade is suggested.',\n      updateFailed: 'Update check failed: {error}',\n      updateInstallHint: 'Checking is independent of how DSH was installed. When an update is available, update through the same DSH/plugin installation path you originally used. This plugin never runs npm, pnpm, npx, or bun update commands automatically.',\n      updateReleaseNotes: 'View release notes',\n      save: 'Save',\n`,
  ],
  [
    'update state',
    `      const [testState, setTestState] = useState({ status: 'idle' })\n      const [showAdvanced, setShowAdvanced] = useState(false)\n`,
    `      const [testState, setTestState] = useState({ status: 'idle' })\n      const [updateState, setUpdateState] = useState({ status: 'idle', result: undefined })\n      const [showAdvanced, setShowAdvanced] = useState(false)\n`,
  ],
  [
    'update function',
    `      const runTestConnection = async () => {\n        if (testState.status === 'running') return\n        setTestState({ status: 'running' })\n        try {\n          const response = await fetch('/_dsh/vision-router/test-connection')\n          const result = await response.json().catch(() => undefined)\n          setTestState({ status: 'done', result })\n        } catch (error) {\n          setTestState({ status: 'done', result: { ok: false, error: error && error.message ? error.message : String(error) } })\n        }\n      }\n\n      const h = React.createElement\n`,
    `      const runTestConnection = async () => {\n        if (testState.status === 'running') return\n        setTestState({ status: 'running' })\n        try {\n          const response = await fetch('/_dsh/vision-router/test-connection')\n          const result = await response.json().catch(() => undefined)\n          setTestState({ status: 'done', result })\n        } catch (error) {\n          setTestState({ status: 'done', result: { ok: false, error: error && error.message ? error.message : String(error) } })\n        }\n      }\n\n      const runUpdateCheck = async (force = false) => {\n        if (updateState.status === 'running') return\n        setUpdateState({ status: 'running', result: updateState.result })\n        try {\n          const response = await fetch(\n            '/_dsh/vision-router/update-check' + (force ? '?force=1' : ''),\n            { cache: 'no-store' },\n          )\n          const result = await response.json().catch(() => undefined)\n          if (!response.ok) {\n            throw new Error(result && result.error ? result.error : \`HTTP \${response.status}\`)\n          }\n          setUpdateState({ status: 'done', result })\n        } catch (error) {\n          setUpdateState({\n            status: 'done',\n            result: {\n              ok: false,\n              error: error && error.message ? error.message : String(error),\n            },\n          })\n        }\n      }\n\n      const h = React.createElement\n`,
  ],
  [
    'update kick and panel',
    `      if (open && testState.status === 'idle') {\n        runTestConnection()\n      }\n\n      const stealthNotice = () => {\n`,
    `      if (open && testState.status === 'idle') {\n        runTestConnection()\n      }\n      if (open && updateState.status === 'idle') {\n        runUpdateCheck(false)\n      }\n\n      const updatePanel = () => {\n        const result = updateState.result\n        let status\n        let failedUpdate = false\n        if (updateState.status === 'running') {\n          status = t('updateChecking')\n        } else if (result && result.ok === true) {\n          if (result.updateAvailable === true) {\n            status = t('updateAvailable', { current: result.currentVersion, latest: result.latestVersion })\n          } else if (result.aheadOfRegistry === true) {\n            status = t('updateAhead', { current: result.currentVersion, latest: result.latestVersion })\n          } else {\n            status = t('updateCurrent', { current: result.currentVersion })\n          }\n        } else if (updateState.status === 'done') {\n          failedUpdate = true\n          status = t('updateFailed', { error: result && result.error ? result.error : 'unknown' })\n        }\n        return h('div', { className: 'vr-field' },\n          h('div', { className: 'vr-field-head' },\n            h('span', { className: 'vr-label' }, t('updateTitle')),\n            h('button', {\n              type: 'button', className: 'vr-btn', disabled: updateState.status === 'running',\n              onClick: () => runUpdateCheck(true),\n            }, updateState.status === 'running' ? t('updateChecking') : t('checkUpdate')),\n          ),\n          status ? h('p', { className: failedUpdate ? 'vr-failed' : 'vr-hint' }, status) : null,\n          result && result.ok === true && result.updateAvailable === true\n            ? h('div', { className: 'vr-catalog-error' },\n                h('p', { className: 'vr-hint' }, t('updateInstallHint')),\n                result.releasesUrl\n                  ? h('button', {\n                      type: 'button', className: 'vr-btn',\n                      onClick: () => window.open(result.releasesUrl, '_blank', 'noopener,noreferrer'),\n                    }, t('updateReleaseNotes'))\n                  : null,\n              )\n            : null,\n        )\n      }\n\n      const stealthNotice = () => {\n`,
  ],
  [
    'render update panel',
    `              h('div', { className: 'vr-quickstart' },\n                h('div', { className: 'vr-quickstart-title' }, t('quickStartTitle')),\n                h('p', { className: 'vr-quickstart-body' }, t('quickStartBody')),\n                h('p', { className: 'vr-quickstart-live' }, t('quickStartLive')),\n              ),\n              TOGGLE_KEYS.map((key) => toggleField(key)),\n`,
    `              h('div', { className: 'vr-quickstart' },\n                h('div', { className: 'vr-quickstart-title' }, t('quickStartTitle')),\n                h('p', { className: 'vr-quickstart-body' }, t('quickStartBody')),\n                h('p', { className: 'vr-quickstart-live' }, t('quickStartLive')),\n              ),\n              updatePanel(),\n              TOGGLE_KEYS.map((key) => toggleField(key)),\n`,
  ],
  [
    'open card checks update',
    `            if (!open) {\n              loadCatalog()\n              loadVisionCapabilities()\n            }\n            setOpen(!open)\n`,
    `            if (!open) {\n              loadCatalog()\n              loadVisionCapabilities()\n              runUpdateCheck(false)\n            }\n            setOpen(!open)\n`,
  ],
])

await patch('package.json', [
  [
    'test script',
    `    "test": "node --test tests/core.test.js tests/client.test.js tests/http-compat.test.js"\n`,
    `    "test": "node --test tests/core.test.js tests/client.test.js tests/http-compat.test.js tests/update-check.test.js"\n`,
  ],
])

console.log('update-check patch applied')

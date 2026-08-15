import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before)
  if (first === -1) throw new Error(`missing patch anchor: ${label}`)
  if (text.indexOf(before, first + before.length) !== -1) {
    throw new Error(`patch anchor is not unique: ${label}`)
  }
  return text.slice(0, first) + after + text.slice(first + before.length)
}

function update(path, transform) {
  const before = readFileSync(path, 'utf8')
  const after = transform(before)
  if (after === before) throw new Error(`${path}: patch made no changes`)
  writeFileSync(path, after)
}

update('index.js', (source) => {
  source = replaceOnce(
    source,
    `\nexport function apply(ctx, config = {}) {`,
    `\n/** True only when exact model metadata explicitly declares image input. */\nexport function modelInfoAcceptsImages(info) {\n  return Array.isArray(info && info.inputModalities) && info.inputModalities.includes('image')\n}\n\nexport function apply(ctx, config = {}) {`,
    'index: modelInfoAcceptsImages export',
  )

  source = replaceOnce(
    source,
    `  syncTwins()\n  ctx.on('llm/adapters-updated', syncTwins)\n\n  // ── vision chain route: fallback under our own control ─────────────────────`,
    `  syncTwins()\n  ctx.on('llm/adapters-updated', syncTwins)\n\n  // A generated + 自动识图 route is an admission/tool wrapper, not a real\n  // vision backend. Never offer it as an eye model or recurse into it from\n  // vision_describe. The built-in vision-http route is the deliberate\n  // exception: it is a real image-capable backend implemented by this plugin.\n  const isGeneratedVisionWrapperRoute = (provider) => {\n    if (provider === wrapperRoute() || provider === chainRoute()) return true\n    if (typeof provider !== 'string' || !provider.endsWith('-vision')) return false\n    return twinHandles.has(provider.slice(0, -'-vision'.length))\n  }\n\n  const resolveVisionBackendCapability = async (provider, model) => {\n    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {\n      return { image: false, inputModalities: [], reason: 'missing provider/model' }\n    }\n    if (provider !== HTTP_ROUTE && isGeneratedVisionWrapperRoute(provider)) {\n      return { image: false, inputModalities: [], reason: 'generated auto-vision wrapper, not a vision backend' }\n    }\n    if (!adapterAvailable(ctx.llm, provider)) {\n      return { image: false, inputModalities: [], reason: 'provider adapter is not registered' }\n    }\n    try {\n      const info = await ctx.llm.resolveModelInfo(provider, model)\n      const inputModalities = Array.isArray(info && info.inputModalities)\n        ? info.inputModalities.filter((item) => typeof item === 'string')\n        : []\n      return {\n        image: modelInfoAcceptsImages(info),\n        inputModalities,\n        reason: modelInfoAcceptsImages(info) ? undefined : 'model metadata does not declare image input',\n      }\n    } catch (error) {\n      return {\n        image: false,\n        inputModalities: [],\n        reason: error && error.message ? error.message : String(error),\n      }\n    }\n  }\n\n  const collectVisionBackendCapabilities = async () => {\n    const capabilities = {}\n    if (typeof ctx.llm.listProviders !== 'function') return capabilities\n    let providers = []\n    try {\n      providers = ctx.llm.listProviders()\n    } catch {\n      return capabilities\n    }\n    for (const entry of providers) {\n      const provider = entry && typeof entry.id === 'string' ? entry.id : ''\n      if (provider === '') continue\n      if (provider !== HTTP_ROUTE && isGeneratedVisionWrapperRoute(provider)) continue\n      let listed = []\n      try {\n        const registration = ctx.llm.registration(provider)\n        const adapter = registration && registration.adapter\n        if (!adapter || typeof adapter.listModels !== 'function') continue\n        listed = await adapter.listModels(provider)\n      } catch {\n        continue\n      }\n      const rows = await Promise.all(\n        (Array.isArray(listed) ? listed : [])\n          .filter((model) => model && typeof model.id === 'string' && model.id !== '')\n          .map(async (model) => [model.id, await resolveVisionBackendCapability(provider, model.id)]),\n      )\n      if (rows.length > 0) capabilities[provider] = Object.fromEntries(rows)\n    }\n    return capabilities\n  }\n\n  // ── vision chain route: fallback under our own control ─────────────────────`,
    'index: capability helpers',
  )

  source = replaceOnce(
    source,
    `      async listModels() {\n        return pairs().map((pair) => ({\n          provider: chainRoute(),\n          id: \`\${pair.provider}/\${pair.model}\`,\n          name: \`\${pair.provider}/\${pair.model}\`,\n          inputModalities: ['text', 'image'],\n        }))\n      },`,
    `      async listModels() {\n        const entries = []\n        for (const pair of pairs()) {\n          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)\n          if (!capability.image) continue\n          entries.push({\n            provider: chainRoute(),\n            id: \`\${pair.provider}/\${pair.model}\`,\n            name: \`\${pair.provider}/\${pair.model}\`,\n            inputModalities: ['text', 'image'],\n          })\n        }\n        return entries\n      },`,
    'index: chain catalog filter',
  )

  source = replaceOnce(
    source,
    `          if (!adapterAvailable(ctx.llm, pair.provider)) {\n            failures.push(\n              \`\${pair.provider}/\${pair.model}: no adapter registered for provider "\${pair.provider}"\`,\n            )\n            ctx.logger?.warn(\n              'vision-router: chain skips %s/%s (no adapter)',\n              pair.provider,\n              pair.model,\n            )\n            continue\n          }\n          let budget = defaultBudget`,
    `          if (!adapterAvailable(ctx.llm, pair.provider)) {\n            failures.push(\n              \`\${pair.provider}/\${pair.model}: no adapter registered for provider "\${pair.provider}"\`,\n            )\n            ctx.logger?.warn(\n              'vision-router: chain skips %s/%s (no adapter)',\n              pair.provider,\n              pair.model,\n            )\n            continue\n          }\n          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)\n          if (!capability.image) {\n            failures.push(\n              \`\${pair.provider}/\${pair.model}: not an image-capable backend (\${capability.reason ?? 'unknown capability'})\`,\n            )\n            ctx.logger?.warn(\n              'vision-router: chain skips %s/%s (not image-capable: %s)',\n              pair.provider,\n              pair.model,\n              capability.reason ?? 'unknown capability',\n            )\n            continue\n          }\n          let budget = defaultBudget`,
    'index: chain runtime capability guard',
  )

  source = replaceOnce(
    source,
    `        const usablePairs = pairs().filter((pair) => adapterAvailable(ctx.llm, pair.provider))\n        const key = cacheKeyFor({`,
    `        const usablePairs = []\n        const rejectedPairs = []\n        for (const pair of pairs()) {\n          if (!adapterAvailable(ctx.llm, pair.provider)) {\n            rejectedPairs.push(\`\${pair.provider}/\${pair.model}: provider adapter is not registered\`)\n            continue\n          }\n          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)\n          if (capability.image) usablePairs.push(pair)\n          else {\n            rejectedPairs.push(\n              \`\${pair.provider}/\${pair.model}: not an image-capable backend (\${capability.reason ?? 'unknown capability'})\`,\n            )\n          }\n        }\n        const key = cacheKeyFor({`,
    'index: vision_describe capability filter',
  )

  source = replaceOnce(
    source,
    `        const signal = AbortSignal.timeout(timeoutMs())\n        const errors = []\n\n        for (const pair of usablePairs) {`,
    `        const signal = AbortSignal.timeout(timeoutMs())\n        const errors = [...rejectedPairs]\n\n        for (const pair of usablePairs) {`,
    'index: vision_describe rejected errors',
  )

  source = replaceOnce(
    source,
    `      const errors = []\n      const block = await visionBlocksFromBytes(imageBytes, mediaType)\n      const signal = AbortSignal.timeout(timeoutMs())\n      const usablePairs = pairs().filter((pair) => adapterAvailable(ctx.llm, pair.provider))\n      for (const pair of usablePairs) {`,
    `      const errors = []\n      const block = await visionBlocksFromBytes(imageBytes, mediaType)\n      const signal = AbortSignal.timeout(timeoutMs())\n      const usablePairs = []\n      for (const pair of pairs()) {\n        if (!adapterAvailable(ctx.llm, pair.provider)) {\n          errors.push(\`\${pair.provider}/\${pair.model}: provider adapter is not registered\`)\n          continue\n        }\n        const capability = await resolveVisionBackendCapability(pair.provider, pair.model)\n        if (capability.image) usablePairs.push(pair)\n        else {\n          errors.push(\n            \`\${pair.provider}/\${pair.model}: not an image-capable backend (\${capability.reason ?? 'unknown capability'})\`,\n          )\n        }\n      }\n      for (const pair of usablePairs) {`,
    'index: answerVision capability filter',
  )

  source = replaceOnce(
    source,
    `        const started = Date.now()\n        const first = pairs().find((pair) => adapterAvailable(ctx.llm, pair.provider))\n        const probeModels = async (baseURL) => {`,
    `        const started = Date.now()\n        let first\n        for (const pair of pairs()) {\n          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)\n          if (capability.image) {\n            first = pair\n            break\n          }\n        }\n        const probeModels = async (baseURL) => {`,
    'index: test connection picks a real vision backend',
  )

  source = replaceOnce(
    source,
    `    }, 'vision-router: test-connection route')\n  })\n\n  // Expose the namespace to the web configuration boundary.`,
    `    }, 'vision-router: test-connection route')\n  })\n\n  // Exact capability metadata for the settings card. DSH's public llm.models\n  // wire intentionally omits inputModalities, so the plugin exposes a narrow\n  // read-only view backed by the same resolveModelInfo() check used at runtime.\n  ctx.inject(['webServer'], (webCtx) => {\n    webCtx.effect(\n      () =>\n        webCtx.webServer.register({\n          kind: 'exact',\n          path: '/_dsh/vision-router/model-capabilities',\n          handler: async (req, res) => {\n            if (req.method !== 'GET') {\n              res.setHeader('Allow', 'GET')\n              res.writeHead(405)\n              res.end()\n              return\n            }\n            try {\n              const capabilities = await collectVisionBackendCapabilities()\n              res.writeHead(200, { 'content-type': 'application/json' })\n              res.end(JSON.stringify({ capabilities }))\n            } catch (error) {\n              res.writeHead(500, { 'content-type': 'application/json' })\n              res.end(\n                JSON.stringify({\n                  capabilities: {},\n                  error: error && error.message ? error.message : String(error),\n                }),\n              )\n            }\n          },\n        }),\n      'vision-router: model capabilities route',\n    )\n  })\n\n  // Expose the namespace to the web configuration boundary.`,
    'index: capabilities HTTP route',
  )

  return source
})

update('lib/client.js', (source) => {
  source = replaceOnce(
    source,
    `      chainHint: '这里必须选择真正支持图片输入的视觉模型；不要把纯文本 DeepSeek / opencode 模型当作备用视觉模型。第一行是主视觉模型，后面的行在失败时依次回退。',`,
    `      chainHint: '这里只会显示模型元数据中明确声明支持图片输入的模型；纯文本 DeepSeek / opencode 会自动从下拉列表隐藏。第一行是主视觉模型，后面的行在失败时依次回退。',`,
    'client zh chain hint',
  )
  source = replaceOnce(
    source,
    `      catalogFallback: '），模型字段已退回手动输入。',\n      retryCatalog: '重试加载目录',`,
    `      catalogFallback: '），模型字段已退回手动输入。',\n      visionCapsLoading: '正在验证哪些模型真正支持图片输入…',\n      visionCapsError: '视觉能力元数据暂时不可用；为防止误选，当前只显示内置 Vision HTTP 模型。',\n      visionCapsFiltered: '视觉后端下拉只显示明确声明 image 输入的模型。',\n      chainInvalidCurrent: '当前保存的视觉后端不支持图片或无法验证，已从下拉列表隐藏，运行时也会跳过：',\n      retryCatalog: '重试加载目录',`,
    'client zh capability labels',
  )
  source = replaceOnce(
    source,
    `      chainHint: 'Only put models here that genuinely accept image input. Do not use a text-only DeepSeek/opencode model as a vision fallback. The first row is primary; later rows are tried in order on failure.',`,
    `      chainHint: 'This dropdown only shows models whose metadata explicitly declares image input. Text-only DeepSeek/opencode models are filtered out automatically. The first row is primary; later rows are tried in order on failure.',`,
    'client en chain hint',
  )
  source = replaceOnce(
    source,
    `      catalogFallback: '); model fields fell back to free-text input.',\n      retryCatalog: 'Retry catalog',`,
    `      catalogFallback: '); model fields fell back to free-text input.',\n      visionCapsLoading: 'Checking which models genuinely accept image input…',\n      visionCapsError: 'Vision capability metadata is unavailable; to prevent bad selections, only the built-in Vision HTTP models are shown for now.',\n      visionCapsFiltered: 'The vision-backend dropdown only shows models that explicitly declare image input.',\n      chainInvalidCurrent: 'This saved vision backend does not support images or could not be verified. It is hidden from the dropdown and skipped at runtime: ',\n      retryCatalog: 'Retry catalog',`,
    'client en capability labels',
  )

  source = replaceOnce(
    source,
    `    function unwrapModelsResult(body, t) {\n      if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {\n        if (body.result.ok !== true) {\n          const message =\n            body.result.error && body.result.error.message\n              ? body.result.error.message\n              : t('catalogErrorEnvelope')\n          throw new Error(message)\n        }\n        return body.result.value\n      }\n      return body\n    }`,
    `    function unwrapModelsResult(body, t) {\n      if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {\n        if (body.result.ok !== true) {\n          const message =\n            body.result.error && body.result.error.message\n              ? body.result.error.message\n              : t('catalogErrorEnvelope')\n          throw new Error(message)\n        }\n        return body.result.value\n      }\n      return body\n    }\n\n    function filterVisionBackendGroups(groups, capabilities) {\n      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}\n      return (Array.isArray(groups) ? groups : [])\n        .map((group) => {\n          const models = (group && Array.isArray(group.models) ? group.models : []).filter((model) => {\n            if (!model || typeof model.id !== 'string') return false\n            // The built-in backend is defined by this plugin and always\n            // declares image input. Keeping it visible while the capability\n            // request is still loading avoids a blank default editor.\n            if (group.id === 'vision-http') return true\n            return !!(caps[group.id] && caps[group.id][model.id] && caps[group.id][model.id].image === true)\n          })\n          return { ...group, models }\n        })\n        .filter((group) => group && group.models.length > 0)\n    }`,
    'client filterVisionBackendGroups helper',
  )

  source = replaceOnce(
    source,
    `      const [showAdvanced, setShowAdvanced] = useState(false)\n      const [catalog, setCatalog] = useState({ status: 'idle', groups: [], error: undefined })\n      const catalogReady = catalog.status === 'ready' && catalog.groups.length > 0\n      const loadCatalog = () => {`,
    `      const [showAdvanced, setShowAdvanced] = useState(false)\n      const [catalog, setCatalog] = useState({ status: 'idle', groups: [], error: undefined })\n      const [visionCaps, setVisionCaps] = useState({ status: 'idle', capabilities: {}, error: undefined })\n      const catalogReady = catalog.status === 'ready' && catalog.groups.length > 0\n      const visionGroups = filterVisionBackendGroups(catalog.groups, visionCaps.capabilities)\n      const visionModelsFor = (providerId) => {\n        const group = visionGroups.find((entry) => entry.id === providerId)\n        return group && Array.isArray(group.models) ? group.models : []\n      }\n      const visionProviderVisible = (providerId) =>\n        typeof providerId === 'string' && visionGroups.some((entry) => entry.id === providerId)\n      const visionModelVisible = (providerId, modelId) =>\n        typeof modelId === 'string' && visionModelsFor(providerId).some((entry) => entry.id === modelId)\n      const loadCatalog = () => {`,
    'client capability state',
  )

  source = replaceOnce(
    source,
    `      }\n      let snapshot\n      let renderError`,
    `      }\n      const loadVisionCapabilities = () => {\n        if (visionCaps.status === 'loading' || visionCaps.status === 'ready') return\n        setVisionCaps({ status: 'loading', capabilities: {}, error: undefined })\n        fetch('/_dsh/vision-router/model-capabilities')\n          .then(async (response) => {\n            const body = await response.json().catch(() => undefined)\n            if (!response.ok) {\n              throw new Error(body && body.error ? body.error : \`HTTP \${response.status}\`)\n            }\n            return body\n          })\n          .then(\n            (body) =>\n              setVisionCaps({\n                status: 'ready',\n                capabilities: body && body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {},\n                error: undefined,\n              }),\n            (error) =>\n              setVisionCaps({\n                status: 'error',\n                capabilities: {},\n                error: error && error.message ? error.message : String(error),\n              }),\n          )\n      }\n      let snapshot\n      let renderError`,
    'client capability loader',
  )

  source = replaceOnce(
    source,
    `            const filled = rows.filter((row) => row && row.provider && row.model)\n            return filled.length > 0 ? { value: filled } : { clear: true }`,
    `            const filled = rows.filter((row) => row && row.provider && row.model)\n            if (visionCaps.status === 'ready' && filled.some((row) => !visionModelVisible(row.provider, row.model))) {\n              return undefined\n            }\n            return filled.length > 0 ? { value: filled } : { clear: true }`,
    'client chain parse capability validation',
  )

  source = replaceOnce(
    source,
    `      const groupOptions = catalog.groups.map((group) =>\n        h('option', { value: group.id, key: group.id },\n          (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id) +\n          (group.id === 'vision-http' ? t('builtinFreeTag') : '')),\n      )\n      const modelsOf = (providerId) => {`,
    `      const groupOptions = catalog.groups.map((group) =>\n        h('option', { value: group.id, key: group.id },\n          (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id) +\n          (group.id === 'vision-http' ? t('builtinFreeTag') : '')),\n      )\n      const visionGroupOptions = visionGroups.map((group) =>\n        h('option', { value: group.id, key: group.id },\n          (group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id) +\n          (group.id === 'vision-http' ? t('builtinFreeTag') : '')),\n      )\n      const modelsOf = (providerId) => {`,
    'client vision group options',
  )

  source = replaceOnce(
    source,
    `      const chainEditor = () => {\n        const value = format('providers')\n        const rows = Array.isArray(value) && value.length > 0 ? value : [{ provider: '', model: '' }]\n        const updateChain = (index, next) => {`,
    `      const chainEditor = () => {\n        const value = format('providers')\n        const rows = Array.isArray(value) && value.length > 0 ? value : [{ provider: '', model: '' }]\n        const invalidRows =\n          visionCaps.status === 'ready'\n            ? rows.filter((row) => row && row.provider && row.model && !visionModelVisible(row.provider, row.model))\n            : []\n        const updateChain = (index, next) => {`,
    'client chain invalid rows',
  )

  source = replaceOnce(
    source,
    `                className: 'vr-input vr-select', value: row.provider ?? '', disabled: !writable,\n                onChange: (event) => updateChain(index, { provider: event.target.value, model: '' }),\n              },\n                h('option', { value: '' }, t('selectProvider')),\n                groupOptions,\n              ),\n              h('select', {\n                className: 'vr-input vr-select', value: row.model ?? '',\n                disabled: !writable || !row.provider,\n                onChange: (event) => updateChain(index, { provider: row.provider, model: event.target.value }),\n              },\n                h('option', { value: '' }, row.provider ? t('selectModel') : t('pickProviderFirst')),\n                modelsOf(row.provider).map((model) =>`,
    `                className: 'vr-input vr-select', value: visionProviderVisible(row.provider) ? row.provider : '', disabled: !writable,\n                onChange: (event) => updateChain(index, { provider: event.target.value, model: '' }),\n              },\n                h('option', { value: '' }, t('selectProvider')),\n                visionGroupOptions,\n              ),\n              h('select', {\n                className: 'vr-input vr-select', value: visionModelVisible(row.provider, row.model) ? row.model : '',\n                disabled: !writable || !visionProviderVisible(row.provider),\n                onChange: (event) => updateChain(index, { provider: row.provider, model: event.target.value }),\n              },\n                h('option', { value: '' }, visionProviderVisible(row.provider) ? t('selectModel') : t('pickProviderFirst')),\n                visionModelsFor(row.provider).map((model) =>`,
    'client chain uses filtered options',
  )

  source = replaceOnce(
    source,
    `          h('button', {\n            type: 'button', className: 'vr-btn', disabled: !writable,\n            onClick: () => setDraft('providers', [...rows, { provider: '', model: '' }]),\n          }, t('addFallback')),\n          h('p', { className: 'vr-hint' }, t('chainHint')),`,
    `          invalidRows.length > 0\n            ? h('p', { className: 'vr-invalid' },\n                t('chainInvalidCurrent') + ' ' + invalidRows.map((row) => row.provider + '/' + row.model).join('、'))\n            : null,\n          h('button', {\n            type: 'button', className: 'vr-btn', disabled: !writable,\n            onClick: () => setDraft('providers', [...rows, { provider: '', model: '' }]),\n          }, t('addFallback')),\n          h('p', { className: 'vr-hint' }, t('chainHint')),`,
    'client chain invalid warning',
  )

  source = replaceOnce(
    source,
    `      if (open && catalog.status === 'idle') {\n        loadCatalog()\n      }\n      if (open && testState.status === 'idle') {`,
    `      if (open && catalog.status === 'idle') {\n        loadCatalog()\n      }\n      if (open && visionCaps.status === 'idle') {\n        loadVisionCapabilities()\n      }\n      if (open && testState.status === 'idle') {`,
    'client render capability kick',
  )

  source = replaceOnce(
    source,
    `          onClick: () => {\n            if (!open) loadCatalog()\n            setOpen(!open)\n          },`,
    `          onClick: () => {\n            if (!open) {\n              loadCatalog()\n              loadVisionCapabilities()\n            }\n            setOpen(!open)\n          },`,
    'client header capability load',
  )

  source = replaceOnce(
    source,
    `              h('p', { className: 'vr-hint' }, t('defaultChainNote')),\n              catalogReady\n                ? chainEditor()`,
    `              h('p', { className: 'vr-hint' }, t('defaultChainNote')),\n              visionCaps.status === 'loading'\n                ? h('p', { className: 'vr-hint' }, t('visionCapsLoading'))\n                : visionCaps.status === 'error'\n                  ? h('p', { className: 'vr-hint vr-stealth-notice' }, t('visionCapsError'))\n                  : visionCaps.status === 'ready'\n                    ? h('p', { className: 'vr-hint' }, t('visionCapsFiltered'))\n                    : null,\n              catalogReady\n                ? chainEditor()`,
    'client capability status hint',
  )

  source = replaceOnce(
    source,
    `    exports.apply = apply\n    exports.inject = ['settingsScope', 'slots', 'locale']\n    exports.unwrapModelsResult = unwrapModelsResult`,
    `    exports.apply = apply\n    exports.inject = ['settingsScope', 'slots', 'locale']\n    exports.unwrapModelsResult = unwrapModelsResult\n    exports.filterVisionBackendGroups = filterVisionBackendGroups`,
    'client exports filter helper',
  )

  return source
})

update('tests/core.test.js', (source) => {
  source = replaceOnce(
    source,
    `  createStealthAdapter,\n  estimateTokens,`,
    `  createStealthAdapter,\n  modelInfoAcceptsImages,\n  estimateTokens,`,
    'core test import',
  )
  source = replaceOnce(
    source,
    `test('mediaTypeOf maps extensions', () => {`,
    `test('modelInfoAcceptsImages requires an explicit image modality', () => {\n  assert.equal(modelInfoAcceptsImages({ inputModalities: ['text', 'image'] }), true)\n  assert.equal(modelInfoAcceptsImages({ inputModalities: ['text'] }), false)\n  assert.equal(modelInfoAcceptsImages({}), false)\n  assert.equal(modelInfoAcceptsImages(undefined), false)\n})\n\ntest('mediaTypeOf maps extensions', () => {`,
    'core capability test',
  )
  return source
})

update('tests/client.test.js', (source) => {
  source = replaceOnce(
    source,
    `test('the client bundle still loads and registers with the proven injects', () => {`,
    `test('filterVisionBackendGroups hides text-only models and keeps built-in vision-http', () => {\n  const bundle = loadClientBundle()\n  const groups = [\n    { id: 'vision-http', name: 'Vision HTTP', models: [{ id: 'free', name: 'free' }] },\n    { id: 'opencode-go', name: 'opencode-go', models: [\n      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },\n      { id: 'qwen-vl', name: 'Qwen VL' },\n    ] },\n  ]\n  const filtered = bundle.filterVisionBackendGroups(groups, {\n    'opencode-go': {\n      'deepseek-v4-flash': { image: false },\n      'qwen-vl': { image: true },\n    },\n  })\n  assert.deepEqual(filtered.map((group) => [group.id, group.models.map((model) => model.id)]), [\n    ['vision-http', ['free']],\n    ['opencode-go', ['qwen-vl']],\n  ])\n  assert.deepEqual(bundle.filterVisionBackendGroups(groups, {}).map((group) => group.id), ['vision-http'])\n})\n\ntest('the client bundle still loads and registers with the proven injects', () => {`,
    'client capability filter test',
  )
  return source
})

update('README.zh.md', (source) => {
  source = source.replace(
    '> [!IMPORTANT]\n> 这里的“视觉后端链”是 **Vision Router 实际调用的看图模型**，必须是真正支持图片输入的多模态模型；它和聊天页右下角的「+ 自动识图」会话模型组不是一回事。不要把纯文本 DeepSeek / opencode 模型放进这里当视觉备用。',
    '> [!IMPORTANT]\n> 这里的“视觉后端链”是 **Vision Router 实际调用的看图模型**。设置页会读取 DSH 的精确模型元数据，**只显示明确声明支持图片输入的模型**；纯文本 DeepSeek / opencode 会自动从下拉列表隐藏。旧配置若残留纯文本视觉后端，运行时也会自动跳过。它和聊天页右下角的「+ 自动识图」会话模型组不是一回事。',
  )
  return source
})

update('README.md', (source) => {
  source = source.replace(
    '> [!IMPORTANT]\n> This “vision chain” is the **vision backend** called by Vision Router. Its models must genuinely accept image input. It is separate from the “+ Auto Vision” conversation model group in the lower-right selector; do not put a text-only DeepSeek/opencode model here as a vision fallback.',
    '> [!IMPORTANT]\n> This “vision chain” is the **vision backend** called by Vision Router. The settings UI reads exact DSH model metadata and **only shows models that explicitly declare image input**; text-only DeepSeek/opencode models are filtered out. Legacy configs that still contain a text-only vision backend are skipped at runtime as well. This is separate from the “+ Auto Vision” conversation model group in the lower-right selector.',
  )
  return source
})

console.log('vision model capability filter patch applied')

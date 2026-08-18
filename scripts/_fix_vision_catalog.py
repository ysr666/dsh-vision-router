from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


client_path = Path('lib/client.js')
client = client_path.read_text()

client = replace_once(
    client,
    "      catalogFallback: '），模型字段已退回手动输入。',\n",
    "      catalogFallback: '），模型字段已退回手动输入。',\n"
    "      catalogPartialFailure: '部分已配置供应商的模型目录加载失败：{detail}。这些供应商可能仍会显示在「设置 → 模型」中，但暂时不会出现在这里。',\n",
    'zh partial catalog copy',
)
client = replace_once(
    client,
    "      catalogFallback: '); model fields fell back to free-text input.',\n",
    "      catalogFallback: '); model fields fell back to free-text input.',\n"
    "      catalogPartialFailure: 'Some configured providers failed to load their model catalog: {detail}. They may still appear in Settings → Models, but are temporarily unavailable here.',\n",
    'en partial catalog copy',
)

helper_anchor = """    function filterVisionBackendGroups(groups, capabilities) {
"""
helpers = """    function catalogFailureDetail(failures, limit = 300) {
      if (!Array.isArray(failures) || failures.length === 0) return ''
      return failures
        .map((failure) => {
          const label =
            failure && typeof failure.name === 'string' && failure.name !== ''
              ? failure.name
              : failure && typeof failure.id === 'string'
                ? failure.id
                : ''
          const message =
            failure && typeof failure.message === 'string' && failure.message !== ''
              ? failure.message
              : 'unknown catalog error'
          return (label ? label + ': ' : '') + message
        })
        .join('; ')
        .slice(0, limit)
    }

    function catalogStateFromValue(value, t) {
      const groups = value && Array.isArray(value.groups) ? value.groups : []
      const failures = value && Array.isArray(value.failures) ? value.failures : []
      if (groups.length === 0 && failures.length > 0) {
        return {
          status: 'error',
          groups: [],
          failures,
          error: t('catalogEmpty') + catalogFailureDetail(failures),
        }
      }
      return { status: 'ready', groups, failures, error: undefined }
    }

    function subscribeCatalogInvalidations(remote, onInvalidate) {
      if (!remote || typeof remote.$on !== 'function' || typeof onInvalidate !== 'function') return () => {}
      const disposers = [
        remote.$on('llm/adapters-updated', onInvalidate),
        remote.$on('settings/document-updated', onInvalidate),
        remote.$on('credentials/updated', onInvalidate),
      ].filter((dispose) => typeof dispose === 'function')
      return () => {
        for (const dispose of disposers) dispose()
      }
    }

"""
client = replace_once(client, helper_anchor, helpers + helper_anchor, 'catalog helpers')

client = replace_once(
    client,
    "      const [catalog, setCatalog] = useState({ status: 'idle', groups: [], error: undefined })\n"
    "      const [visionCaps, setVisionCaps] = useState({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })\n",
    "      const [catalog, setCatalog] = useState({ status: 'idle', groups: [], failures: [], error: undefined })\n"
    "      const [visionCaps, setVisionCaps] = useState({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })\n"
    "      const catalogGeneration = React.useRef(0)\n"
    "      const visionCapsGeneration = React.useRef(0)\n",
    'catalog state and generations',
)

effect_anchor = """      const loadCatalog = (force = false) => {
"""
effect_block = """      React.useEffect(() => {
        const invalidate = () => {
          // Invalidate in-flight reads as well as cached ready state. Without
          // the generation bump, a pre-change request can resolve last and
          // restore the stale DeepSeek-only catalog after a provider is added.
          catalogGeneration.current += 1
          visionCapsGeneration.current += 1
          setCatalog({ status: 'idle', groups: [], failures: [], error: undefined })
          setVisionCaps({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })
        }
        const stopRemote = subscribeCatalogInvalidations(props.remote, invalidate)
        let stopConnectionReset
        try {
          if (typeof props.subscribeConnectionReset === 'function') {
            stopConnectionReset = props.subscribeConnectionReset(invalidate)
          }
        } catch {
          stopConnectionReset = undefined
        }
        return () => {
          stopRemote()
          if (typeof stopConnectionReset === 'function') stopConnectionReset()
        }
      }, [props.remote, props.subscribeConnectionReset])
"""
client = replace_once(client, effect_anchor, effect_block + effect_anchor, 'catalog invalidation effect')

old_load_catalog = """      const loadCatalog = (force = false) => {
        if (!force && (catalog.status === 'loading' || catalog.status === 'ready')) return
        setCatalog({ status: 'loading', groups: [], error: undefined })
        try {
          const connection = props.getConnection ? props.getConnection() : undefined
          const api = connection && connection.api
          const modelsFn = api && api.llm && typeof api.llm.models === 'function' ? api.llm.models : undefined
          if (modelsFn === undefined) {
            setCatalog({ status: 'error', groups: [], error: t('catalogUnavailable') })
            return
          }
          const timeout = new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error(t('catalogTimeout'))), 15000)
          })
          Promise.race([
            modelsFn({}).catch((error) => {
              throw error && error.message ? error : new Error(String(error))
            }),
            timeout,
          ]).then((body) => unwrapModelsResult(body, t)).then(
            (value) => {
              const groups = (value && value.groups) || []
              const failures = (value && value.failures) || []
              if (groups.length === 0 && failures.length > 0) {
                const detail = failures
                  .map((f) => (f && f.name ? f.name + '：' : '') + ((f && f.message) || ''))
                  .join('；').slice(0, 300)
                setCatalog({ status: 'error', groups: [], error: t('catalogEmpty') + detail })
                return
              }
              setCatalog({ status: 'ready', groups, error: undefined })
            },
            (error) => {
              setCatalog({
                status: 'error',
                groups: [],
                error: error && error.message ? error.message : String(error),
              })
            },
          )
        } catch (error) {
          setCatalog({
            status: 'error',
            groups: [],
            error: error && error.message ? error.message : String(error),
          })
        }
      }
"""
new_load_catalog = """      const loadCatalog = (force = false) => {
        if (!force && (catalog.status === 'loading' || catalog.status === 'ready')) return
        const generation = ++catalogGeneration.current
        setCatalog({ status: 'loading', groups: [], failures: [], error: undefined })
        try {
          const connection = props.getConnection ? props.getConnection() : undefined
          const api = connection && connection.api
          const modelsFn = api && api.llm && typeof api.llm.models === 'function' ? api.llm.models : undefined
          if (modelsFn === undefined) {
            if (generation !== catalogGeneration.current) return
            setCatalog({ status: 'error', groups: [], failures: [], error: t('catalogUnavailable') })
            return
          }
          const timeout = new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error(t('catalogTimeout'))), 15000)
          })
          Promise.race([
            modelsFn({}).catch((error) => {
              throw error && error.message ? error : new Error(String(error))
            }),
            timeout,
          ]).then((body) => unwrapModelsResult(body, t)).then(
            (value) => {
              if (generation !== catalogGeneration.current) return
              setCatalog(catalogStateFromValue(value, t))
            },
            (error) => {
              if (generation !== catalogGeneration.current) return
              setCatalog({
                status: 'error',
                groups: [],
                failures: [],
                error: error && error.message ? error.message : String(error),
              })
            },
          )
        } catch (error) {
          if (generation !== catalogGeneration.current) return
          setCatalog({
            status: 'error',
            groups: [],
            failures: [],
            error: error && error.message ? error.message : String(error),
          })
        }
      }
"""
client = replace_once(client, old_load_catalog, new_load_catalog, 'loadCatalog implementation')

client = replace_once(
    client,
    "      const loadVisionCapabilities = (force = false, silent = false) => {\n"
    "        if (!force && (visionCaps.status === 'loading' || visionCaps.status === 'ready')) return\n",
    "      const loadVisionCapabilities = (force = false, silent = false) => {\n"
    "        if (!force && (visionCaps.status === 'loading' || visionCaps.status === 'ready')) return\n"
    "        const generation = ++visionCapsGeneration.current\n",
    'vision capability generation',
)
client = replace_once(
    client,
    "          .then(\n            (body) =>\n              setVisionCaps({\n                status: 'ready',\n                capabilities: body && body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {},\n                builtinFallback: body && Array.isArray(body.builtinFallback) ? body.builtinFallback : [],\n                anonymousRpmPerModel: body && Number.isFinite(body.anonymousRpmPerModel) ? body.anonymousRpmPerModel : 2,\n                error: undefined,\n              }),\n            (error) =>\n              setVisionCaps({\n                status: 'error',\n                capabilities: {},\n                builtinFallback: [],\n                anonymousRpmPerModel: 2,\n                error: error && error.message ? error.message : String(error),\n              }),\n          )\n",
    "          .then(\n            (body) => {\n              if (generation !== visionCapsGeneration.current) return\n              setVisionCaps({\n                status: 'ready',\n                capabilities: body && body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {},\n                builtinFallback: body && Array.isArray(body.builtinFallback) ? body.builtinFallback : [],\n                anonymousRpmPerModel: body && Number.isFinite(body.anonymousRpmPerModel) ? body.anonymousRpmPerModel : 2,\n                error: undefined,\n              })\n            },\n            (error) => {\n              if (generation !== visionCapsGeneration.current) return\n              setVisionCaps({\n                status: 'error',\n                capabilities: {},\n                builtinFallback: [],\n                anonymousRpmPerModel: 2,\n                error: error && error.message ? error.message : String(error),\n              })\n            },\n          )\n",
    'vision capability stale response guard',
)

client = client.replace(
    "setCatalog({ status: 'idle', groups: [], error: undefined })",
    "setCatalog({ status: 'idle', groups: [], failures: [], error: undefined })",
)

chain_head = """          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('chainLabel')),
            overriddenBadge('providers'),
          ),
          rows.map((row, index) =>
"""
chain_head_new = """          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, t('chainLabel')),
            overriddenBadge('providers'),
          ),
          catalog.status === 'ready' && Array.isArray(catalog.failures) && catalog.failures.length > 0
            ? h('div', { className: 'vr-catalog-error' },
                h('p', { className: 'vr-hint vr-stealth-notice' },
                  t('catalogPartialFailure', { detail: catalogFailureDetail(catalog.failures) }),
                ),
                h('button', {
                  type: 'button', className: 'vr-btn',
                  disabled: catalog.status === 'loading' || visionCaps.status === 'loading',
                  onClick: retryVisionModels,
                }, t('retryCatalog')),
              )
            : null,
          rows.map((row, index) =>
"""
client = replace_once(client, chain_head, chain_head_new, 'partial catalog warning panel')

card_inject_old = "      const cardInject = { scope, getConnection, t, locale: ctx.locale }\n"
card_inject_new = (
    "      const subscribeConnectionReset = (listener) => ctx.on('connection/reset', listener)\n"
    "      const cardInject = { scope, getConnection, t, locale: ctx.locale, remote: ctx.remote, subscribeConnectionReset }\n"
)
client = replace_once(client, card_inject_old, card_inject_new, 'card event inject')

client = replace_once(
    client,
    "    exports.unwrapModelsResult = unwrapModelsResult\n",
    "    exports.unwrapModelsResult = unwrapModelsResult\n"
    "    exports.catalogFailureDetail = catalogFailureDetail\n"
    "    exports.catalogStateFromValue = catalogStateFromValue\n"
    "    exports.subscribeCatalogInvalidations = subscribeCatalogInvalidations\n",
    'catalog helper exports',
)

client_path.write_text(client)


test_path = Path('tests/client.test.js')
tests = test_path.read_text()
tests = replace_once(
    tests,
    "  assert.equal(source.includes('const cardInject = { scope, getConnection, t, locale: ctx.locale }'), true)\n",
    "  assert.equal(source.includes('const cardInject = { scope, getConnection, t, locale: ctx.locale, remote: ctx.remote, subscribeConnectionReset }'), true)\n",
    'stable props assertion',
)

tests += """

test('partial model-catalog failures stay visible beside successful providers', () => {
  const bundle = loadClientBundle()
  const groups = [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }]
  const failures = [{ id: 'zhipu', name: '智谱', message: 'catalog offline' }]
  const state = bundle.catalogStateFromValue({ groups, failures }, (key) => key === 'catalogEmpty' ? 'empty: ' : key)
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.groups, groups)
  assert.deepEqual(state.failures, failures)
  assert.equal(state.error, undefined)
  assert.match(bundle.catalogFailureDetail(failures), /智谱: catalog offline/)

  const failedOnly = bundle.catalogStateFromValue({ groups: [], failures }, (key) => key === 'catalogEmpty' ? 'empty: ' : key)
  assert.equal(failedOnly.status, 'error')
  assert.deepEqual(failedOnly.failures, failures)
  assert.match(failedOnly.error, /empty: 智谱: catalog offline/)

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("catalogPartialFailure: '部分已配置供应商的模型目录加载失败"), true)
  assert.equal(source.includes("t('catalogPartialFailure', { detail: catalogFailureDetail(catalog.failures) })"), true)
})

test('vision catalog invalidates on provider, settings, credential and connection changes', () => {
  const bundle = loadClientBundle()
  const listeners = new Map()
  const disposed = []
  const remote = {
    $on(name, listener) {
      listeners.set(name, listener)
      return () => { disposed.push(name) }
    },
  }
  let invalidations = 0
  const stop = bundle.subscribeCatalogInvalidations(remote, () => { invalidations += 1 })
  assert.deepEqual([...listeners.keys()], [
    'llm/adapters-updated',
    'settings/document-updated',
    'credentials/updated',
  ])
  listeners.get('llm/adapters-updated')()
  listeners.get('settings/document-updated')()
  listeners.get('credentials/updated')()
  assert.equal(invalidations, 3)
  stop()
  assert.deepEqual(disposed.sort(), [...listeners.keys()].sort())

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("const subscribeConnectionReset = (listener) => ctx.on('connection/reset', listener)"), true)
  assert.equal(source.includes('catalogGeneration.current += 1'), true)
  assert.equal(source.includes('generation !== catalogGeneration.current'), true)
  assert.equal(source.includes('generation !== visionCapsGeneration.current'), true)
})
"""

test_path.write_text(tests)

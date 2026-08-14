// dsh-vision-router browser half: the 设置 > 插件 > 插件配置 card that edits
// the `vision-router` settings section owned by the host half. Self-contained
// by hand (no bundler in this repo): the client module system wraps it in a
// CJS factory and the kernel adopts { apply, inject } as a client plugin.
//
// Model fields (vision chain, text model) reuse the SAME catalog the official
// 设置 > 模型 page reads (`llm.models` via the `connection` service), so they
// render as provider/model dropdowns instead of hand-typed strings. When the
// catalog is unavailable, the card falls back to the previous free-text
// inputs so nothing becomes un-editable.
window.__ModuleLoader__.load({
  id: 'dsh-vision-router',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useEffect, useSyncExternalStore } = React

    // ── field specs ──────────────────────────────────────────────────────────
    const TOGGLE_KEYS = ['routing', 'reverseRouting', 'tool', 'rewriteImages', 'downscale', 'cache', 'freeFallback', 'stealth']
    const TOGGLE_LABELS = {
      routing: '图片轮自动路由（发图自动走视觉模型链）',
      reverseRouting: '文字轮反向路由（视觉入口会话的文字轮回文本模型）',
      tool: '识图工具（vision_describe 等，关闭后调用会报错）',
      rewriteImages: '文字轮图片改写（把历史图片替换为文字记录）',
      downscale: '图片自动压缩（超过像素预算的图先缩放再送视觉模型）',
      cache: '识图答案缓存',
      freeFallback: '免费兜底（未配置 httpProviders 时启用内置免 Key 端点）',
      stealth: '隐身模式（接管官方 DeepSeek 路由，模型选择器保持原样）',
    }
    const TOGGLE_HINTS = {
      routing:
        '默认关闭：图片轮不整轮切到视觉模型，而是像普通文本轮一样由会话模型调用 ' +
        'vision_describe 等工具看图，可连续多步操作（定位→裁剪→对比…）。' +
        '开启后恢复旧的整轮一次性自动识图行为；注意：开启时降级链只包含 ' +
        '「视觉模型链」里的 provider+fallbacks，httpProviders（含免费兜底端点）不参与。',
      tool: 'vision_describe / vision_ground 等像素级视觉工具；关闭后这些工具不可用。',
      rewriteImages:
        '把消息里的图片块替换为文字：已有视觉记录就给出记录，否则给出附件标记，' +
        '文本模型始终不会收到它看不懂的图片内容。',
      stealth:
        '需在 profile 补丁层（cordis.patch.yml）禁用官方 llm-deepseek 行后才真正接管；' +
        '官方行还在时插件会自动回退为选择器里的「自动识图」包装路由。改动后需重启 dsh 生效。',
    }
    const NUMBER_KEYS = ['timeoutMs', 'downscaleMaxPixels', 'cacheTtlSeconds', 'cacheMaxEntries']
    const NUMBER_LABELS = {
      timeoutMs: '视觉请求超时（毫秒）',
      downscaleMaxPixels: '图片像素预算（约 8MP = 8000000）',
      cacheTtlSeconds: '缓存有效期（秒，0 = 永久）',
      cacheMaxEntries: '缓存条目上限',
    }
    const NUMBER_META = {
      timeoutMs: { min: 1000 },
      downscaleMaxPixels: { min: 1000 },
      cacheTtlSeconds: { min: 0 },
      cacheMaxEntries: { min: 1 },
    }
    const TEXT_KEYS = ['wrapperRoute', 'chainRoute']
    const TEXT_LABELS = {
      wrapperRoute: '包装路由名（模型选择器里显示的“自动识图”入口）',
      chainRoute: '视觉链路由名',
    }

    function readValue(snapshot, key) {
      const value = snapshot && snapshot.value
      return value && typeof value === 'object' ? value[key] : undefined
    }
    function userHas(snapshot, key) {
      const user = snapshot && snapshot.user
      return user && typeof user === 'object' && key in user
    }

    // ── free-text fallback parsers (used when the model catalog is offline) ──
    function providersToText(value) {
      if (!Array.isArray(value)) return ''
      return value
        .map((pair) => (pair && pair.provider ? `${pair.provider}/${pair.model ?? ''}` : ''))
        .join('\n')
    }
    function parseProviders(text) {
      const list = []
      for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        const idx = line.indexOf('/')
        if (idx <= 0) return undefined
        const provider = line.slice(0, idx).trim()
        const model = line.slice(idx + 1).trim()
        if (provider === '' || model === '') return undefined
        list.push({ provider, model })
      }
      return list
    }
    function textProviderToText(value) {
      if (!value || typeof value !== 'object') return ''
      return `${value.provider ?? ''}/${value.model ?? ''}`
    }
    function parseTextProvider(text) {
      const idx = String(text ?? '').indexOf('/')
      if (idx <= 0) return undefined
      const provider = String(text).slice(0, idx).trim()
      const model = String(text).slice(idx + 1).trim()
      if (provider === '' || model === '') return undefined
      return { provider, model }
    }
    function parseNumber(text, min) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return { clear: true }
      const parsed = Number(trimmed)
      return Number.isInteger(parsed) && parsed >= min ? { value: parsed } : undefined
    }
    function wrapped(value) {
      return value === undefined ? undefined : { value }
    }

    // ── tiny styled primitives ───────────────────────────────────────────────
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' },
      row: { display: 'flex', flexDirection: 'column', gap: 6 },
      rowInline: { display: 'flex', gap: 6, alignItems: 'center' },
      label: { fontSize: 13, fontWeight: 600, color: 'var(--ds-color-text, #333)' },
      hint: { fontSize: 12, color: 'var(--ds-color-text-muted, #888)' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13,
        borderRadius: 6, border: '1px solid var(--ds-color-border, #ccc)',
        background: 'var(--ds-color-bg-input, #fff)', color: 'var(--ds-color-text, #333)',
      },
      select: {
        flex: 1, boxSizing: 'border-box', padding: '8px 10px', fontSize: 13,
        borderRadius: 6, border: '1px solid var(--ds-color-border, #ccc)',
        background: 'var(--ds-color-bg-input, #fff)', color: 'var(--ds-color-text, #333)',
      },
      area: {
        width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 12,
        borderRadius: 6, border: '1px solid var(--ds-color-border, #ccc)', minHeight: 84,
        fontFamily: 'monospace', background: 'var(--ds-color-bg-input, #fff)',
        color: 'var(--ds-color-text, #333)',
      },
      toggleRow: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' },
      toggleLabel: { fontSize: 13, color: 'var(--ds-color-text, #333)', flex: 1 },
      check: { width: 18, height: 18, accentColor: 'var(--ds-color-accent, #4c8bf5)', cursor: 'pointer' },
      buttons: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
      btn: {
        padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--ds-color-border, #ccc)',
        background: 'var(--ds-color-bg, #fff)', color: 'var(--ds-color-text, #333)',
      },
      btnSmall: {
        padding: '8px 12px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--ds-color-border, #ccc)', whiteSpace: 'nowrap',
        background: 'var(--ds-color-bg, #fff)', color: 'var(--ds-color-text, #333)',
      },
      btnPrimary: {
        padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer', border: 'none',
        background: 'var(--ds-color-accent, #4c8bf5)', color: '#fff',
      },
      btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
      badge: {
        fontSize: 11, padding: '1px 6px', borderRadius: 999, color: '#b45309',
        background: 'rgba(245,158,11,0.15)',
      },
      status: { fontSize: 12, color: 'var(--ds-color-text-muted, #888)' },
      statusErr: { fontSize: 12, color: '#dc2626' },
      reset: { fontSize: 12, cursor: 'pointer', color: 'var(--ds-color-accent, #4c8bf5)', background: 'none', border: 'none', padding: 0 },
    }

    function VisionRouterCard(props) {
      const scope = props.scope
      const connection = props.connection
      const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot)
      const [drafts, setDrafts] = useState({})
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState(false)
      const [catalog, setCatalog] = useState({ status: 'loading', groups: [], error: undefined })

      useEffect(() => {
        let live = true
        if (!connection || !connection.api || !connection.api.llm) {
          setCatalog({ status: 'error', groups: [], error: '客户端连接服务不可用，退回手动输入。' })
          return undefined
        }
        connection.api.llm.models({}).then(
          (value) => {
            if (!live) return
            setCatalog({ status: 'ready', groups: (value && value.groups) || [], error: undefined })
          },
          (error) => {
            if (!live) return
            setCatalog({
              status: 'error',
              groups: [],
              error: error && error.message ? error.message : String(error),
            })
          },
        )
        return () => {
          live = false
        }
      }, [])

      const status = snapshot.status
      if (status !== 'ready') {
        return React.createElement(
          'div', { style: S.status },
          status === 'loading' ? '加载配置中…' : 'vision-router 配置命名空间不可用（宿主未注册）。',
        )
      }
      const writable = snapshot.writable
      const selectMode = catalog.status === 'ready' && catalog.groups.length > 0

      const groupOptions = catalog.groups.map((group) =>
        React.createElement(
          'option', { key: group.id, value: group.id },
          group.name && group.name !== group.id ? `${group.name} (${group.id})` : group.id,
        ),
      )
      const modelsOf = (providerId) => {
        const group = catalog.groups.find((entry) => entry.id === providerId)
        return group && Array.isArray(group.models) ? group.models : []
      }

      const format = (key) => {
        if (key in drafts) return drafts[key]
        const value = readValue(snapshot, key)
        if (key === 'providers') {
          if (selectMode) return Array.isArray(value) ? value : []
          return providersToText(value)
        }
        if (key === 'textProvider') {
          if (selectMode) {
            return value && typeof value === 'object'
              ? value
              : { provider: '', model: '' }
          }
          return textProviderToText(value)
        }
        if (key === 'proxyHosts') return Array.isArray(value) ? value.join('\n') : ''
        if (NUMBER_KEYS.includes(key)) return typeof value === 'number' ? String(value) : ''
        if (TOGGLE_KEYS.includes(key)) return value === true
        return typeof value === 'string' ? value : ''
      }
      const parse = (key, text) => {
        if (TOGGLE_KEYS.includes(key)) return { value: text === true }
        if (NUMBER_KEYS.includes(key)) return parseNumber(text, NUMBER_META[key].min)
        if (key === 'providers') {
          if (selectMode) {
            const rows = (text || []).filter((row) => row && row.provider && row.model)
            return rows.length > 0 ? { value: rows } : { clear: true }
          }
          return wrapped(parseProviders(text))
        }
        if (key === 'textProvider') {
          if (selectMode) {
            const pair = text && typeof text === 'object' ? text : { provider: '', model: '' }
            if (pair.provider && pair.model) return { value: { provider: pair.provider, model: pair.model } }
            if (!pair.provider && !pair.model) return { clear: true }
            return undefined
          }
          return wrapped(parseTextProvider(text))
        }
        if (key === 'proxyHosts') {
          const list = String(text ?? '')
            .split('\n')
            .map((host) => host.trim())
            .filter((host) => host !== '')
          return list.length > 0 ? { value: list } : { clear: true }
        }
        const trimmed = String(text ?? '').trim()
        return trimmed === '' ? { clear: true } : { value: trimmed }
      }
      const plan = Object.keys(drafts)
        .map((key) => ({ key, run: parse(key, drafts[key]) }))
        .filter((item) => item.run !== undefined)
      const dirty = Object.keys(drafts).length > 0
      const invalid = plan.length !== Object.keys(drafts).length

      const setDraft = (key, text) => {
        setFailed(false)
        setDrafts((prev) => ({ ...prev, [key]: text }))
      }
      const clearDrafts = () => {
        setDrafts({})
        setFailed(false)
      }
      const save = async () => {
        if (!dirty || invalid || saving) return
        setSaving(true)
        setFailed(false)
        let landed = true
        for (const item of plan) {
          if (item.run.clear) {
            const ok = await scope.unset(item.key).then(() => true, () => false)
            landed = ok && landed
          } else {
            const ok = await scope.set(item.key, item.run.value).then(() => true, () => false)
            landed = ok && landed
          }
        }
        if (landed) setDrafts({})
        setSaving(false)
        setFailed(!landed)
      }
      const resetField = (key) => {
        setFailed(false)
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        scope.unset(key)
      }

      const toggleRow = (key) => React.createElement(
        'div', { key, style: S.row },
        React.createElement('div', { style: S.toggleRow },
          React.createElement('span', { style: S.toggleLabel },
            TOGGLE_LABELS[key],
            userHas(snapshot, key)
              ? React.createElement('span', { style: S.badge }, '已覆盖')
              : null,
          ),
          React.createElement('input', {
            type: 'checkbox', style: S.check, checked: format(key), disabled: !writable,
            onChange: (event) => setDraft(key, event.target.checked),
          }),
        ),
        TOGGLE_HINTS[key]
          ? React.createElement('span', { style: S.hint }, TOGGLE_HINTS[key])
          : null,
      )
      const textRow = (key, label, multi, hint) => React.createElement(
        'div', { key, style: S.row },
        React.createElement('div', { style: S.toggleRow },
          React.createElement('span', { style: S.label },
            label,
            userHas(snapshot, key)
              ? React.createElement('span', { style: S.badge }, '已覆盖')
              : null,
          ),
          userHas(snapshot, key)
            ? React.createElement('button', {
                style: S.reset, disabled: saving,
                onClick: () => resetField(key), title: '恢复为组合配置默认值',
              }, '恢复默认')
            : null,
        ),
        React.createElement(multi ? 'textarea' : 'input', {
          style: multi ? S.area : S.input, value: format(key), disabled: !writable,
          placeholder: '',
          onChange: (event) => setDraft(key, event.target.value),
        }),
        hint ? React.createElement('span', { style: S.hint }, hint) : null,
      )
      const routeRow = (key, label, hint) => React.createElement(
        'div', { key, style: S.row },
        React.createElement('div', { style: S.toggleRow },
          React.createElement('span', { style: S.label },
            label,
            userHas(snapshot, key)
              ? React.createElement('span', { style: S.badge }, '已覆盖')
              : null,
          ),
          userHas(snapshot, key)
            ? React.createElement('button', {
                style: S.reset, disabled: saving,
                onClick: () => resetField(key), title: '恢复为组合配置默认值',
              }, '恢复默认')
            : null,
        ),
        React.createElement('input', {
          style: S.input, value: format(key), disabled: !writable,
          list: `vision-router-routes-${key}`,
          onChange: (event) => setDraft(key, event.target.value),
        }),
        selectMode
          ? React.createElement('datalist', { id: `vision-router-routes-${key}` }, groupOptions)
          : null,
        hint ? React.createElement('span', { style: S.hint }, hint) : null,
      )

      // ── model selectors (catalog-driven) ──────────────────────────────────
      const chainRows = () => {
        const value = format('providers')
        const rows = Array.isArray(value) && value.length > 0
          ? value
          : [{ provider: '', model: '' }]
        const updateChain = (index, next) => {
          const list = rows.map((row) => ({ ...row }))
          list[index] = next
          setDraft('providers', list)
        }
        const removeChain = (index) => {
          const list = rows.filter((_row, i) => i !== index)
          setDraft('providers', list.length > 0 ? list : [{ provider: '', model: '' }])
        }
        const rowsUi = rows.map((row, index) => React.createElement(
          'div', { key: index, style: S.rowInline },
          React.createElement('select', {
            style: S.select, value: row.provider ?? '', disabled: !writable,
            onChange: (event) => updateChain(index, { provider: event.target.value, model: '' }),
          }, [
            React.createElement('option', { key: 'placeholder', value: '' }, '选择供应商…'),
            ...groupOptions,
          ]),
          React.createElement('select', {
            style: S.select, value: row.model ?? '', disabled: !writable || !row.provider,
            onChange: (event) => updateChain(index, { provider: row.provider, model: event.target.value }),
          }, [
            React.createElement('option', { key: 'placeholder', value: '' }, row.provider ? '选择模型…' : '先选供应商'),
            ...modelsOf(row.provider).map((model) =>
              React.createElement(
                'option', { key: model.id, value: model.id },
                model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id,
              ),
            ),
          ]),
          React.createElement('button', {
            style: S.btnSmall, disabled: !writable, title: '移除这一行',
            onClick: () => removeChain(index),
          }, '移除'),
        ))
        return React.createElement(
          'div', { style: S.row },
          React.createElement('div', { style: S.toggleRow },
            React.createElement('span', { style: S.label },
              '视觉模型链（按顺序失败回退）',
              userHas(snapshot, 'providers')
                ? React.createElement('span', { style: S.badge }, '已覆盖')
                : null,
            ),
            userHas(snapshot, 'providers')
              ? React.createElement('button', {
                  style: S.reset, disabled: saving,
                  onClick: () => resetField('providers'), title: '恢复为组合配置默认值',
                }, '恢复默认')
              : null,
          ),
          rowsUi,
          React.createElement('button', {
            style: { ...S.btn, alignSelf: 'flex-start' }, disabled: !writable,
            onClick: () => setDraft('providers', [...rows, { provider: '', model: '' }]),
          }, '+ 添加备用模型'),
          React.createElement('span', { style: S.hint },
            '第一行是主视觉模型，后面的行在其失败时依次回退；各行 provider/model 需成对选齐。'),
        )
      }
      const textProviderSelect = () => {
        const value = format('textProvider')
        const pair = value && typeof value === 'object' ? value : { provider: '', model: '' }
        const setPair = (next) => setDraft('textProvider', next)
        return React.createElement(
          'div', { style: S.row },
          React.createElement('div', { style: S.toggleRow },
            React.createElement('span', { style: S.label },
              '文本模型（文字轮走它）',
              userHas(snapshot, 'textProvider')
                ? React.createElement('span', { style: S.badge }, '已覆盖')
                : null,
            ),
            userHas(snapshot, 'textProvider')
              ? React.createElement('button', {
                  style: S.reset, disabled: saving,
                  onClick: () => resetField('textProvider'), title: '恢复为组合配置默认值',
                }, '恢复默认')
              : null,
          ),
          React.createElement('div', { style: S.rowInline },
            React.createElement('select', {
              style: S.select, value: pair.provider ?? '', disabled: !writable,
              onChange: (event) => setPair({ provider: event.target.value, model: '' }),
            }, [
              React.createElement('option', { key: 'placeholder', value: '' }, '选择供应商…'),
              ...groupOptions,
            ]),
            React.createElement('select', {
              style: S.select, value: pair.model ?? '', disabled: !writable || !pair.provider,
              onChange: (event) => setPair({ provider: pair.provider, model: event.target.value }),
            }, [
              React.createElement('option', { key: 'placeholder', value: '' }, pair.provider ? '选择模型…' : '先选供应商'),
              ...modelsOf(pair.provider).map((model) =>
                React.createElement(
                  'option', { key: model.id, value: model.id },
                  model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id,
                ),
              ),
            ]),
          ),
          React.createElement('span', { style: S.hint },
            '纯文字轮次使用的主力模型；图片轮不受影响。'),
        )
      }

      return React.createElement(
        'div', { style: S.wrap },
        TOGGLE_KEYS.map((key) => toggleRow(key)),
        NUMBER_KEYS.map((key) =>
          textRow(key, NUMBER_LABELS[key], false, `整数，最小 ${NUMBER_META[key].min}；留空清除用户覆盖。`),
        ),
        TEXT_KEYS.map((key) => routeRow(key, TEXT_LABELS[key], '可手输，也可从已注册供应商里选择。')),
        selectMode ? chainRows() : textRow('providers', '视觉模型链', true,
          '模型目录不可用，退回手动输入：每行一个「provider/model」，从上到下按失败顺序回退；留空清除用户覆盖。'),
        selectMode ? textProviderSelect() : textRow('textProvider', '文本模型', false,
          '模型目录不可用，退回手动输入：文字轮的底层模型，格式「provider/model」。'),
        textRow('proxy', '代理地址', false,
          '如 http://127.0.0.1:10808 或 socks5h://127.0.0.1:10808；留空关闭。修改即时生效，无需重启。'),
        textRow('proxyHosts', '走代理的域名（每行一个）', true,
          '仅这些域名经代理；其余（含 DeepSeek）直连。修改即时生效，无需重启。'),
        catalog.status === 'error'
          ? React.createElement('div', { style: S.status },
              `模型目录不可用（${catalog.error}），模型字段已退回手动输入。`)
          : null,
        React.createElement('div', { style: S.status },
          invalid ? '有字段格式不对（模型链需成对选齐；数字需满足最小值）' : '',
        ),
        React.createElement('div', { style: S.buttons },
          React.createElement('button', {
            style: { ...S.btn, ...(!dirty || saving ? S.btnDisabled : {}) },
            disabled: !dirty || saving, onClick: clearDrafts,
          }, '放弃修改'),
          React.createElement('button', {
            style: {
              ...S.btnPrimary,
              ...(!dirty || invalid || saving || !writable ? S.btnDisabled : {}),
            },
            disabled: !dirty || invalid || saving || !writable, onClick: save,
          }, saving ? '保存中…' : '保存'),
        ),
        failed
          ? React.createElement('div', { style: S.statusErr }, '保存失败：宿主拒绝了本次写入（可能配置被其他会话改动），请重试。')
          : null,
      )
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: 'vision-router' })
      const connection = ctx.get('connection')
      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugin.item', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.plugin.item',
                id: 'vision-router',
                order: 30,
                label: '视觉路由（自动识图）',
                inject: () => ({ scope, connection }),
              },
              VisionRouterCard,
            )
          }),
        'vision-router: settings card',
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots', 'connection']
    return module.exports
  },
})

// dsh-vision-router browser half: the 设置 > 插件 > 插件配置 card that edits
// the `vision-router` settings section owned by the host half. Self-contained
// by hand (no bundler in this repo): the client module system wraps it in a
// CJS factory and the kernel adopts { apply, inject } as a client plugin.
window.__ModuleLoader__.load({
  id: 'dsh-vision-router',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useMemo } = React

    // ── field specs ──────────────────────────────────────────────────────────
    const TOGGLE_KEYS = ['routing', 'tool', 'rewriteImages', 'stealth']
    const TOGGLE_LABELS = {
      routing: '图片轮整轮自动路由',
      tool: '识图工具',
      rewriteImages: '图片块改写',
      stealth: '隐身模式',
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
        '接管官方 DeepSeek 路由，模型选择器保持原样。需在 profile 补丁层 ' +
        '（cordis.patch.yml）禁用官方 llm-deepseek 行后才真正接管；官方行还在时 ' +
        '插件自动回退为选择器里的「自动识图」包装路由。改动后需重启 dsh 生效。',
    }
    const TEXT_KEYS = ['wrapperRoute', 'chainRoute']
    const TEXT_LABELS = {
      wrapperRoute: '包装路由名',
      chainRoute: '视觉链路由名',
    }
    const TEXT_HINTS = {
      wrapperRoute: '模型选择器里显示的「自动识图」入口路由名。',
      chainRoute: '视觉链的挂载路由名（识图工具经由真实 provider 直接调用，不经过它）。',
    }

    function readValue(snapshot, key) {
      const value = snapshot && snapshot.value
      return value && typeof value === 'object' ? value[key] : undefined
    }
    function userHas(snapshot, key) {
      const user = snapshot && snapshot.user
      return user && typeof user === 'object' && key in user
    }

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
    function parseNumber(text) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return { clear: true }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) && parsed >= 1000
        ? { value: parsed }
        : undefined
    }

    // ── styles: mirrors the built-in plugin cards (same design tokens) ──────
    const CSS =
      '.vr-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}' +
      '.vr-card:hover{border-color:var(--dsw-alias-label-dimmed)}' +
      '.vr-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
      '.vr-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}' +
      '.vr-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}' +
      '.vr-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
      '.vr-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.vr-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}' +
      '.vr-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}' +
      '.vr-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;font-size:12px;line-height:1}' +
      '.vr-chevron-open{transform:rotate(180deg)}' +
      '.vr-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}' +
      '.vr-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}' +
      '.vr-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}' +
      '.vr-field + .vr-field{border-top:1px solid var(--dsw-alias-border-l2)}' +
      '.vr-field-head{align-items:center;gap:8px;display:flex}' +
      '.vr-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}' +
      '.vr-badges{align-items:center;gap:8px;display:inline-flex}' +
      '.vr-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}' +
      '.vr-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}' +
      '.vr-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}' +
      '.vr-reset:disabled{cursor:default}' +
      '.vr-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}' +
      '.vr-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.vr-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}' +
      '.vr-input-invalid{border-color:var(--dsw-alias-label-error)}' +
      '.vr-area{resize:vertical;min-height:84px;font-family:monospace}' +
      '.vr-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}' +
      '.vr-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}' +
      '.vr-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}' +
      '.vr-toggle{display:flex;align-items:center;gap:10px;justify-content:space-between;width:100%}' +
      '.vr-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}' +
      '.vr-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}' +
      '.vr-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0}' +
      '.vr-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}' +
      '.vr-btn-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:#0000}' +
      '.vr-btn:disabled{opacity:.4;cursor:default}' +
      '.vr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}'

    let stylesInstalled = false
    function installStyles() {
      if (stylesInstalled || typeof document === 'undefined') return
      stylesInstalled = true
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-vision-router'
      tag.dataset.pluginCss = 'dsh-vision-router/plugin-card'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
        stylesInstalled = false
      }
    }

    function VisionRouterCard(props) {
      const scope = props.scope
      // The binder's getSnapshot/subscribe are prototype methods using `this`:
      // passing them bare to useSyncExternalStore detaches the receiver and
      // crashes with "Cannot read properties of undefined (reading 'store')".
      // Bind them so a crash can never abdicate the card again.
      const subscribe = useMemo(() => scope.subscribe.bind(scope), [scope])
      const getSnapshot = useMemo(() => scope.getSnapshot.bind(scope), [scope])
      const [drafts, setDrafts] = useState({})
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState(false)
      const [open, setOpen] = useState(false)
      let snapshot
      let renderError
      try {
        snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
      } catch (error) {
        renderError = error
      }
      if (renderError !== undefined) {
        return React.createElement(
          'li',
          { className: 'vr-card' },
          React.createElement(
            'div',
            { style: { padding: '14px 16px', fontSize: 12, color: 'var(--dsw-alias-label-error)' } },
            '设置卡渲染失败：' + (renderError && renderError.message ? renderError.message : String(renderError)),
          ),
        )
      }
      if (!snapshot || snapshot.status !== 'ready') {
        // Match the built-in cards: render nothing while the namespace is
        // unavailable rather than a disabled card the user cannot act on.
        return null
      }
      const writable = snapshot.writable

      const format = (key) => {
        if (key in drafts) return drafts[key]
        const value = readValue(snapshot, key)
        if (key === 'providers') return providersToText(value)
        if (key === 'textProvider') return textProviderToText(value)
        if (key === 'timeoutMs') return typeof value === 'number' ? String(value) : ''
        if (TOGGLE_KEYS.includes(key)) return value === true
        return typeof value === 'string' ? value : ''
      }
      const parse = (key, text) => {
        if (TOGGLE_KEYS.includes(key)) return { value: text === true }
        if (key === 'providers') {
          const value = parseProviders(text)
          return value === undefined ? undefined : { value }
        }
        if (key === 'textProvider') {
          const value = parseTextProvider(text)
          return value === undefined ? undefined : { value }
        }
        if (key === 'timeoutMs') return parseNumber(text)
        const trimmed = String(text ?? '').trim()
        return trimmed === '' ? { clear: true } : { value: trimmed }
      }
      const plan = Object.keys(drafts)
        .map((key) => ({ key, run: parse(key, drafts[key]) }))
        .filter((item) => item.run !== undefined)
      const dirty = Object.keys(drafts).length > 0
      const invalid = plan.length !== Object.keys(drafts).length
      const blocked = !dirty || invalid || saving || !writable

      const setDraft = (key, text) => {
        setFailed(false)
        setDrafts((prev) => ({ ...prev, [key]: text }))
      }
      const clearDrafts = () => {
        setDrafts({})
        setFailed(false)
      }
      const save = async () => {
        if (blocked) return
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

      const h = React.createElement
      const toggleField = (key) =>
        h('div', { className: 'vr-field', key },
          h('div', { className: 'vr-field-head' },
            h('div', { className: 'vr-toggle' },
              h('span', { className: 'vr-label' }, TOGGLE_LABELS[key]),
              h('input', {
                type: 'checkbox', className: 'vr-check', checked: format(key),
                disabled: !writable,
                onChange: (event) => setDraft(key, event.target.checked),
              }),
            ),
            userHas(snapshot, key)
              ? h('span', { className: 'vr-badges' },
                  h('span', { className: 'vr-badge' }, '已覆盖'),
                  h('button', {
                    type: 'button', className: 'vr-reset', disabled: !writable,
                    onClick: () => resetField(key),
                  }, '恢复默认'))
              : null,
          ),
          TOGGLE_HINTS[key]
            ? h('p', { className: 'vr-hint' }, TOGGLE_HINTS[key])
            : null,
        )
      const textField = (key, label, hint, multi) => {
        const invalidField = key in drafts && parse(key, drafts[key]) === undefined
        return h('div', { className: 'vr-field', key },
          h('div', { className: 'vr-field-head' },
            h('label', { className: 'vr-label' }, label),
            userHas(snapshot, key)
              ? h('span', { className: 'vr-badges' },
                  h('span', { className: 'vr-badge' }, '已覆盖'),
                  h('button', {
                    type: 'button', className: 'vr-reset', disabled: !writable,
                    onClick: () => resetField(key),
                  }, '恢复默认'))
              : null,
          ),
          h(multi ? 'textarea' : 'input', {
            className: 'vr-input' + (multi ? ' vr-area' : '') + (invalidField ? ' vr-input-invalid' : ''),
            value: format(key), disabled: !writable,
            placeholder: '',
            onChange: (event) => setDraft(key, event.target.value),
          }),
          invalidField
            ? h('p', { className: 'vr-invalid' },
                key === 'providers'
                  ? '每行需为「provider/model」，例如 openrouter/qwen3-vl-235b'
                  : key === 'textProvider'
                    ? '格式为「provider/model」，例如 deepseek-official/deepseek-v4-pro'
                    : key === 'timeoutMs'
                      ? '需为 ≥1000 的整数（毫秒）'
                      : '输入无效')
            : hint
              ? h('p', { className: 'vr-hint' }, hint)
              : null,
        )
      }

      return h('li', { className: 'vr-card' + (open ? ' vr-card-open' : '') },
        h('button', {
          type: 'button', className: 'vr-header', 'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'vr-headText' },
            h('span', { className: 'vr-name' }, '视觉路由（自动识图）'),
            h('span', { className: 'vr-desc' }, '视觉模型链、识图工具与图片轮次行为的配置'),
          ),
          dirty ? h('span', { className: 'vr-pending' }, '未保存') : null,
          h('span', { className: 'vr-chevron' + (open ? ' vr-chevron-open' : '') }, '▾'),
        ),
        open
          ? h('div', { className: 'vr-body' },
              !writable ? h('p', { className: 'vr-readOnly' }, '当前设置提供方只读。') : null,
              TOGGLE_KEYS.map((key) => toggleField(key)),
              textField('timeoutMs', '视觉请求超时（毫秒）', '单个视觉请求超时；默认 120000。', false),
              TEXT_KEYS.map((key) => textField(key, TEXT_LABELS[key], TEXT_HINTS[key], false)),
              textField('providers', '视觉模型链', '每行一个「provider/model」，从上到下失败回退；留空清除用户覆盖。', true),
              textField('textProvider', '文本模型', '文字轮会话的底层模型，格式「provider/model」。', false),
              h('div', { className: 'vr-footer' },
                failed ? h('p', { className: 'vr-failed' }, '保存失败：宿主拒绝了本次写入，请重试。') : null,
                h('button', {
                  type: 'button', className: 'vr-btn', disabled: !dirty || saving,
                  onClick: clearDrafts,
                }, '放弃修改'),
                h('button', {
                  type: 'button', className: 'vr-btn vr-btn-save', disabled: blocked,
                  onClick: save,
                }, saving ? '保存中…' : '保存'),
              ),
            )
          : null,
      )
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: 'vision-router' })
      ctx.effect(installStyles, 'vision-router: card styles')
      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugin.item', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.plugin.item',
                id: 'vision-router',
                order: 30,
                label: '视觉路由（自动识图）',
                inject: () => ({ scope }),
              },
              VisionRouterCard,
            )
          }),
        'vision-router: settings card',
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots']
    return module.exports
  },
})

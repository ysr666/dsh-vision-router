from pathlib import Path

path = Path('lib/client.js')
text = path.read_text(encoding='utf-8')

old_css = "      '.vr-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}' +\n"
new_css = (
    "      '.vr-savebar{position:sticky;top:0;z-index:20;margin:0 -8px;padding:8px;display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);border-bottom:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 18px #0002;backdrop-filter:blur(10px)}' +\n"
    "      '.vr-savebar .vr-pending{margin-right:auto}' +\n"
    "      '.vr-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}' +\n"
)
if text.count(old_css) != 1:
    raise SystemExit(f'expected one footer CSS anchor, got {text.count(old_css)}')
text = text.replace(old_css, new_css, 1)

old_render = """          ? h('div', { className: 'vr-body' },
              !writable ? h('p', { className: 'vr-readOnly' }, t('readOnly')) : null,
              h('div', { className: 'vr-quickstart' },
"""
new_render = """          ? h('div', { className: 'vr-body' },
              !writable ? h('p', { className: 'vr-readOnly' }, t('readOnly')) : null,
              dirty
                ? h('div', { className: 'vr-savebar', role: 'region', 'aria-label': t('pending') },
                    failed
                      ? h('p', { className: 'vr-failed', role: 'alert' },
                          t('saveFailed') + (failedFields.length > 0 ? `（${failedFields.join('、')}）` : ''))
                      : h('span', { className: 'vr-pending' }, t('pending')),
                    h('button', {
                      type: 'button', className: 'vr-btn', disabled: saving,
                      onClick: clearDrafts,
                    }, t('discard')),
                    h('button', {
                      type: 'button', className: 'vr-btn vr-btn-save', disabled: blocked,
                      onClick: save,
                    }, saving ? t('saving') : t('save')),
                  )
                : null,
              h('div', { className: 'vr-quickstart' },
"""
if text.count(old_render) != 1:
    raise SystemExit(f'expected one body render anchor, got {text.count(old_render)}')
text = text.replace(old_render, new_render, 1)

path.write_text(text, encoding='utf-8')

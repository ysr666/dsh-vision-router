from pathlib import Path

p = Path('lib/client.js')
s = p.read_text()

old_css = "      '.vr-catalog-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +\n"
new_css = old_css + \
    "      '.vr-update-manual{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-module-platform);padding:11px 12px;display:flex;flex-direction:column;gap:10px}' +\n" + \
    "      '.vr-update-manual-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary);line-height:1.5}' +\n" + \
    "      '.vr-update-command{display:flex;flex-direction:column;gap:5px;min-width:0}' +\n" + \
    "      '.vr-update-command-label{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);line-height:1.4}' +\n" + \
    "      '.vr-update-code{display:block;width:100%;box-sizing:border-box;overflow-x:auto;white-space:pre;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.55}' +\n" + \
    "      '.vr-update-note{margin:0;padding:7px 9px;border-left:2px solid var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-3);border-radius:0 7px 7px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.55}' +\n" + \
    "      '.vr-update-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:1px}' +\n"
assert s.count(old_css) == 1
s = s.replace(old_css, new_css, 1)

start = s.index("        const commandStyle = {")
end = s.index("        return h('div', { className: 'vr-field' },", start)
replacement = """        const commandBlock = (label, command) =>
          h('div', { className: 'vr-update-command' },
            h('div', { className: 'vr-update-command-label' }, label),
            h('code', { className: 'vr-update-code' }, command),
          )
        const manualHelp = showManualHelp
          ? h('div', { className: 'vr-update-manual' },
              h('div', { className: 'vr-update-manual-title' }, t('updateManualTitle')),
              auto && auto.reason === 'source-cli-needs-loader'
                ? commandBlock(t('updateManualSource'), pnpmCommand)
                : null,
              commandBlock(t('updateManualNpx'), npxCommand),
              h('p', { className: 'vr-update-note' }, t('updateManualAgeHint')),
              h('div', { className: 'vr-update-actions' },
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
"""
s = s[:start] + replacement + s[end:]
p.write_text(s)

t = Path('tests/client.test.js')
ts = t.read_text()
marker = "test('the settings card skips offscreen paint and rebuilds model options once', () => {\n"
assert ts.count(marker) == 1
test = """test('manual update help uses a dedicated vertical command card', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("className: 'vr-update-manual'"), true)
  assert.equal(source.includes("className: 'vr-update-command'"), true)
  assert.equal(source.includes("className: 'vr-update-code'"), true)
  assert.equal(source.includes("className: 'vr-update-note'"), true)
  assert.equal(source.includes("className: 'vr-update-actions'"), true)
  assert.equal(source.includes("const commandStyle = {"), false)
})

"""
ts = ts.replace(marker, test + marker, 1)
t.write_text(ts)

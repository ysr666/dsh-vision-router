const fs = require('fs')
const path = 'lib/client.js'
let s = fs.readFileSync(path, 'utf8')

const oldMain = `              stealthNotice(),
              h('div', { className: 'vr-group' },
                h('p', { className: 'vr-group-title' }, t('groupWrappers')),
                catalogReady
                  ? wrappersEditor()
                  : textField('wrappedProviders', t('textWrappedProviders'), t('textHintWrappedProviders'), true),
              ),
              h('p', { className: 'vr-hint' }, t('defaultChainNote')),
`
const newMain = `              stealthNotice(),
              h('p', { className: 'vr-hint' }, t('defaultChainNote')),
`
if (!s.includes(oldMain)) throw new Error('main manual-wrapper block not found')
s = s.replace(oldMain, newMain)

const anchor = `                    h('div', { className: 'vr-group' },
                      h('p', { className: 'vr-group-title' }, t('groupBehavior')),
                      ADVANCED_TOGGLE_KEYS.map((key) => toggleField(key)),
                    ),
`
const inserted = `${anchor}                    h('div', { className: 'vr-group' },
                      h('p', { className: 'vr-group-title' }, t('groupWrappers')),
                      catalogReady
                        ? wrappersEditor()
                        : textField('wrappedProviders', t('textWrappedProviders'), t('textHintWrappedProviders'), true),
                    ),
`
if (!s.includes(anchor)) throw new Error('advanced behavior anchor not found')
s = s.replace(anchor, inserted)

fs.writeFileSync(path, s)
console.log('moved manual wrapper editor into Advanced settings')

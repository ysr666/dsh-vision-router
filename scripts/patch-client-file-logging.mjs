import { readFileSync, writeFileSync } from 'node:fs'

const file = new URL('../lib/client.js', import.meta.url)
let source = readFileSync(file, 'utf8')

function replaceOnce(needle, replacement) {
  const first = source.indexOf(needle)
  if (first === -1) throw new Error(`anchor not found: ${needle.slice(0, 80)}`)
  if (source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`anchor is not unique: ${needle.slice(0, 80)}`)
  }
  source = source.slice(0, first) + replacement + source.slice(first + needle.length)
}

replaceOnce(
  "      testFailed: '连接失败',\n",
  "      testFailed: '连接失败',\n" +
    "      openLogFolder: '打开日志文件夹',\n" +
    "      openLogFolderFailed: '无法打开日志文件夹',\n",
)

replaceOnce(
  "      testFailed: 'Connection failed',\n",
  "      testFailed: 'Connection failed',\n" +
    "      openLogFolder: 'Open logs folder',\n" +
    "      openLogFolderFailed: 'Could not open logs folder',\n",
)

const testButton = `                h('button', {
                  type: 'button', className: 'vr-btn', disabled: testState.status === 'running',
                  onClick: runTestConnection,
                }, t('testConnection')),
`

const logButton = `                h('button', {
                  type: 'button', className: 'vr-btn',
                  onClick: async () => {
                    try {
                      const response = await fetch('/_dsh/vision-router/logs', {
                        method: 'POST',
                        cache: 'no-store',
                      })
                      const result = await response.json().catch(() => undefined)
                      if (!response.ok || !result || result.ok !== true) {
                        throw new Error(result && result.error ? result.error : \`HTTP \${response.status}\`)
                      }
                    } catch (error) {
                      if (typeof window.alert === 'function') {
                        window.alert(
                          t('openLogFolderFailed') + '：' +
                            (error && error.message ? error.message : String(error)),
                        )
                      }
                    }
                  },
                }, t('openLogFolder')),
${testButton}`

replaceOnce(testButton, logButton)
writeFileSync(file, source)

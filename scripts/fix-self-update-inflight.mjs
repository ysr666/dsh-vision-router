import { readFileSync, writeFileSync } from 'node:fs'

const path = 'index.js'
let text = readFileSync(path, 'utf8')
const from = `                selfUpdateInFlight = pending
                void pending.finally(() => {
                  if (selfUpdateInFlight === pending) selfUpdateInFlight = undefined
                })
`
const to = `                selfUpdateInFlight = pending
                void pending.then(
                  () => {
                    if (selfUpdateInFlight === pending) selfUpdateInFlight = undefined
                  },
                  () => {
                    if (selfUpdateInFlight === pending) selfUpdateInFlight = undefined
                  },
                )
`
const first = text.indexOf(from)
if (first === -1) throw new Error('self-update inFlight cleanup anchor missing')
if (text.indexOf(from, first + from.length) !== -1) throw new Error('self-update inFlight cleanup anchor duplicated')
text = text.slice(0, first) + to + text.slice(first + from.length)
writeFileSync(path, text)

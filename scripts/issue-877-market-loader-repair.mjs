// Diagnostic-only patch against dshmarket v1.80.1, immutable ed2acb5c.
// Never writes a repository ref or publishes a package. Run on a disposable checkout.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(process.argv[2])
function edit(path, replacements) {
  const file = join(root, path)
  let source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw Error('Unexpected upstream source anchor: ' + path + ' ' + before.slice(0, 80))
    source = source.replace(before, after)
  }
  writeFileSync(file, source)
}
// Test-only registry override. Keep official manager's valid registry spec.
edit('src/official-desktop.ts', [
  [
    '      const registry = routesFor(activeRegion()).npmRegistry',
    '      const registry = target === \'dsh-vision-router@3.4.0\' && process.env.DVR_CANDIDATE_REGISTRY ? process.env.DVR_CANDIDATE_REGISTRY : routesFor(activeRegion()).npmRegistry',
  ],
])
console.log('Applied ONLY disposable isolated registry override; market production loader untouched')

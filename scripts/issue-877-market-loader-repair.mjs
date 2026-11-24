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
edit('src/routes.ts', [
  ['export interface MarketConfig {', 'export interface MarketConfig {\n  /** Fresh read-only inventory after a Host-owned Desktop update may retire the request owner. */\n  readPostUpdateLoaderEntries?: () => Iterable<LoaderEntry>'],
  [
    '  function liveNames(): Set<string> {\n    const live = new Set(listLiveHotMounts())\n    for (const entry of host.loader.entries()) {',
    '  function liveNames(postUpdate = false): Set<string> {\n    const live = new Set(listLiveHotMounts())\n    const entries = postUpdate && config.readPostUpdateLoaderEntries !== undefined\n      ? config.readPostUpdateLoaderEntries() : host.loader.entries()\n    for (const entry of entries) {',
  ],
  [
    '              activation = {\n                [name]: activationAfterReplace(\n                  verifyActivation(config.profile, name, liveNames(), activeProfileDir, disabled.has(name)),',
    '              activation = {\n                [name]: activationAfterReplace(\n                  verifyActivation(config.profile, name, liveNames(true), activeProfileDir, disabled.has(name)),',
  ],
])
edit('src/index.ts', [
  [
    '        const resolved: MarketConfig = {\n          profile: profileName,',
    '        const loaderRoot = hostCtx.root\n        const resolved: MarketConfig = {\n          readPostUpdateLoaderEntries: () => {\n            const loader = loaderRoot.get(\'loader\') as MarketHost[\'loader\'] | undefined\n            if (loader === undefined) throw new Error(\'Host loader unavailable after update\')\n            return [...loader.entries()]\n          },\n          profile: profileName,',
  ],
])
console.log('Applied narrow post-update Loader inventory repair to disposable market checkout')

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'tests', 'profile-pnpm-diagnostics.test.js')
let source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

function replaceExactly(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`doctor-v2 CI fixture: ${label} anchor missing`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`doctor-v2 CI fixture: ${label} anchor is ambiguous`)
  }
  source = source.slice(0, first) + after + source.slice(first + before.length)
}

replaceExactly(
  [
    "function dshHomeFixture({ dependencies = {}, installed = {} } = {}) {",
    "  const dshHome = mkdtempSync(path.join(tmpdir(), 'vision-profile-home-'))",
    "  const profileDir = path.join(dshHome, 'profiles', 'web')",
    "  mkdirSync(profileDir, { recursive: true })",
    "  writeFileSync(",
    "    path.join(profileDir, 'package.json'),",
    "    JSON.stringify({ dependencies }, null, 2),",
    "  )",
  ].join('\n'),
  [
    "function dshHomeFixture({ dependencies = {}, installed = {} } = {}) {",
    "  const dshHome = mkdtempSync(path.join(tmpdir(), 'vision-profile-home-'))",
    "  const profileDir = path.join(dshHome, 'profiles', 'web')",
    "  mkdirSync(profileDir, { recursive: true })",
    "  const hasVisionRouter = typeof dependencies['dsh-vision-router'] === 'string'",
    "  writeFileSync(",
    "    path.join(profileDir, 'package.json'),",
    "    JSON.stringify({",
    "      dependencies,",
    "      ...(hasVisionRouter ? { dsh: { profile: { bundles: ['dsh-vision-router'] } } } : {}),",
    "    }, null, 2),",
    "  )",
  ].join('\n'),
  'dshHomeFixture manifest',
)

replaceExactly(
  "  return { dshHome, profileDir }\n}",
  [
    "  if (hasVisionRouter) {",
    "    const declared = dependencies['dsh-vision-router']",
    "    const version = /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(declared) ? declared : '1.7.4'",
    "    const pluginDir = path.join(profileDir, 'node_modules', 'dsh-vision-router')",
    "    mkdirSync(pluginDir, { recursive: true })",
    "    writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({",
    "      name: 'dsh-vision-router',",
    "      version,",
    "      main: 'entry.js',",
    "      dsh: { bundle: { patch: './cordis.patch.yml' } },",
    "    }))",
    "    writeFileSync(path.join(pluginDir, 'entry.js'), 'export default {}\\n')",
    "    writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), '- insert: []\\n')",
    "  }",
    "  return { dshHome, profileDir }",
    "}",
  ].join('\n'),
  'dshHomeFixture materialized install',
)

writeFileSync(file, source)

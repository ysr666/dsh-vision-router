import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptsDir = path.join(root, 'scripts')
const bundleParts = (await import('node:fs')).readdirSync(scriptsDir)
  .filter((name) => /^doctor-v2-ci-gz\.part\d+$/.test(name))
  .sort()
if (bundleParts.length === 0) throw new Error('doctor-v2 CI patch: bundle parts missing')
const bundleBase64 = bundleParts.map((name) => readFileSync(path.join(scriptsDir, name), 'utf8').trim()).join('')
const bundle = JSON.parse(gunzipSync(Buffer.from(bundleBase64, 'base64')).toString('utf8'))

function writeBundledFiles() {
  for (const [relative, encoded] of Object.entries(bundle)) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(encoded, 'base64'))
  }
}

function replaceExactly(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`doctor-v2 CI patch: ${label} anchor missing`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`doctor-v2 CI patch: ${label} anchor is ambiguous`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function patchIndex() {
  const file = path.join(root, 'index.js')
  let source = readFileSync(file, 'utf8')

  source = replaceExactly(
    source,
    "import { detectDshSelfUpdatePlan, runDshPluginUpdate } from './lib/self-update.js'",
    [
      "import {",
      "  detectDshSelfUpdatePlan,",
      "  inferProfileFromPluginPath,",
      "  runDshPluginUpdate,",
      "} from './lib/self-update.js'",
      "import { isLocalUiRequest } from './lib/web-capability-boundary.js'",
      "import {",
      "  runtimeProfileIdentityHeaders,",
      "  verifiedRuntimeProfileIdentity,",
      "} from './lib/runtime-profile-identity.js'",
    ].join('\n'),
    'self-update imports',
  )

  source = replaceExactly(
    source,
    "  const selfUpdatePlan = detectDshSelfUpdatePlan()\n  let selfUpdateToken = randomBytes(24).toString('base64url')",
    [
      "  const selfUpdatePlan = detectDshSelfUpdatePlan()",
      "  const runtimeProfileIdentity = verifiedRuntimeProfileIdentity({",
      "    selfUpdatePlan,",
      "    inferredProfile: inferProfileFromPluginPath(),",
      "  })",
      "  let selfUpdateToken = randomBytes(24).toString('base64url')",
    ].join('\n'),
    'runtime profile identity initialization',
  )

  const oldGuard = [
    "          path: '/_dsh/vision-router/self-update',",
    "          handler: async (req, res) => {",
    "            if (req.method !== 'POST') {",
    "              res.setHeader('Allow', 'POST')",
    "              res.writeHead(405)",
    "              res.end()",
    "              return",
    "            }",
  ].join('\n')
  const newGuard = [
    "          path: '/_dsh/vision-router/self-update',",
    "          handler: async (req, res) => {",
    "            if (req.method !== 'POST') {",
    "              res.setHeader('Allow', 'POST')",
    "              for (const [name, value] of Object.entries(runtimeProfileIdentityHeaders(",
    "                runtimeProfileIdentity,",
    "                { localUi: isLocalUiRequest(req) },",
    "              ))) {",
    "                res.setHeader(name, value)",
    "              }",
    "              res.writeHead(405)",
    "              res.end()",
    "              return",
    "            }",
  ].join('\n')
  source = replaceExactly(source, oldGuard, newGuard, 'self-update rejected-method guard')
  writeFileSync(file, source)
}

function patchExistingDoctorTests() {
  const file = path.join(root, 'tests', 'doctor.test.js')
  let source = readFileSync(file, 'utf8')
  const before = "  if (workspace !== undefined) writeFileSync(workspacePath, workspace)\n  return { home, dir, manifestPath, workspacePath }"
  const after = [
    "  if (workspace !== undefined) writeFileSync(workspacePath, workspace)",
    "  const installProbe = Buffer.isBuffer(manifestText) ? manifestText.toString('utf8') : String(manifestText)",
    "  if (installProbe.includes('dsh-vision-router')) {",
    "    const pluginDir = path.join(dir, 'node_modules', 'dsh-vision-router')",
    "    mkdirSync(pluginDir, { recursive: true })",
    "    writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({",
    "      name: 'dsh-vision-router',",
    "      version: '1.7.4',",
    "      main: 'entry.js',",
    "      dsh: { bundle: { patch: './cordis.patch.yml' } },",
    "    }))",
    "    writeFileSync(path.join(pluginDir, 'entry.js'), 'export default {}\\n')",
    "    writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), '- insert: []\\n')",
    "  }",
    "  return { home, dir, manifestPath, workspacePath }",
  ].join('\n')
  source = replaceExactly(source, before, after, 'doctor.test healthy-install fixture')
  writeFileSync(file, source)

  const cliFile = path.join(root, 'tests', 'doctor-cli.test.js')
  let cli = readFileSync(cliFile, 'utf8')
  cli = replaceExactly(
    cli,
    "  writeFileSync(path.join(profileDir, 'package.json'), '{}\\n')",
    [
      "  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({",
      "    dependencies: { 'dsh-vision-router': '^1.7.4' },",
      "    dsh: { profile: { bundles: ['dsh-vision-router'] } },",
      "  }) + '\\n')",
      "  const pluginDir = path.join(profileDir, 'node_modules', 'dsh-vision-router')",
      "  mkdirSync(pluginDir, { recursive: true })",
      "  writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({",
      "    name: 'dsh-vision-router', version: '1.7.4', main: 'entry.js',",
      "    dsh: { bundle: { patch: './cordis.patch.yml' } },",
      "  }))",
      "  writeFileSync(path.join(pluginDir, 'entry.js'), 'export default {}\\n')",
      "  writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), '- insert: []\\n')",
    ].join('\n'),
    'doctor-cli symlink healthy-install fixture',
  )
  writeFileSync(cliFile, cli)
}

function patchPackageForActualSuite() {
  const file = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (pkg.name !== 'dsh-vision-router' || pkg.version !== '1.7.4') {
    throw new Error(`doctor-v2 CI patch: unexpected package baseline ${pkg.name}@${pkg.version}`)
  }
  const targeted = [
    'tests/doctor-v2-targeted.test.js',
    'tests/doctor-cli-v2-targeted.test.js',
    'tests/doctor-runtime-targeted.test.js',
    'tests/runtime-profile-identity-targeted.test.js',
    'tests/session-repair-v2-targeted.test.js',
    'tests/doctor-index-runtime-identity-targeted.test.js',
  ]
  const current = String(pkg.scripts?.test ?? '')
  for (const testFile of targeted) {
    if (!current.includes(testFile) && !pkg.scripts.test.includes(testFile)) pkg.scripts.test += ` ${testFile}`
  }
  delete pkg.scripts.prepare
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}

writeBundledFiles()
patchIndex()
patchExistingDoctorTests()
patchPackageForActualSuite()
console.log('doctor-v2 CI candidate applied to checkout (test branch only)')

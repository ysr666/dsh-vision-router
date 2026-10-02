import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const TSC = require.resolve('typescript/bin/tsc')
const tarball = process.argv[2]

if (!tarball) throw new TypeError('usage: verify-packed-public-api.mjs <package.tgz>')

const archive = path.resolve(tarball)
await access(archive)

const expectedNames = [
  'Config',
  'SETTINGS_CONTRACT_REVISION',
  'apply',
  'ensureVisionAttachmentAdmissionPolicy',
  'hasBatchAttachmentContract',
  'hostOwnsOfficialDeepSeekProvider',
  'inject',
  'installHostSettingsCompatibility',
  'installVisionAttachmentAdmissionPolicy',
  'name',
  'protectHostProviderOwnership',
  'sessionSurfaceReplacementIntent',
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${String(result.status)}`)
  }
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dvr-packed-api-'))
try {
  run('tar', ['-xzf', archive, '-C', temporary])

  const packageRoot = path.join(temporary, 'package')
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))

  if (manifest.main !== 'lib/public-entry.js') {
    throw new Error(`packed main drifted: ${String(manifest.main)}`)
  }
  if (manifest.types !== 'lib/public-entry.d.ts') {
    throw new Error(`packed types drifted: ${String(manifest.types)}`)
  }
  const rootExport = manifest.exports?.['.']
  if (
    rootExport?.types !== './lib/public-entry.d.ts'
    || rootExport?.default !== './lib/public-entry.js'
  ) {
    throw new Error('packed package root exports do not match the R7 public contract')
  }
  if (manifest.exports?.['./client'] !== './lib/client.js') {
    throw new Error('packed ./client loader contract drifted')
  }

  await Promise.all([
    access(path.join(packageRoot, 'lib', 'public-entry.js')),
    access(path.join(packageRoot, 'lib', 'public-entry.d.ts')),
    access(path.join(packageRoot, 'lib', 'client.js')),
    access(path.join(packageRoot, 'entry.js')),
    access(path.join(packageRoot, 'index.js')),
  ])

  try {
    await access(path.join(packageRoot, 'src'))
    throw new Error('canonical src/ must not be shipped in the npm package')
  } catch (error) {
    if (error?.message === 'canonical src/ must not be shipped in the npm package') throw error
  }

  await symlink(path.join(ROOT, 'node_modules'), path.join(packageRoot, 'node_modules'), 'junction')

  const runtime = await import(pathToFileURL(path.join(packageRoot, 'lib', 'public-entry.js')).href)
  const runtimeNames = Object.keys(runtime).sort()
  if (JSON.stringify(runtimeNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `packed runtime exports drifted:\nexpected=${JSON.stringify(expectedNames)}\nactual=${JSON.stringify(runtimeNames)}`,
    )
  }

  // Declaration-versus-runtime execution check. The consumer program below only
  // type-checks the sample, so behaviour that types cannot express (a required
  // Cordis fiber, a parameter domain narrower than `number`) must be asserted
  // here or it ships unverified.
  const isCordisLifecycleContext = (value) => {
    try {
      return typeof value?.effect === 'function'
    } catch {
      return false
    }
  }
  const contextWithoutEffect = new Proxy({}, {
    get(target, property) {
      if (property === 'effect') return undefined
      if (property === 'inject') return () => {}
      if (property === 'on') return () => () => {}
      if (property === 'get') return () => undefined
      return Reflect.get(target, property)
    },
  })
  if (isCordisLifecycleContext(contextWithoutEffect)) {
    throw new Error('packed public API probe is not a lifecycle-less context')
  }
  try {
    runtime.apply(contextWithoutEffect, {})
    throw new Error('packed apply() accepted a context without Cordis effect(); the declared lifecycle precondition is not enforced')
  } catch (error) {
    if (!/Cordis lifecycle context/.test(String(error?.message))) throw error
  }
  if (typeof runtime.sessionSurfaceReplacementIntent !== 'function') {
    throw new Error('packed sessionSurfaceReplacementIntent missing')
  }
  try {
    runtime.sessionSurfaceReplacementIntent({ header: { version: 4 } }, -1)
    throw new Error('packed sessionSurfaceReplacementIntent accepted a negative seq')
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
  }
  const emptyIntent = runtime.sessionSurfaceReplacementIntent({ header: { version: 4 } }, 0)
  if (emptyIntent !== undefined) {
    throw new Error(`packed sessionSurfaceReplacementIntent({header:{version:4}}, 0) drifted: ${JSON.stringify(emptyIntent)}`)
  }
  if (runtime.apply.length !== 1 || runtime.sessionSurfaceReplacementIntent.length !== 2) {
    throw new Error('packed public function arity drifted from the published declaration')
  }

  const consumer = path.join(temporary, 'consumer')
  await mkdir(path.join(consumer, 'node_modules'), { recursive: true })
  await symlink(packageRoot, path.join(consumer, 'node_modules', 'dsh-vision-router'), 'junction')

  await writeFile(
    path.join(consumer, 'consumer.ts'),
    `import * as dvr from 'dsh-vision-router'
import {
  Config,
  SETTINGS_CONTRACT_REVISION,
  apply,
  ensureVisionAttachmentAdmissionPolicy,
  hasBatchAttachmentContract,
  hostOwnsOfficialDeepSeekProvider,
  inject,
  installHostSettingsCompatibility,
  installVisionAttachmentAdmissionPolicy,
  name,
  protectHostProviderOwnership,
  sessionSurfaceReplacementIntent,
  type SessionSurfaceReplacementIntent,
} from 'dsh-vision-router'

const exactName: 'vision-router' = name
const exactRevision: 7 = SETTINGS_CONTRACT_REVISION
const exactInject: readonly ['tools', 'llm'] = inject
const config: Record<string, unknown> = Config({})
const batch: boolean = hasBatchAttachmentContract({})
const owned: boolean = hostOwnsOfficialDeepSeekProvider({})
const admission = ensureVisionAttachmentAdmissionPolicy({})
const installedAdmission = installVisionAttachmentAdmissionPolicy({})
const protectedCtx = protectHostProviderOwnership({ llm: {} })
const settingsCtx = installHostSettingsCompatibility(
  { inject: () => {} },
  {},
  { Config, namespace: 'vision-router' },
)
const intent: SessionSurfaceReplacementIntent | undefined =
  sessionSurfaceReplacementIntent({ header: { version: 4 } }, 1)
// The plugin root requires a Cordis lifecycle context; a plain object is
// rejected at runtime, so the sample must carry the declared precondition.
const applied: unknown = apply({ effect: () => () => {} }, config)

void exactName
void exactRevision
void exactInject
void batch
void owned
void admission
void installedAdmission
void protectedCtx
void settingsCtx
void intent
void applied

// @ts-expect-error a lifecycle-less context is not a CordisLifecycleContext
apply({}, config)
// @ts-expect-error package root owns provider transport; runtime injection is internal
apply({ effect: () => () => {} }, config, { providerTransport: {} })
// @ts-expect-error settings compatibility requires an explicit namespace and Config
installHostSettingsCompatibility({ inject: () => {} }, {}, {})
// @ts-expect-error settings compatibility requires a context that can inject
installHostSettingsCompatibility({}, {}, { Config, namespace: 'vision-router' })
// @ts-expect-error Session surface replacement requires an explicit sequence
sessionSurfaceReplacementIntent({ header: { version: 4 } })
// @ts-expect-error mature Core helpers are not package-root API
void dvr.createCache
`,
  )

  await writeFile(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['consumer.ts'],
    }, null, 2) + '\n',
  )

  run(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: consumer })

  console.log(
    `packed public API smoke passed (${runtimeNames.length} runtime exports; NodeNext declarations resolved)`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}

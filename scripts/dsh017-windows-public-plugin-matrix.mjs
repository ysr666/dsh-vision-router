import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dshRoot = resolve(process.env.DSH_SOURCE_ROOT || process.cwd())
const dshHome = mkdtempSync(join(tmpdir(), 'dvr551-rc2-windows-'))
const profile = 'dvr551-matrix'
const profileDir = join(dshHome, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const reportPath = resolve(process.env.DVR551_REPORT_PATH || join(dshHome, 'matrix-report.json'))
const pnpm = 'pnpm'

const PUBLIC = [
  '@michengai/dsh-archive-manager',
  'dsh-leekbox',
  'dshmarket',
  '@vectorize-io/hindsight-coding-agents',
  'dsh-free-search',
  '@linxin666/dsh-client-ui-skill-explorer',
  'dsh-im',
  'dsh-mobile',
  'billion-context',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
]
const INSTALL = [
  'dsh-vision-router@2.2.5',
  '@michengai/dsh-archive-manager@1.0.6',
  'dsh-leekbox@0.8.6',
  'dshmarket@1.66.2',
  '@vectorize-io/hindsight-coding-agents@0.7.0',
  'dsh-free-search@0.4.39',
  '@linxin666/dsh-client-ui-skill-explorer@0.4.3',
  'dsh-im@1.0.5',
  'dsh-mobile@0.5.0',
  'billion-context@0.1.163',
  '@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-alpha.2',
]
const results = []

function command(args, options = {}) {
  const child = spawnSync(pnpm, args, {
    cwd: dshRoot,
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    // Node 24 on Windows rejects direct spawnSync() of .cmd shims with EINVAL.
    // Let cmd.exe resolve the pnpm shim; Unix keeps direct exec semantics.
    shell: process.platform === 'win32',
    timeout: options.timeout ?? 120_000,
  })
  if (child.error || child.status !== 0) {
    throw new Error(`command failed: ${pnpm} ${args.join(' ')}\n${child.error?.stack || ''}\n${child.stdout || ''}\n${child.stderr || ''}`)
  }
  return child
}

command(['dsh', '--profile', profile, '--from-default-profile', 'web', '--dump-config'], { capture: true })
command(['dsh', 'plugin', '--profile', profile, 'add', ...INSTALL], { timeout: 180_000 })

const runnerPath = join(dshRoot, '.tmp-dvr551-run-profile.mts')
writeFileSync(runnerPath, `
import { runProfile } from './apps/cli/src/profile-boot.ts'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
const timeoutMs = Number(process.argv[2] || '15000')
const started = Date.now()
const timer = new Promise<any>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs))
const application = runProfile({
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env as Record<string, string> }]),
  profile: '${profile}', patchFiles: [], args: ['--port', '0', '--no-open'],
}).then(value => ({ kind: 'settled', value })).catch(error => ({ kind: 'error', error }))
const result = await Promise.race([application, timer])
if (result.kind === 'timeout') {
  console.log(JSON.stringify({ result: 'TIMEOUT', elapsedMs: Date.now() - started }))
  process.exit(124)
}
if (result.kind === 'error') {
  console.log(JSON.stringify({ result: 'ERROR', elapsedMs: Date.now() - started, message: String(result.error?.stack || result.error) }))
  process.exit(2)
}
console.log(JSON.stringify({ result: 'SETTLED', elapsedMs: Date.now() - started, fiberState: result.value.ctx.fiber.state }))
process.exit(0)
`)

function selectBundles(extra) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...extra]
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function runCase(label, extra, timeoutMs = 15_000) {
  selectBundles(extra)
  const child = spawnSync(process.execPath, ['--import', 'tsx/esm', runnerPath, String(timeoutMs)], {
    cwd: dshRoot,
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
  })
  const line = String(child.stdout || '').split(/\r?\n/).find(value => value.startsWith('{"result"'))
  let payload
  try { payload = line ? JSON.parse(line) : undefined } catch {}
  let result = payload?.result
  if (!result && child.error?.code === 'ETIMEDOUT') result = 'TIMEOUT'
  if (!result) result = child.status === 0 ? 'SETTLED_WITHOUT_MARKER' : 'ERROR'
  const record = {
    label, bundles: extra, result, elapsedMs: payload?.elapsedMs,
    exitCode: child.status, signal: child.signal, spawnError: child.error?.message,
    stdoutTail: String(child.stdout || '').slice(-4000), stderrTail: String(child.stderr || '').slice(-6000),
  }
  results.push(record)
  console.log(`DVR551_MATRIX ${label}: ${result}${payload?.elapsedMs ? ` ${payload.elapsedMs}ms` : ''}`)
  if (record.stderrTail) console.log(`DVR551_STDERR_TAIL ${label}:\n${record.stderrTail}`)
  return record
}

let minimal = undefined
let fatal = undefined
try {
  runCase('stock-web', [], 12_000)
  runCase('dvr-only', ['dsh-vision-router'], 15_000)
  runCase('public-ten-without-dvr', PUBLIC, 15_000)
  const full = runCase('dvr-plus-public-ten', ['dsh-vision-router', ...PUBLIC], 20_000)

  if (full.result === 'TIMEOUT') {
    let current = [...PUBLIC]
    let changed = true
    while (changed && current.length > 1) {
      changed = false
      for (const candidate of [...current]) {
        const reduced = current.filter(value => value !== candidate)
        const probe = runCase(`reduce-without:${candidate}`, ['dsh-vision-router', ...reduced], 15_000)
        if (probe.result === 'TIMEOUT') {
          current = reduced
          changed = true
          break
        }
      }
    }
    minimal = current
    runCase('minimal-with-dvr', ['dsh-vision-router', ...minimal], 20_000)
    runCase('minimal-without-dvr', minimal, 15_000)
  }
} catch (error) {
  fatal = String(error?.stack || error)
  console.error(fatal)
} finally {
  try { rmSync(runnerPath, { force: true }) } catch {}
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    node: process.version,
    dshCommit: process.env.DSH_EXPECTED_COMMIT,
    dvrVersion: '2.2.5',
    install: INSTALL,
    minimal,
    fatal,
    results,
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`DVR551_REPORT ${reportPath}`)
  console.log(`DVR551_SUMMARY ${JSON.stringify({ minimal, fatal, results: results.map(({ label, result, elapsedMs }) => ({ label, result, elapsedMs })) })}`)
}

if (fatal) process.exit(2)

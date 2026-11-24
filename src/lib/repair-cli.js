#!/usr/bin/env node
// The public binary is deliberately recovery-only. Doctor is retired.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { doctorProfiles, resolveDshHome } from './doctor.js'
import { inspectPlatform } from './doctor-runtime.js'
import { repairLegacySessionLogs, inspectDshDowngradeSafety } from './legacy-session-repair.js'

const USAGE = `dsh-vision-router repair [--profile <name>] [--check]
dsh-vision-router repair-sessions [--check]
dsh-vision-router upgrade-preflight [--profile <name>] [--json]
dsh-vision-router downgrade-preflight <legacy-only|stable-v1|stable-v2> [--json]

Stop DSH before repairing Sessions. --check and both preflights are read-only.
The legacy doctor command is retired. No runtime/network probe is performed.
`

function parseArgs(argv) {
  const [command, ...args] = argv
  if (command === 'doctor') throw new Error('doctor has been retired; see --help for explicit recovery and preflight commands')
  if (command === '--help' || command === '-h') {
    if (args.length) throw new Error('unexpected arguments after help')
    return { help: true }
  }
  if (!['repair', 'repair-sessions', 'upgrade-preflight', 'downgrade-preflight'].includes(command)) {
    throw new Error('choose an explicit recovery or preflight command')
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true }
  let profile, target, check = false, json = false
  if (command === 'downgrade-preflight') {
    target = args.shift()
    if (!['legacy-only', 'stable-v1', 'stable-v2'].includes(target)) {
      throw new Error('downgrade-preflight requires an explicit target capability: legacy-only, stable-v1 or stable-v2')
    }
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if ((arg === '--profile' || arg.startsWith('--profile=')) &&
        ['repair', 'upgrade-preflight'].includes(command) && profile === undefined) {
      profile = arg === '--profile' ? args[++i] : arg.slice('--profile='.length)
      if (!profile || !/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..' || profile.startsWith('-')) {
        throw new Error('invalid profile name')
      }
    } else if (arg === '--check' && ['repair', 'repair-sessions'].includes(command) && !check) {
      check = true
    } else if (arg === '--json' && ['upgrade-preflight', 'downgrade-preflight'].includes(command) && !json) {
      json = true
    } else {
      // Do not echo arbitrary argument values: they may contain credentials.
      throw new Error('unsupported or duplicate argument for the selected command')
    }
  }
  return { command, profile, target, check, json }
}

function visionPluginLabel(plugin) {
  if (plugin.installedVersion) return `${plugin.name}@${plugin.installedVersion}`
  if (plugin.spec) return `${plugin.name}@${plugin.spec}`
  return plugin.name
}

function statusLine(profile) {
  if (!profile.installation?.applicable) return `– ${profile.name} — Vision Router not installed in this profile`
  const healthy = profile.exists
    && profile.validJson
    && (!profile.hasBom || profile.repaired)
    && profile.installation?.ok !== false
    && (!profile.workspace || profile.workspace.pinned.length === 0 || profile.workspace.rewritten)
  const parts = [`${healthy ? '✓' : '✗'} ${profile.name}`]
  if (!profile.exists) return `${parts[0]} — package.json not found`
  if (profile.hasBom) parts.push(profile.repaired ? 'UTF-8 BOM removed' : 'UTF-8 BOM detected')
  parts.push(profile.validJson ? 'JSON valid' : `JSON invalid: ${profile.jsonError}`)
  if (profile.validJson) {
    const mode = profile.installation?.mode ?? 'unknown'
    const version = profile.installedPlugin?.version ? `@${profile.installedPlugin.version}` : ''
    parts.push(`install ${mode}${version}`)
    if (profile.coexistingVisionPlugins?.length > 0) {
      parts.push(`other vision plugin(s): ${profile.coexistingVisionPlugins.slice(0, 4).map(visionPluginLabel).join(', ')}`)
    }
  }
  const workspace = profile.workspace
  if (workspace?.exists && workspace.pinned.length > 0) {
    const listed = workspace.pinned.slice(0, 3).join(', ')
    parts.push(workspace.rewritten
      ? `release-age exemption repaired (${listed})`
      : `release-age exemption version-pinned (${listed})`)
  }
  return parts.join(' — ')
}

function printProfileDetails(profile, io) {
  io.log(statusLine(profile))
  for (const error of profile.installation?.errors ?? []) io.error(`  ✗ ${error}`)
  for (const warning of profile.installation?.warnings ?? []) io.log(`  ! ${warning}`)
}

/** Source refs are classified without dereferencing credentials or Git.
 * A lockfile contains a resolved commit today, but lockfile regeneration can
 * still follow the mutable manifest source.
 */
export function isFloatingDvrGitSource(spec) {
  if (typeof spec !== 'string') return false
  const source = spec.trim()
  if (!/^(?:github:|git\+|git@|https?:\/\/(?:www\.)?github\.com\/)/i.test(source)) return false
  const anchor = source.indexOf('#')
  if (anchor < 0 || anchor === source.length - 1) return true
  const ref = source.slice(anchor + 1)
  if (/^[0-9a-f]{40}$/i.test(ref)) return false
  if (/^v?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i.test(ref)) return false
  // Branch names, semver ranges, HEAD and unconventional tags need
  // review before the 3.2 Host floor becomes user-facing.
  return true
}

/** Read-only, intentionally narrow upgrade fence. This reports only known
 * profile-owned composition blockers. It does not establish the running
 * Desktop Host version or prove image/transport/session functionality.
 * Counts only: no user paths, hostnames, credentials or patch bodies.
 */
export function assessUpgradeProfileRisk(profileReport, platform) {
  const applicable = (profileReport?.profiles ?? []).filter((item) => item.installation?.applicable)
  const count = (predicate) => applicable.filter(predicate).length
  const blockers = []
  const add = (code, n) => { if (n > 0) blockers.push({ code, affectedProfiles: n }) }
  add('PROFILE_CONNECTION_OVERRIDE', count((p) => (p.patch?.connectionOverrideRows ?? 0) > 0))
  add('RETIRED_READY_BRIDGE_REFERENCE', count((p) =>
    (p.patch?.retiredReadyBridgeRows ?? 0) + (p.patch?.retiredReadyInjectionRows ?? 0) > 0))
  add('STALE_WORKSPACE_RELEASE_AGE_PIN', count((p) =>
    (p.workspace?.pinned?.length ?? 0) > 0 && p.workspace?.rewritten !== true))
  add('FLOATING_GITHUB_DVR_SOURCE', count((p) => isFloatingDvrGitSource(p.pluginDependency)))
  if (platform?.nodeSupported === false) add('NODE_BELOW_3_2_MINIMUM', 1)
  return Object.freeze({
    scope: 'known-profile-risks-only',
    profileCount: applicable.length,
    pass: Boolean(profileReport?.ok) && blockers.length === 0,
    blockers,
    actualDesktopHostVersionVerified: false,
    runtimeAndHistoricalDataVerified: false,
    fullReleaseApproval: false,
  })
}

function runSessionRepair(dshHome, io) {
  let report
  try {
    report = repairLegacySessionLogs({ dshHome, fix: true })
  } catch (error) {
    io.error(`dsh-vision-router: session repair failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  io.log(`DSH home: ${dshHome}`)
  io.log(`Session root: ${report.sessionsRoot}`)
  if (!report.exists) {
    io.log('✓ No DSH session store found; nothing to repair.')
    return 0
  }
  for (const item of report.reports) {
    const kinds = [...new Set((item.repairs ?? []).map((repair) => repair.kind))].join(', ')
    io.log(`✓ Repaired session ${item.sessionId} (${item.encoding}) at event seq ${item.affectedSeqs.join(', ')}${kinds ? ` [${kinds}]` : ''}; backup: ${item.backupPath}`)
  }
  for (const failure of report.errors) io.error(`✗ ${failure.path} — ${failure.error}`)
  if (report.repaired === 0 && report.errors.length === 0) {
    io.log(`✓ Scanned ${report.scanned} session log(s); no known Vision Router session corruption found.`)
  } else if (report.repaired > 0) {
    io.log(`Repaired ${report.repaired} session log(s). Restart DSH and reopen the affected conversation.`)
  }
  if (report.errors.length > 0) io.error('Some logs were not changed. Keep DSH stopped, resolve the errors above, and run the command again.')
  return report.ok ? 0 : 1
}


export async function run(argv = process.argv.slice(2), io = console, env = process.env) {
  let options
  try { options = parseArgs(argv) }
  catch (error) {
    io.error('dsh-vision-router: ' + error.message)
    io.error(USAGE.trimEnd())
    return 2
  }
  if (options.help) { io.log(USAGE.trimEnd()); return 0 }
  const dshHome = resolveDshHome(env)
  try {
    if (options.command === 'downgrade-preflight') {
      const report = inspectDshDowngradeSafety({ dshHome, target: options.target })
      const ok = report.decision === 'allow'
      if (options.json) io.log(JSON.stringify({ ok, downgradePreflight: report }, null, 2))
      else {
        const output = ok ? io.log.bind(io) : io.error.bind(io)
        output('Downgrade preflight: ' + report.decision.toUpperCase() + ' for ' + report.target +
          '; scanned ' + report.scanned + ', incompatible ' + report.blocked +
          ', unknown ' + report.unknown + ', unreadable ' + report.unreadable)
        io.log('Read-only voluntary preflight; an older binary cannot enforce it.')
      }
      return ok ? 0 : 1
    }
    if (options.command === 'repair-sessions') {
      if (!options.check) return runSessionRepair(dshHome, io)
      const report = repairLegacySessionLogs({ dshHome, fix: false })
      io.log('Sessions: scanned ' + report.scanned + '; affected ' + report.affected + '; live/incomplete tail advisories ' + report.advisories.length)
      if (report.errors.length) io.error('Session logs could not be inspected safely: ' + report.errors.length)
      return report.affected === 0 && report.errors.length === 0 ? 0 : 1
    }
    const isUpgrade = options.command === 'upgrade-preflight'
    const report = doctorProfiles({ dshHome, profile: options.profile, fix: !isUpgrade && !options.check })
    if (isUpgrade) {
      const platform = inspectPlatform({
        profileDirs: report.profiles.filter(p => p.installation?.applicable && p.profileDir).map(p => p.profileDir), env,
      })
      const preflight = assessUpgradeProfileRisk(report, platform)
      if (options.json) io.log(JSON.stringify({ ok: preflight.pass, upgradePreflight: preflight }, null, 2))
      else {
        if (preflight.pass) io.log('Upgrade profile preflight: known overlay/workspace hazards not detected.')
        else {
          io.error('Upgrade profile preflight: blocked; inspect the profile before upgrading.')
          for (const item of preflight.blockers) io.error('  ' + item.code + ': ' + item.affectedProfiles + ' affected profile(s)')
        }
        io.log('Read-only; does not verify running Desktop Host, runtime routes or historical data. Not full release approval.')
      }
      return preflight.pass ? 0 : 1
    }
    io.log('DSH home: ' + report.dshHome)
    for (const item of report.profiles) printProfileDetails(item, io)
    if (!report.applicableProfiles) io.error('Vision Router is not installed or mounted in any discovered profile.')
    if (report.log?.settingsSaveFailures?.length) io.error('Current-run settings save failures: ' + report.log.settingsSaveFailures.length)
    if (report.profiles.some(p => p.installation?.applicable && !p.validJson)) {
      io.error('Repair only removes a leading UTF-8 BOM; it does not guess other JSON repairs.')
    }
    return report.ok ? 0 : 1
  } catch {
    // Keep preflight and recovery errors local and free of raw profile data.
    io.error('Recovery or preflight failed. Inspect the local profile or Session store before retrying.')
    return 1
  }
}

export function isCliEntry(entry, moduleUrl = import.meta.url) {
  if (typeof entry !== 'string' || entry.trim() === '') return false
  const real = (value) => {
    try { return realpathSync(value.startsWith('file:') ? fileURLToPath(value) : value) } catch { return value }
  }
  return real(entry) === real(moduleUrl)
}


if (isCliEntry(process.argv[1])) {
  process.exitCode = await run()
}

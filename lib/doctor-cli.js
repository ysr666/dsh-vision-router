#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { doctorProfiles, resolveDshHome } from './doctor.js'
import { inspectPlatform, probeRuntime, supportReport } from './doctor-runtime.js'
import { inspectDoctorVisionLimits, formatDoctorVisionLimits } from './doctor-vision-limits.js'
import { repairLegacySessionLogs } from './legacy-session-repair.js'

function usage() {
  return `dsh-vision-router doctor [--profile <name>] [--json] [--sessions] [--runtime-url <url>] [--no-runtime] [--fix]\ndsh-vision-router repair [--profile <name>]\ndsh-vision-router repair-sessions\n\nChecks installation, profile composition, runtime routes, recent settings-save failures and local vision capabilities.\n\nCommands:\n  doctor           Read-only health report by default. --fix is kept for compatibility but prefer the explicit repair command.\n  repair           Safely remove a leading UTF-8 BOM and rewrite stale version-pinned minimumReleaseAgeExclude entries.\n  repair-sessions  Offline repair for exact known Vision Router session corruptions, including the legacy missing-id reminder and duplicate structured guard-stop messages. Stop DSH first.\n\nOptions:\n  --profile <name>       Check only one profile (for example: web).\n  --json                 Emit a shareable, secret-minimized JSON diagnostic report.\n  --sessions             Also scan session logs for exact known Vision Router corruption signatures (read-only; may take longer).\n  --runtime-url <url>    Probe a running DSH web instance (default: DSH_WEB_URL or http://127.0.0.1:3080).\n  --no-runtime           Skip the read-only runtime route probe.\n  --fix                  Backward-compatible doctor repair mode; prefer \`repair\`.\n  --help                 Show this help.\n`
}

function parseArgs(argv) {
  const args = [...argv]
  let command = 'doctor'
  if (args[0] && !args[0].startsWith('-')) command = args.shift()
  let profile
  let fix = command === 'repair'
  let json = false
  let sessions = false
  let runtime = command === 'doctor'
  let runtimeUrl

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--help' || value === '-h') return { help: true }
    if (value === '--fix') {
      if (command === 'repair-sessions') throw new Error('--fix is not used with repair-sessions')
      fix = true
      continue
    }
    if (value === '--json') {
      if (command !== 'doctor') throw new Error('--json is only used with doctor')
      json = true
      continue
    }
    if (value === '--sessions') {
      if (command !== 'doctor') throw new Error('--sessions is only used with doctor')
      sessions = true
      continue
    }
    if (value === '--no-runtime') {
      if (command !== 'doctor') throw new Error('--no-runtime is only used with doctor')
      runtime = false
      continue
    }
    if (value === '--runtime-url') {
      if (command !== 'doctor') throw new Error('--runtime-url is only used with doctor')
      runtimeUrl = args[index + 1]
      index += 1
      if (!runtimeUrl) throw new Error('--runtime-url requires a URL')
      continue
    }
    if (value.startsWith('--runtime-url=')) {
      if (command !== 'doctor') throw new Error('--runtime-url is only used with doctor')
      runtimeUrl = value.slice('--runtime-url='.length)
      if (!runtimeUrl) throw new Error('--runtime-url requires a URL')
      continue
    }
    if (value === '--profile') {
      if (command === 'repair-sessions') throw new Error('--profile is not used with repair-sessions')
      profile = args[index + 1]
      index += 1
      if (!profile) throw new Error('--profile requires a name')
      continue
    }
    if (value.startsWith('--profile=')) {
      if (command === 'repair-sessions') throw new Error('--profile is not used with repair-sessions')
      profile = value.slice('--profile='.length)
      if (!profile) throw new Error('--profile requires a name')
      continue
    }
    throw new Error(`unknown argument: ${value}`)
  }

  if (!['doctor', 'repair', 'repair-sessions'].includes(command)) throw new Error(`unknown command: ${command}`)
  if (profile && (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..')) {
    throw new Error(`invalid profile name: ${profile}`)
  }
  if (runtimeUrl) {
    let parsed
    try { parsed = new URL(runtimeUrl) } catch { throw new Error(`invalid runtime URL: ${runtimeUrl}`) }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`invalid runtime URL protocol: ${parsed.protocol}`)
  }
  return { command, profile, fix, json, sessions, runtime, runtimeUrl }
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
  try {
    options = parseArgs(argv)
  } catch (error) {
    io.error(`dsh-vision-router: ${error instanceof Error ? error.message : String(error)}`)
    io.error(usage().trimEnd())
    return 2
  }
  if (options.help) {
    io.log(usage().trimEnd())
    return 0
  }

  const dshHome = resolveDshHome(env)
  if (options.command === 'repair-sessions') return runSessionRepair(dshHome, io)

  let profileReport
  try {
    profileReport = doctorProfiles({ dshHome, profile: options.profile, fix: options.fix })
  } catch (error) {
    io.error(`dsh-vision-router: doctor failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  if (profileReport.profiles.length === 0) {
    if (options.json) io.log(JSON.stringify({ schemaVersion: 1, ok: false, error: 'no DSH profiles found' }, null, 2))
    else {
      io.error('✗ No DSH profiles found.')
      io.error('  Expected profiles under <DSH_HOME>/profiles. If you use a custom home, set DSH_HOME first.')
    }
    return 1
  }

  let runtime
  if (options.runtime) {
    try {
      runtime = await probeRuntime({
        baseUrl: options.runtimeUrl || env.DSH_WEB_URL || 'http://127.0.0.1:3080',
        requestedProfile: options.profile,
        dshHome,
        applicableProfiles: profileReport.profiles.filter((item) => item.installation?.applicable).map((item) => item.name),
      })
    } catch (error) {
      io.error(`dsh-vision-router: runtime probe failed: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  const applicableDirs = profileReport.profiles
    .filter((item) => item.installation?.applicable && item.profileDir)
    .map((item) => item.profileDir)
  const platform = inspectPlatform({ profileDirs: applicableDirs })
  const visionLimits = inspectDoctorVisionLimits(profileReport.log?.file)
  let sessions
  if (options.sessions) sessions = repairLegacySessionLogs({ dshHome, fix: false })

  const overallOk = profileReport.ok
    && (runtime?.ok ?? true)
    && (!sessions || (sessions.affected === 0 && sessions.errors.length === 0))

  if (options.json) {
    const report = supportReport({ profileReport, runtime, platform, sessions })
    report.visionLimits = visionLimits
    report.ok = overallOk
    io.log(JSON.stringify(report, null, 2))
    return overallOk ? 0 : 1
  }

  io.log(`DSH home: ${profileReport.dshHome}`)
  for (const profile of profileReport.profiles) printProfileDetails(profile, io)
  if (profileReport.applicableProfiles === 0) io.error('✗ Vision Router is not installed or mounted in any discovered profile.')

  if (profileReport.log?.settingsSaveFailures?.length > 0) {
    const last = profileReport.log.settingsSaveFailures.at(-1)
    io.error(`✗ Current-run settings save failures found (${profileReport.log.settingsSaveFailures.length}); latest: field=${last.field} operation=${last.operation} reason=${last.reason}`)
  }
  if (profileReport.log?.historicalSettingsSaveFailures?.length > 0) {
    io.log(`! Historical settings save failures exist (${profileReport.log.historicalSettingsSaveFailures.length}); none are attributed to the latest plugin start.`)
  }
  for (const line of formatDoctorVisionLimits(visionLimits)) {
    if (line.startsWith('WARN:')) io.log(`! ${line.slice('WARN:'.length).trim()}`)
    else io.log(`✓ ${line}`)
  }

  if (runtime) {
    if (!runtime.reachable) io.log(`– Runtime probe: DSH not reachable at ${runtime.baseUrl}; offline checks still completed.`)
    else {
      for (const route of runtime.routes) {
        io.log(`${route.ok ? '✓' : '✗'} runtime ${route.route} — ${route.ok ? 'route registered' : `status ${route.status ?? 'unreachable'}, route not confirmed`}`)
      }
      if (options.profile) {
        if (runtime.ownership?.verified) io.log(`✓ runtime profile ownership — ${runtime.ownership.profile}`)
        else io.log(`? runtime profile ownership unknown${runtime.ownership?.profile ? ` (runtime reports ${runtime.ownership.profile})` : ''}; route health is not attributed to ${options.profile}`)
      }
    }
  }

  io.log(`${platform.nodeSupported ? '✓' : '!'} Node ${platform.node}${platform.nodeSupported ? '' : ` — outside supported ${platform.nodeRequirement}`}`)
  io.log(`${platform.tesseract?.version ? '✓' : '–'} Tesseract${platform.tesseract?.version ? ` — ${platform.tesseract.version}` : ' — not found (local OCR will fall back)'}`)
  io.log(`${platform.chromium?.version ? '✓' : '–'} Chromium/Chrome${platform.chromium?.version ? ` — ${platform.chromium.version}` : ' — not found (HTML screenshot tool unavailable)'}`)
  for (const entry of platform.sharp ?? []) {
    const profileName = profileReport.profiles.find((profile) => entry.profileDir === profile.profileDir)?.name
    io.log(`${entry.package?.version ? '✓' : '–'} Sharp${profileName ? ` (${profileName})` : ''}${entry.package?.version ? ` — ${entry.package.version}` : ' — not found in profile (may be host-provided)'}`)
  }

  if (sessions) {
    if (sessions.affected > 0) {
      io.error(`✗ Sessions: ${sessions.affected} known corrupt event(s) across ${sessions.reports.length} session log(s).`)
      io.error('  Stop DSH, then run `npx dsh-vision-router repair-sessions`.')
    } else if (sessions.errors.length > 0) {
      io.error(`✗ Sessions: ${sessions.errors.length} log(s) could not be inspected safely.`)
    } else {
      io.log(`✓ Sessions: scanned ${sessions.scanned}; no known Vision Router corruption found.`)
      if ((sessions.advisories?.length ?? 0) > 0) io.log(`! Sessions: ${sessions.advisories.length} live/incomplete tail(s) were skipped as advisory.`)
    }
  }

  const pendingFix = profileReport.profiles.some((profile) =>
    (profile.hasBom && !profile.repaired)
    || (profile.workspace?.pinned.length > 0 && !profile.workspace.rewritten))
  if (pendingFix) io.log('Run `npx dsh-vision-router repair` to fix the detected profile issues safely.')
  if (profileReport.profiles.some((profile) => !profile.validJson && profile.installation?.applicable)) {
    io.error('At least one applicable profile is still invalid JSON. Repair only removes a leading UTF-8 BOM; it does not guess other JSON repairs.')
  }
  return overallOk ? 0 : 1
}

export function isCliEntry(entry, moduleUrl = import.meta.url) {
  if (typeof entry !== 'string' || entry.trim() === '') return false
  const real = (value) => {
    try { return realpathSync(value.startsWith('file:') ? fileURLToPath(value) : value) } catch { return value }
  }
  return real(entry) === real(moduleUrl)
}

const entry = process.argv[1]
if (isCliEntry(entry)) {
  run().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`dsh-vision-router: doctor crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
  })
}

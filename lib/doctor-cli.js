#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { doctorProfiles, resolveDshHome } from './doctor.js'

function usage() {
  return `dsh-vision-router doctor [--profile <name>] [--fix]\ndsh-vision-router repair [--profile <name>]\n\nChecks DSH profile manifests even when DSH itself cannot boot.\n\nCommands:\n  doctor   Diagnose profile package.json files.\n  repair   Diagnose and safely remove a leading UTF-8 BOM.\n\nOptions:\n  --profile <name>  Check only one profile (for example: web).\n  --fix             With doctor, remove a leading UTF-8 BOM when found.\n  --help            Show this help.\n`
}

function parseArgs(argv) {
  const args = [...argv]
  let command = 'doctor'
  if (args[0] && !args[0].startsWith('-')) command = args.shift()
  let profile
  let fix = command === 'repair'

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--help' || value === '-h') return { help: true }
    if (value === '--fix') {
      fix = true
      continue
    }
    if (value === '--profile') {
      profile = args[index + 1]
      index += 1
      if (!profile) throw new Error('--profile requires a name')
      continue
    }
    if (value.startsWith('--profile=')) {
      profile = value.slice('--profile='.length)
      if (!profile) throw new Error('--profile requires a name')
      continue
    }
    throw new Error(`unknown argument: ${value}`)
  }

  if (command !== 'doctor' && command !== 'repair') {
    throw new Error(`unknown command: ${command}`)
  }
  if (profile && (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..')) {
    throw new Error(`invalid profile name: ${profile}`)
  }
  return { command, profile, fix }
}

function statusLine(profile) {
  const prefix = profile.validJson ? '✓' : '✗'
  const parts = [`${prefix} ${profile.name}`]
  if (!profile.exists) {
    parts.push('package.json not found')
    return parts.join(' — ')
  }
  if (profile.hasBom) {
    parts.push(profile.repaired ? 'UTF-8 BOM removed' : 'UTF-8 BOM detected')
  } else {
    parts.push('no BOM')
  }
  parts.push(profile.validJson ? 'JSON valid' : `JSON invalid: ${profile.jsonError}`)
  if (profile.validJson) {
    parts.push(profile.pluginDependency ? `dependency ${profile.pluginDependency}` : 'Vision Router dependency not present')
    parts.push(profile.pluginBundle ? 'bundle registered' : 'bundle not registered')
  }
  return parts.join(' — ')
}

export function run(argv = process.argv.slice(2), io = console, env = process.env) {
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
  let report
  try {
    report = doctorProfiles({ dshHome, profile: options.profile, fix: options.fix })
  } catch (error) {
    io.error(`dsh-vision-router: doctor failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  io.log(`DSH home: ${report.dshHome}`)
  if (report.profiles.length === 0) {
    io.error('✗ No DSH profiles found.')
    io.error('  Expected profiles under <DSH_HOME>/profiles. If you use a custom home, set DSH_HOME first.')
    return 1
  }

  for (const profile of report.profiles) io.log(statusLine(profile))

  const pendingBom = report.profiles.some((profile) => profile.hasBom && !profile.repaired)
  if (pendingBom) {
    io.log('Run `npx dsh-vision-router repair` to remove detected UTF-8 BOM bytes safely.')
  }
  if (report.profiles.some((profile) => !profile.validJson)) {
    io.error('At least one profile is still invalid JSON. The repair command only removes a leading UTF-8 BOM; it does not rewrite other JSON content.')
  }
  return report.ok ? 0 : 1
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = run()
}

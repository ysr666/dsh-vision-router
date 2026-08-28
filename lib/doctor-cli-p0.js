#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run as runBaseDoctor } from './doctor-cli.js'
import {
  formatDshHostCapability,
  normalizeDshHostCapabilities,
} from './dsh-host-capabilities.js'
import {
  DSH_SUPPORT_WINDOW,
  formatDshSupportWindowLines,
  supportWindowUpgradeAdvice,
} from './dsh-support-window.js'

const HOST_CAPABILITIES_PATH = '/_dsh/vision-router/host-capabilities'

function commandOf(argv) {
  const first = argv.find((value) => typeof value === 'string' && !value.startsWith('-'))
  return first && ['doctor', 'repair', 'repair-sessions'].includes(first) ? first : 'doctor'
}

function runtimeOptions(argv, env) {
  let enabled = true
  let baseUrl = env.DSH_WEB_URL || 'http://127.0.0.1:3080'
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--no-runtime') enabled = false
    if (value === '--runtime-url' && argv[index + 1]) {
      baseUrl = argv[index + 1]
      index += 1
    } else if (typeof value === 'string' && value.startsWith('--runtime-url=')) {
      baseUrl = value.slice('--runtime-url='.length)
    }
  }
  return { enabled, baseUrl }
}

function unknownSnapshot() {
  return normalizeDshHostCapabilities({})
}

export async function probeDoctorHostCapabilities({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  try {
    const normalized = new URL(baseUrl || 'http://127.0.0.1:3080')
    normalized.pathname = HOST_CAPABILITIES_PATH
    normalized.search = ''
    normalized.hash = ''
    if (typeof fetchImpl !== 'function') {
      return { ok: false, source: 'runtime-unavailable', capabilities: unknownSnapshot() }
    }
    const response = await fetchImpl(normalized, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) {
      return {
        ok: false,
        source: 'runtime-route-unavailable',
        status: response.status,
        capabilities: unknownSnapshot(),
      }
    }
    const body = await response.json()
    return {
      ok: true,
      source: 'live-runtime',
      capabilities: normalizeDshHostCapabilities(body?.capabilities),
    }
  } catch (error) {
    return {
      ok: false,
      source: 'runtime-unavailable',
      error: error instanceof Error ? error.message : String(error),
      capabilities: unknownSnapshot(),
    }
  }
}

function capabilityLines(probe) {
  const c = probe.capabilities
  return [
    'DSH Host capabilities:',
    `  batch attachments: ${formatDshHostCapability(c.batchAttachments)}`,
    `  max image dimension: ${formatDshHostCapability(c.maxImageDimension)}`,
    `  adapter registration: ${formatDshHostCapability(c.adapterRegistration)}`,
    `  registration replace: ${formatDshHostCapability(c.registrationReplace)}`,
    `  jobs: ${formatDshHostCapability(c.jobs)}`,
    `  surface replacement: ${formatDshHostCapability(c.surfaceReplacement)}`,
    `  settings live namespace: ${formatDshHostCapability(c.settingsLiveNamespace)}`,
    `  settings web exposure: ${formatDshHostCapability(c.settingsWebExposure)}`,
    `  prepareCall: ${formatDshHostCapability(c.prepareCall)}`,
    `  tool registration: ${formatDshHostCapability(c.toolRegistration)}`,
    `  tool execution: ${formatDshHostCapability(c.toolExecution)}`,
    `  source: ${probe.source}`,
    ...formatDshSupportWindowLines(c),
  ]
}

function isJsonRequest(argv) {
  return argv.includes('--json')
}

function isHelpRequest(argv) {
  return argv.includes('--help') || argv.includes('-h')
}

/**
 * P0 Doctor wrapper. Existing health semantics and exit codes stay owned by the
 * established Doctor implementation; Host-capability diagnostics and P3's
 * support-window policy are appended as advisory data and therefore can never
 * turn a healthy runtime unhealthy.
 */
export async function run(argv = process.argv.slice(2), io = console, env = process.env) {
  if (commandOf(argv) !== 'doctor' || isHelpRequest(argv)) {
    return runBaseDoctor(argv, io, env)
  }

  const runtime = runtimeOptions(argv, env)
  const probe = runtime.enabled
    ? await probeDoctorHostCapabilities({ baseUrl: runtime.baseUrl })
    : { ok: false, source: 'runtime-probe-disabled', capabilities: unknownSnapshot() }

  if (!isJsonRequest(argv)) {
    const code = await runBaseDoctor(argv, io, env)
    for (const line of capabilityLines(probe)) io.log(line)
    return code
  }

  const logs = []
  const errors = []
  const capture = {
    log(...values) { logs.push(values.map(String).join(' ')) },
    error(...values) { errors.push(values.map(String).join(' ')) },
  }
  const code = await runBaseDoctor(argv, capture, env)
  for (const line of errors) io.error(line)

  if (logs.length === 1) {
    try {
      const report = JSON.parse(logs[0])
      report.hostCapabilities = probe.capabilities
      report.hostCapabilitiesSource = probe.source
      report.hostSupportWindow = DSH_SUPPORT_WINDOW
      report.hostSupportAdvice = supportWindowUpgradeAdvice(probe.capabilities)
      io.log(JSON.stringify(report, null, 2))
      return code
    } catch {
      // Fall through to the untouched output below.
    }
  }
  for (const line of logs) io.log(line)
  return code
}

export function isCliEntry(entry, moduleUrl = import.meta.url) {
  if (typeof entry !== 'string' || entry.trim() === '') return false
  const real = (value) => {
    try { return realpathSync(value.startsWith('file:') ? fileURLToPath(value) : value) } catch { return value }
  }
  return real(entry) === real(moduleUrl)
}

if (isCliEntry(process.argv[1])) {
  const code = await run()
  if (Number.isInteger(code) && code !== 0) process.exitCode = code
}

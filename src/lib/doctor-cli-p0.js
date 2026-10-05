#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run as runBaseDoctor } from './doctor-cli.js'
import {
  formatDshHostCapability,
  normalizeDshHostCapabilities,
} from './dsh-host-capabilities.js'
import { DOCTOR_RESPONSE_MAX_BYTES, readResponseJsonBounded } from './http-body-limit.js'
import { redactDiagnosticText } from './diagnostic-redaction.js'
import {
  DSH_SUPPORT_WINDOW,
  DSH_VERIFICATION_EVIDENCE,
  formatDshSupportWindowLines,
  supportWindowUpgradeAdvice,
} from './dsh-support-window.js'

const HOST_CAPABILITIES_PATH = '/_dsh/vision-router/host-capabilities'
const DOCTOR_PROBE_TIMEOUT_MS = 1500
// The fence is a backstop, not a competing deadline: it must sit after the signal
// so a cooperative fetch keeps reporting the abort reason it reports today.
const DOCTOR_PROBE_FENCE_MS = DOCTOR_PROBE_TIMEOUT_MS + 250

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
    // The signal below only bounds a fetch that honours it. A non-cooperative
    // implementation would leave this probe pending forever, so the same inline
    // fence the live-model discovery uses (its own timer + explicit cleanup)
    // bounds the await itself. The signal stays so a cooperative fetch still
    // reports the aborted reason it reports today.
    // The fence deliberately keeps the event loop alive: this is a foreground
    // probe the CLI is waiting on, unlike the background benchmark timers that
    // unref themselves. (Node's own AbortSignal.timeout timer is unref'd, so
    // unref'ing this one too would let the process exit before it fires.)
    let deadlineTimer
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(new Error(`Doctor Host capability probe exceeded ${DOCTOR_PROBE_TIMEOUT_MS}ms`))
      }, DOCTOR_PROBE_FENCE_MS)
    })
    let response
    try {
      response = await Promise.race([
        fetchImpl(normalized, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(DOCTOR_PROBE_TIMEOUT_MS),
        }),
        deadline,
      ])
    } finally {
      clearTimeout(deadlineTimer)
    }
    if (!response.ok) {
      return {
        ok: false,
        source: response.status === 401 ? 'runtime-auth-required' : 'runtime-route-unavailable',
        status: response.status,
        capabilities: unknownSnapshot(),
      }
    }
    const body = await readResponseJsonBounded(response, DOCTOR_RESPONSE_MAX_BYTES, {
      label: 'Doctor Host capability response',
    })
    return {
      ok: true,
      source: 'live-runtime',
      capabilities: normalizeDshHostCapabilities(body?.capabilities),
    }
  } catch (error) {
    // A fetch failure can echo the request URL, and a proxy failure can echo the
    // proxy URL with its userinfo; the doctor report is meant to be shareable, so
    // the message is redacted at the source rather than at each print site.
    return {
      ok: false,
      source: 'runtime-unavailable',
      error: redactDiagnosticText(error instanceof Error ? error.message : String(error), 200),
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
      report.hostVerificationEvidence = DSH_VERIFICATION_EVIDENCE
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

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// An external process supervises the actual Desktop/Electron E2E. In-process
// setTimeout cannot interrupt a hung spawnSync() or a frozen Node event loop.
const script = process.argv[2]
if (!script) throw new Error('usage: node dsh-desktop-e2e-watchdog.mjs <desktop-e2e-script>')
const suppliedLimit = Number(process.env.DVR_DESKTOP_E2E_HARD_TIMEOUT_MS)
const timeoutMs = Number.isFinite(suppliedLimit) && suppliedLimit >= 250 && suppliedLimit <= 1_200_000
  ? suppliedLimit : 600_000
const diagnostics = process.env.SMOKE_DIAGNOSTIC_PATH
const progressPath = process.env.DVR_DESKTOP_E2E_PROGRESS_PATH
  || (diagnostics ? diagnostics + '.stage' : join(tmpdir(), 'dvr-desktop-e2e-' + process.pid + '.stage'))
const env = { ...process.env, DVR_DESKTOP_E2E_PROGRESS_PATH: progressPath }
const skipTsx = process.env.DVR_DESKTOP_E2E_SKIP_TSX === '1' // only for testing the watchdog itself
const argv = skipTsx ? [script] : ['--import', 'tsx', script]
const child = spawn(process.execPath, argv, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
})
let finished = false
let timedOut = false
let terminating = false
const lastPhase = () => {
  try {
    if (existsSync(progressPath)) {
      const parsed = JSON.parse(readFileSync(progressPath, 'utf8'))
      return typeof parsed?.phase === 'string' ? parsed.phase.slice(0, 120) : 'unavailable'
    }
  } catch {}
  return 'before-first-checkpoint'
}
const terminateGroup = (signal) => {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore', timeout: 5000,
      })
    } catch {}
  } else {
    try { process.kill(-child.pid, signal) } catch {
      try { child.kill(signal) } catch {}
    }
  }
}
const timer = setTimeout(() => {
  if (finished) return
  timedOut = true
  const phase = lastPhase()
  const result = {
    ok: false,
    failureKind: 'desktop-e2e-watchdog-timeout',
    timeoutMs,
    lastPhase: phase,
  }
  console.error('[desktop-e2e-watchdog] timed out: ' + JSON.stringify(result))
  if (diagnostics) {
    try { writeFileSync(diagnostics, JSON.stringify(result, null, 2) + '\n') } catch {}
  }
  terminateGroup('SIGTERM')
  terminating = true
  setTimeout(() => {
    if (finished) return
    terminateGroup('SIGKILL')
    process.exit(124)
  }, 3000).unref()
}, timeoutMs)
child.once('error', (error) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  console.error('[desktop-e2e-watchdog] failed to launch child: ' + error.message)
  process.exitCode = 1
})
child.once('close', (code, signal) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  if (terminating || timedOut) {
    process.exitCode = 124
    return
  }
  process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0
})

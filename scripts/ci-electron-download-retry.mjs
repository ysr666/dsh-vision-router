/**
 * CI-only recovery for transient official Electron download HTTP 5xx/timeouts.
 * Never alters the locked package version, verified binary, or mirror.
 * Does not retry renderer assertions or hide Desktop test failures.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const MISSING_BINARY = /Electron failed to install correctly/i
const TRANSIENT_DOWNLOAD_ERROR = /(?:(?:HTTPError:\s*Response code|HTTP status code:|Response code|Unexpected HTTP response:)\s*(?:502|503|504)\b|Gateway Time-out|Bad Gateway|Service Unavailable)/i

export async function resolveCiElectronBinary(desktopRequire, {
  ci = process.env.GITHUB_ACTIONS === 'true',
  attempts = 6,
  runInstall = (entry) => spawnSync(process.execPath, [entry], {
    cwd: dirname(entry),
    encoding: 'utf8',
    timeout: 65_000,
    maxBuffer: 4 * 1024 * 1024,
  }),
  exists = existsSync,
  delay = sleep,
  notice = (line) => process.stderr.write(line + '\n'),
} = {}) {
  try {
    return desktopRequire('electron')
  } catch (error) {
    if (!ci || !MISSING_BINARY.test(String(error?.message))) throw error
  }
  const installPath = join(dirname(desktopRequire.resolve('electron')), 'install.js')
  if (!exists(installPath)) throw new Error('official Electron installer unavailable (no mirror fallback)')
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 6) {
    throw new RangeError('official Electron installer attempts must be between 1 and 6')
  }

  for (let number = 1; number <= attempts; number += 1) {
    const result = await runInstall(installPath)
    if (result?.status === 0 && !result.error) {
      // Loading the exact pnpm-locked binary is the only successful outcome.
      // If it still fails, do not mask it with another download or skip.
      return desktopRequire('electron')
    }
    const details = String(result?.stderr ?? '') + '\n' + String(result?.stdout ?? '')
    // If @electron/get itself stalls instead of returning an HTTP status,
    // allow the same bounded retry only for the locked official installer.
    const installTimedOut = result?.error?.code === 'ETIMEDOUT'
    if (!TRANSIENT_DOWNLOAD_ERROR.test(details) && !installTimedOut) {
      throw new Error('official Electron install failed for a nontransient reason; renderer was not run')
    }
    if (number === attempts) {
      throw new Error('official Electron download failed with transient HTTP 5xx/timeout after ' + attempts + ' bounded CI attempts')
    }
    notice('Official Electron download transient HTTP 5xx/timeout: retry ' + number + '/' + (attempts - 1) + ' (same locked package, same source)')
    await delay(3_000 * number)
  }
  throw new Error('unreachable Electron CI recovery state')
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const watchdog = resolve(import.meta.dirname, '../scripts/dsh-desktop-e2e-watchdog.mjs')
function runWatchdog(scriptBody, timeoutMs) {
  const home = mkdtempSync(join(tmpdir(), 'dvr-desktop-watchdog-'))
  try {
    const script = join(home, 'fixture.mjs')
    const diagnostic = join(home, 'diagnostic.json')
    writeFileSync(script, scriptBody)
    const result = spawnSync(process.execPath, [watchdog, script], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        SMOKE_DIAGNOSTIC_PATH: diagnostic,
        DVR_DESKTOP_E2E_HARD_TIMEOUT_MS: String(timeoutMs),
        DVR_DESKTOP_E2E_SKIP_TSX: '1',
      },
    })
    return {
      status: result.status,
      error: result.error,
      stderr: result.stderr,
      diagnostic: (() => { try { return JSON.parse(readFileSync(diagnostic, 'utf8')) } catch { return undefined } })(),
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('desktop E2E watchdog preserves successful child status and leaves no fabricated diagnostic', () => {
  const r = runWatchdog("console.log('fixture ok')", 2000)
  assert.equal(r.status, 0, String(r.error ?? r.stderr))
  assert.equal(r.diagnostic, undefined)
})

test('desktop E2E watchdog fails a stalled subprocess with bounded phase-only evidence', () => {
  const r = runWatchdog("setInterval(() => {}, 10000)", 1500)
  assert.equal(r.status, 124, String(r.error ?? r.stderr))
  assert.equal(r.diagnostic?.failureKind, 'desktop-e2e-watchdog-timeout')
  assert.equal(r.diagnostic?.lastPhase, 'before-first-checkpoint')
  assert.equal(r.diagnostic?.timeoutMs, 1500)
  assert.match(r.stderr, /timed out/)
})

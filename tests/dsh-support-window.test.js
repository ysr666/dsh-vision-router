import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  DSH_SUPPORT_WINDOW,
  formatDshSupportWindowLines,
  supportWindowUpgradeAdvice,
} from '../lib/dsh-support-window.js'

test('P3 support window keeps rc6 through the DVR 2.0.x patch train', () => {
  assert.equal(DSH_SUPPORT_WINDOW.dvrTrain, '2.0.x')
  assert.equal(DSH_SUPPORT_WINDOW.minimum, '0.1.0-rc.6')
  assert.equal(DSH_SUPPORT_WINDOW.previous, '0.1.0-rc.8')
  assert.equal(DSH_SUPPORT_WINDOW.current, '0.1.1-rc.2')
  assert.equal(DSH_SUPPORT_WINDOW.next.dvrTrain, '2.1.0')
  assert.equal(DSH_SUPPORT_WINDOW.next.minimum, '0.1.0-rc.8')
})

test('Doctor advice is capability-based instead of guessing a Host version', () => {
  const old = supportWindowUpgradeAdvice({
    batchAttachments: false,
    maxImageDimension: false,
  })
  assert.equal(old.level, 'recommended')
  assert.equal(old.code, 'HOST_BELOW_NEXT_FLOOR_CAPABILITIES')

  const unknown = supportWindowUpgradeAdvice({
    batchAttachments: 'unknown',
    maxImageDimension: 'unknown',
  })
  assert.equal(unknown.level, 'unknown')
  assert.equal(unknown.code, 'HOST_NEXT_FLOOR_UNKNOWN')

  const capable = supportWindowUpgradeAdvice({
    batchAttachments: true,
    maxImageDimension: true,
  })
  assert.equal(capable.level, 'ok')
  assert.equal(capable.code, 'HOST_NEXT_FLOOR_CAPABLE')
})

test('support window text exposes current and announced floors without changing runtime authority', () => {
  const lines = formatDshSupportWindowLines({
    batchAttachments: false,
    maxImageDimension: false,
  })
  assert.equal(lines[0], 'DSH Host support window:')
  assert.ok(lines.some((line) => line.includes('minimum: 0.1.0-rc.6')))
  assert.ok(lines.some((line) => line.includes('DVR 2.1.0 -> DSH 0.1.0-rc.8')))
  assert.ok(lines.some((line) => line.includes('HOST_BELOW_NEXT_FLOOR_CAPABILITIES')))
  assert.equal(Object.isFrozen(lines), true)
})

test('public READMEs state the current and announced Host floors', async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh.md', import.meta.url), 'utf8'),
  ])

  for (const source of [english, chinese]) {
    assert.match(source, /2\.0\.x/)
    assert.match(source, /0\.1\.0-rc\.6/)
    assert.match(source, /0\.1\.0-rc\.8/)
    assert.match(source, /0\.1\.1-rc\.2/)
    assert.match(source, /2\.1\.0/)
    assert.match(source, /docs\/architecture\/dsh-support-window\.md/)
  }
})

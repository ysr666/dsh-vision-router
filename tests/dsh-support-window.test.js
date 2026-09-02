import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  DSH_SUPPORT_WINDOW,
  formatDshSupportWindowLines,
  supportWindowUpgradeAdvice,
} from '../lib/dsh-support-window.js'

test('P3 support window activates the announced rc8 floor for DVR 2.1.x', () => {
  assert.equal(DSH_SUPPORT_WINDOW.dvrTrain, '2.1.x')
  assert.equal(DSH_SUPPORT_WINDOW.minimum, '0.1.0-rc.8')
  assert.equal(DSH_SUPPORT_WINDOW.previous, '0.1.1-rc.1')
  assert.equal(DSH_SUPPORT_WINDOW.current, '0.1.1-rc.2')
  assert.equal(DSH_SUPPORT_WINDOW.canary, '0.1.2-alpha.4')
  assert.equal(Object.hasOwn(DSH_SUPPORT_WINDOW, 'next'), false)
})

test('Doctor advice is capability-based against the active support floor', () => {
  const old = supportWindowUpgradeAdvice({
    batchAttachments: false,
    maxImageDimension: false,
  })
  assert.equal(old.level, 'required')
  assert.equal(old.code, 'HOST_BELOW_CURRENT_FLOOR_CAPABILITIES')

  const unknown = supportWindowUpgradeAdvice({
    batchAttachments: 'unknown',
    maxImageDimension: 'unknown',
  })
  assert.equal(unknown.level, 'unknown')
  assert.equal(unknown.code, 'HOST_CURRENT_FLOOR_UNKNOWN')

  const capable = supportWindowUpgradeAdvice({
    batchAttachments: true,
    maxImageDimension: true,
  })
  assert.equal(capable.level, 'ok')
  assert.equal(capable.code, 'HOST_CURRENT_FLOOR_CAPABLE')
})

test('support window text exposes the active 2.1 floor without inventing a future floor', () => {
  const lines = formatDshSupportWindowLines({
    batchAttachments: false,
    maxImageDimension: false,
  })
  assert.equal(lines[0], 'DSH Host support window:')
  assert.ok(lines.some((line) => line.includes('DVR train: 2.1.x')))
  assert.ok(lines.some((line) => line.includes('minimum: 0.1.0-rc.8')))
  assert.ok(lines.some((line) => line.includes('previous: 0.1.1-rc.1')))
  assert.ok(lines.some((line) => line.includes('canary only: 0.1.2-alpha.4')))
  assert.ok(lines.some((line) => line.includes('support floor: DVR 2.1.x -> DSH 0.1.0-rc.8')))
  assert.ok(lines.some((line) => line.includes('HOST_BELOW_CURRENT_FLOOR_CAPABILITIES')))
  assert.equal(lines.some((line) => line.includes('next announced floor')), false)
  assert.equal(Object.isFrozen(lines), true)
})

test('public READMEs state the active 2.1 Host floor', async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh.md', import.meta.url), 'utf8'),
  ])

  for (const source of [english, chinese]) {
    assert.match(source, /2\.1\.x/)
    assert.match(source, /0\.1\.0-rc\.8/)
    assert.match(source, /0\.1\.1-rc\.1/)
    assert.match(source, /0\.1\.1-rc\.2/)
    assert.match(source, /0\.1\.2-alpha\.4/)
    assert.match(source, /docs\/architecture\/dsh-support-window\.md/)
    assert.doesNotMatch(source, /2\.0\.x supports DSH `0\.1\.0-rc\.6`/)
  }
})

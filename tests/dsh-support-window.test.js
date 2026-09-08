import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  DSH_SUPPORT_WINDOW,
  DSH_VERIFICATION_EVIDENCE,
  formatDshSupportWindowLines,
  supportWindowUpgradeAdvice,
} from '../lib/dsh-support-window.js'

test('P3 support policy contains only public stable support semantics', () => {
  assert.deepEqual(DSH_SUPPORT_WINDOW, {
    dvrTrain: '2.1.x',
    minimum: '0.1.0-rc.8',
    currentStable: '0.1.2-rc.1',
  })
  assert.equal(Object.hasOwn(DSH_SUPPORT_WINDOW, 'previous'), false)
  assert.equal(Object.hasOwn(DSH_SUPPORT_WINDOW, 'canary'), false)
  assert.equal(Object.hasOwn(DSH_SUPPORT_WINDOW, 'preview'), false)
  assert.equal(Object.isFrozen(DSH_SUPPORT_WINDOW), true)
})

test('preview and dynamic canaries are verification evidence, not support-window fields', () => {
  assert.deepEqual(DSH_VERIFICATION_EVIDENCE, {
    exactStable: '0.1.2-rc.1',
    exactPreview: '0.1.3-alpha.2',
    stableCanaryDistTag: 'latest',
    previewCanaryDistTag: 'alpha',
  })
  assert.equal(Object.isFrozen(DSH_VERIFICATION_EVIDENCE), true)
})

test('Doctor advice is capability-based against the active support floor', () => {
  const old = supportWindowUpgradeAdvice({ batchAttachments: false, maxImageDimension: false })
  assert.equal(old.level, 'required')
  assert.equal(old.code, 'HOST_BELOW_CURRENT_FLOOR_CAPABILITIES')

  const unknown = supportWindowUpgradeAdvice({ batchAttachments: 'unknown', maxImageDimension: 'unknown' })
  assert.equal(unknown.level, 'unknown')
  assert.equal(unknown.code, 'HOST_CURRENT_FLOOR_UNKNOWN')

  const capable = supportWindowUpgradeAdvice({ batchAttachments: true, maxImageDimension: true })
  assert.equal(capable.level, 'ok')
  assert.equal(capable.code, 'HOST_CURRENT_FLOOR_CAPABLE')
})

test('Doctor text separates public support policy from verification evidence', () => {
  const lines = formatDshSupportWindowLines({ batchAttachments: false, maxImageDimension: false })
  const evidenceAt = lines.indexOf('DSH compatibility verification evidence:')
  assert.ok(evidenceAt > 0)
  assert.ok(lines.slice(0, evidenceAt).some((line) => line.includes('minimum supported Host: 0.1.0-rc.8')))
  assert.ok(lines.slice(0, evidenceAt).some((line) => line.includes('current stable Host: 0.1.2-rc.1')))
  assert.equal(lines.slice(0, evidenceAt).some((line) => /alpha|canary/i.test(line)), false)
  assert.ok(lines.slice(evidenceAt).some((line) => line.includes('exact preview (not a support claim): 0.1.3-alpha.2')))
  assert.ok(lines.slice(evidenceAt).some((line) => line.includes('npm dist-tag latest')))
  assert.ok(lines.slice(evidenceAt).some((line) => line.includes('npm dist-tag alpha')))
  assert.ok(lines.some((line) => line.includes('HOST_BELOW_CURRENT_FLOOR_CAPABILITIES')))
  assert.equal(Object.isFrozen(lines), true)
})

test('public READMEs separate stable support from preview verification evidence', async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh.md', import.meta.url), 'utf8'),
  ])

  for (const source of [english, chinese]) {
    assert.match(source, /2\.1\.x/)
    assert.match(source, /0\.1\.0-rc\.8/)
    assert.match(source, /0\.1\.2-rc\.1/)
    assert.match(source, /0\.1\.3-alpha\.2/)
    assert.match(source, /docs\/architecture\/dsh-support-window\.md/)
    assert.doesNotMatch(source, /0\.1\.2-alpha\.4/)
  }
})


test('current-contract follows the current stable Host while preview remains a separate gate', async () => {
  const [contract, preview] = await Promise.all([
    readFile(new URL('../.github/workflows/dsh-contract.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-preview-browser-smoke.yml', import.meta.url), 'utf8'),
  ])
  assert.match(contract, /name: current-contract[\s\S]*?dsh: 0\.1\.2-rc\.1/)
  assert.match(preview, /dsh: 0\.1\.3-alpha\.2/)
  assert.doesNotMatch(contract, /dsh: 0\.1\.3-alpha\.2/)
})

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
    dvrTrain: '2.3.x',
    minimum: '0.1.5',
    currentStable: '0.1.5-rc.3',
  })
  assert.equal(Object.hasOwn(DSH_SUPPORT_WINDOW, 'previous'), false)
  assert.equal(Object.hasOwn(DSH_SUPPORT_WINDOW, 'canary'), false)
  assert.equal(Object.hasOwn(DSH_SUPPORT_WINDOW, 'preview'), false)
  assert.equal(Object.isFrozen(DSH_SUPPORT_WINDOW), true)
})

test('forward-admission evidence and dynamic canaries stay separate from stable-floor fields', () => {
  assert.deepEqual(DSH_VERIFICATION_EVIDENCE, {
    exactStable: '0.1.5-rc.3',
    exactPreview: '0.2.0-rc.2',
    stableCanaryDistTag: 'latest',
    nextCanaryDistTag: 'next',
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
  assert.ok(lines.slice(0, evidenceAt).some((line) => line.includes('minimum supported Host: 0.1.5')))
  assert.ok(lines.slice(0, evidenceAt).some((line) => line.includes('current stable Host: 0.1.5-rc.3')))
  assert.equal(lines.slice(0, evidenceAt).some((line) => /alpha|canary/i.test(line)), false)
  assert.ok(lines.slice(evidenceAt).some((line) => line.includes('exact supported 0.2.x boundary: 0.2.0-rc.2')))
  assert.ok(lines.slice(evidenceAt).some((line) => line.includes('npm dist-tag latest')))
  assert.ok(lines.slice(evidenceAt).some((line) => line.includes('npm dist-tag next')))
  assert.ok(lines.slice(evidenceAt).some((line) => line.includes('npm dist-tag alpha')))
  assert.ok(lines.some((line) => line.includes('HOST_BELOW_CURRENT_FLOOR_CAPABILITIES')))
  assert.equal(Object.isFrozen(lines), true)
})

test('public READMEs state stable support policy and delegate forward-boundary evidence to the canonical support document', async () => {
  const [english, chinese, supportDoc] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/architecture/dsh-support-window.md', import.meta.url), 'utf8'),
  ])

  for (const source of [english, chinese]) {
    assert.match(source, /3\.0\.x/)
    assert.match(source, /0\.1\.5/)
    assert.match(source, /0\.1\.5-rc\.1/)
    assert.match(source, /0\.1\.5-rc\.3/)
    assert.match(source, /0\.2\.0-rc\.2/)
    assert.match(source, /docs\/architecture\/dsh-support-window\.md/)
  }
  assert.match(supportDoc, /Exact supported 0\.2\.x boundary \| `0\.2\.0-rc\.2`/)
})


test('current-contract follows the current stable Host while preview remains a separate gate', async () => {
  const [contract, preview, exactSource] = await Promise.all([
    readFile(new URL('../.github/workflows/dsh-contract.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-preview-browser-smoke.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-alpha-source-contract.yml', import.meta.url), 'utf8'),
  ])
  assert.match(contract, /name: minimum-contract[\s\S]*?dsh: 0\.1\.5-rc\.1/)
  assert.match(contract, /name: current-contract[\s\S]*?dsh: 0\.1\.5-rc\.3/)
  assert.doesNotMatch(contract, /dsh: 0\.1\.0-/)
  assert.doesNotMatch(contract, /dsh: 0\.1\.7-/)
  assert.match(preview, /dsh: 0\.1\.5-rc\.3/)
  assert.match(preview, /a4c74a91e06b00fe0b0937bde982170c526cc842/)
  assert.match(preview, /dsh: 0\.1\.5-alpha\.2/)
  assert.match(preview, /dsh: 0\.1\.7-rc\.2/)
  assert.doesNotMatch(contract, /dsh: 0\.1\.5-alpha\.2/)
  assert.match(exactSource, /DSH_EXPECTED_VERSION: 0\.1\.5-rc\.3/)
  assert.match(exactSource, /DSH_EXPECTED_COMMIT: a4c74a91e06b00fe0b0937bde982170c526cc842/)
  assert.match(exactSource, /DSH_EXPECTED_VERSION: 0\.1\.7-rc\.2/)
  assert.match(exactSource, /DSH_EXPECTED_COMMIT: 477b4f420553e8a52c2fbccc464d7561b239c443/)
  assert.match(exactSource, /scripts\/dsh-proxy-egress-contract\.mjs/)
})

test('required compatibility workflows do not gate DVR 2.3 on pre-0.1.5 Hosts', async () => {
  const [ci, coldResume] = await Promise.all([
    readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/native-multimodal-cold-resume.yml', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(ci, /0\.1\.0-rc\.[678]/)
  assert.doesNotMatch(coldResume, /0\.1\.0-rc\.[678]/)
  assert.match(coldResume, /dsh: \['0\.1\.5-rc\.1', '0\.1\.7-rc\.2'\]/)
})

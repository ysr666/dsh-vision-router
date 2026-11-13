import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  DSH_SUPPORT_WINDOW, DSH_VERIFICATION_EVIDENCE, DSH_SUPPORTED_RANGE,
  formatDshSupportWindowLines, supportWindowUpgradeAdvice,
} from '../lib/dsh-support-window.js'

const fullCapabilities = { batchAttachments: true, maxImageDimension: true }
const verified = { nodeVersion: '24.21.0', hostVersion: '0.2.1-rc.5' }

test('DVR 3.2 declares a new DSH/Node floor without confusing rc and stable', () => {
  assert.deepEqual(DSH_SUPPORT_WINDOW, {
    dvrTrain: '3.2.x', minimum: '0.2.1-rc.5',
    currentRecommended: '0.2.2-rc.1', nodeMinimum: '24.9.0',
  })
  assert.equal(DSH_SUPPORTED_RANGE, '>=0.2.1-rc.5 <0.3.0-0')
  assert.deepEqual(DSH_VERIFICATION_EVIDENCE, {
    exactFloor: '0.2.1-rc.5', exactRecommended: '0.2.2-rc.1',
    exactVerified: ['0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3'],
    stableCanaryDistTag: 'latest', nextCanaryDistTag: 'next',
    previewCanaryDistTag: 'alpha',
  })
  assert.equal(Object.isFrozen(DSH_SUPPORT_WINDOW), true)
  assert.equal(Object.isFrozen(DSH_VERIFICATION_EVIDENCE), true)
  assert.equal(Object.isFrozen(DSH_VERIFICATION_EVIDENCE.exactVerified), true)
})

test('Doctor refuses Node 22, 24.8 and unverified Node versions', () => {
  for (const nodeVersion of ['22.19.0', '22.23.4', '24.8.9']) {
    const r = supportWindowUpgradeAdvice(fullCapabilities, { ...verified, nodeVersion })
    assert.equal(r.code, 'NODE_BELOW_CURRENT_FLOOR', nodeVersion)
    assert.equal(r.level, 'required')
  }
  assert.equal(supportWindowUpgradeAdvice(fullCapabilities,
    { ...verified, nodeVersion: 'unknown' }).code, 'NODE_VERSION_UNVERIFIED')
  assert.equal(supportWindowUpgradeAdvice(fullCapabilities,
    { ...verified, nodeVersion: '24.9.0' }).level, 'ok')
})

test('Doctor excludes retired DSH releases even if attachment capabilities are present', () => {
  for (const hostVersion of ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-rc.4', '0.3.0-alpha.1']) {
    const r = supportWindowUpgradeAdvice(fullCapabilities, { ...verified, hostVersion })
    assert.equal(r.code, 'HOST_BELOW_CURRENT_FLOOR_VERSION', hostVersion)
    assert.equal(r.level, 'required')
  }
  for (const hostVersion of ['0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3']) {
    assert.equal(supportWindowUpgradeAdvice(fullCapabilities,
      { ...verified, hostVersion }).level, 'ok', hostVersion)
  }
})

test('admitted future or preview releases are unknown until exact Host/Node gates run', () => {
  for (const hostVersion of ['0.2.1', '0.2.2-alpha.1', '0.2.2-alpha.3', '0.2.2-rc.4', '0.2.3-rc.1', '0.2.99']) {
    const value = supportWindowUpgradeAdvice(fullCapabilities, { ...verified, hostVersion })
    assert.equal(value.level, 'unknown', hostVersion)
    assert.equal(value.code, 'HOST_FORWARD_RELEASE_UNVERIFIED', hostVersion)
  }
  for (const nodeVersion of ['25.0.0', '26.0.0']) {
    const value = supportWindowUpgradeAdvice(fullCapabilities, { ...verified, nodeVersion })
    assert.equal(value.level, 'unknown', nodeVersion)
    assert.equal(value.code, 'NODE_FORWARD_MAJOR_UNVERIFIED', nodeVersion)
  }
  assert.equal(supportWindowUpgradeAdvice(fullCapabilities,
    { ...verified, hostVersion: '0.2.2-rc.1' }).code, 'HOST_CURRENT_FLOOR_CAPABLE')
})

test('Doctor never treats capability evidence as proof of the Host version', () => {
  const missing = supportWindowUpgradeAdvice(fullCapabilities, { nodeVersion: '24.21.0' })
  assert.equal(missing.level, 'unknown')
  assert.equal(missing.code, 'HOST_VERSION_UNVERIFIED')
  assert.equal(supportWindowUpgradeAdvice(fullCapabilities,
    { ...verified, hostVersion: 'not-a-version' }).level, 'unknown')
  assert.equal(supportWindowUpgradeAdvice({ batchAttachments: false, maxImageDimension: true },
    verified).code, 'HOST_BELOW_CURRENT_FLOOR_CAPABILITIES')
  assert.equal(supportWindowUpgradeAdvice({ batchAttachments: 'unknown', maxImageDimension: true },
    verified).code, 'HOST_CURRENT_FLOOR_UNKNOWN')
  assert.equal(supportWindowUpgradeAdvice({ batchAttachments: false, maxImageDimension: true },
    { ...verified, hostVersion: '0.2.2-rc.3' }).code, 'HOST_BELOW_CURRENT_FLOOR_CAPABILITIES')
})

test('Doctor text distinguishes published recommended RC from stable host', () => {
  const lines = formatDshSupportWindowLines(fullCapabilities, verified)
  assert.ok(lines.some((line) => line.includes('minimum supported Host: 0.2.1-rc.5')))
  assert.ok(lines.some((line) => line.includes('current recommended Host: 0.2.2-rc.1')))
  assert.ok(lines.some((line) => line.includes('verified exact Host releases: 0.2.1-rc.5, 0.2.2-rc.1, 0.2.2-rc.2, 0.2.2-rc.3')))
  assert.ok(lines.some((line) => line.includes('minimum supported Node.js: 24.9.0')))
  assert.ok(lines.some((line) => line.includes('HOST_CURRENT_FLOOR_CAPABLE')))
  assert.equal(Object.isFrozen(lines), true)
})

test('3.2 public documentation describes legacy retirement instead of advertising 0.1.x', async () => {
  const files = ['../README.md', '../README.zh.md', '../docs/architecture/dsh-support-window.md']
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /0\.2\.1-rc\.5/, file)
    assert.match(source, /0\.2\.2-rc\.1/, file)
    assert.match(source, /24\.9\.0/, file)
  }
})

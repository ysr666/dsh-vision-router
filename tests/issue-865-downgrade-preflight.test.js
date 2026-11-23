import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  inspectDshDowngradeSafety,
  assessSessionArtifactDowngrade,
} from '../lib/legacy-session-repair.js'
import { createStableProjectionWitness } from '../lib/session-image-projection-mode.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dvr-865-downgrade-'))
  const sessions = join(dir, 'sessions')
  mkdirSync(sessions)
  return {
    dir, sessions,
    add(name, mode, compressed = false) {
      const base = join(sessions, name)
      mkdirSync(base)
      const file = join(base, compressed ? 'session.jsonl.zstd' : 'session.jsonl')
      const header = JSON.stringify({
        type: 'session', version: 0, id: 'PRIVATE_SESSION_' + name,
        createdAt: 10, delegationDepth: 0,
      }) + '\n'
      const records = [
        { seq: 0, type: 'request/header', data: {} },
        ...(mode === 'unwitnessed' ? [] : [{
          seq: 1, type: 'user/message',
          data: createStableProjectionWitness('PRIVATE_SESSION_' + name,
            { kind: 'plugin:dsh-vision-router' }, mode === 'stable-v1' ? 'stable' : 'stable-v2'),
        }]),
      ].map(record => JSON.stringify(record)).join('\n') + '\n'
      writeFileSync(file, compressed
        ? Buffer.concat([zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(records))])
        : header + records)
      return file
    },
    close() { rmSync(dir, { recursive: true, force: true }) },
  }
}

test('#865: a true legacy-only rollback cannot accept a stable-v1/v2 compressed Session', () => {
  const f = fixture()
  try {
    const v1 = f.add('v1', 'stable-v1')
    const v2 = f.add('v2', 'stable-v2', true)
    assert.deepEqual(assessSessionArtifactDowngrade(v1, 'legacy-only'),
      { decision: 'block', reason: 'target-cannot-read-v1' })
    assert.deepEqual(assessSessionArtifactDowngrade(v2, 'legacy-only'),
      { decision: 'block', reason: 'target-cannot-read-v2' })
    assert.deepEqual(assessSessionArtifactDowngrade(v2, 'stable-v1'),
      { decision: 'block', reason: 'target-cannot-read-v2' })
    assert.deepEqual(assessSessionArtifactDowngrade(v1, 'stable-v1'),
      { decision: 'allow', reason: 'format-recognized' })
    assert.deepEqual(assessSessionArtifactDowngrade(v2, 'stable-v2'),
      { decision: 'allow', reason: 'format-recognized' })
    const report = inspectDshDowngradeSafety({ dshHome: f.dir, target: 'stable-v1' })
    assert.equal(report.scanned, 2)
    assert.equal(report.blocked, 1)
    assert.equal(report.decision, 'block')
    assert.equal(JSON.stringify(report).includes('PRIVATE_SESSION'), false)
    assert.equal(JSON.stringify(report).includes(f.dir), false)
    assert.equal(JSON.stringify(report).includes(v2), false)
    assert.deepEqual(readFileSync(v1), Buffer.from(readFileSync(v1)),
      'an inspection is strictly read-only')
  } finally { f.close() }
})

test('#865: a missing format witness is UNKNOWN even when target supports v2', () => {
  const f = fixture()
  try {
    f.add('unwitnessed', 'unwitnessed')
    const report = inspectDshDowngradeSafety({ dshHome: f.dir, target: 'stable-v2' })
    assert.equal(report.scanned, 1)
    assert.equal(report.unknown, 1)
    assert.equal(report.decision, 'unknown')
  } finally { f.close() }
})

test('#865: a damaged Zstd frame is not guessed legacy or approved for rollback', () => {
  const f = fixture()
  try {
    const file = f.add('broken', 'stable-v2', true)
    const good = readFileSync(file)
    writeFileSync(file, good.subarray(0, good.length - 1))
    const report = inspectDshDowngradeSafety({ dshHome: f.dir, target: 'stable-v2' })
    assert.equal(report.scanned, 1)
    assert.equal(report.unreadable, 1)
    assert.equal(report.decision, 'block')
    assert.throws(() => assessSessionArtifactDowngrade(file, 'stable-v2'))
  } finally { f.close() }
})

test('#865: unreadable or missing local Session storage never produces an unconditional allow', () => {
  const f = fixture()
  try {
    rmSync(f.sessions, { recursive: true, force: true })
    const report = inspectDshDowngradeSafety({ dshHome: f.dir, target: 'stable-v2' })
    assert.equal(report.decision, 'unknown')
    assert.equal(report.reason, 'session-store-unavailable')
    assert.throws(() => inspectDshDowngradeSafety({ dshHome: f.dir, target: 'some-old-version' }))
  } finally { f.close() }
})

test('#865: file length limit rejects huge Session without parsing private text', () => {
  const f = fixture()
  try {
    const file = f.add('bounded', 'stable-v1')
    assert.throws(() => assessSessionArtifactDowngrade(file, 'stable-v2', { maxLogBytes: 10 }),
      /bounded Session scan/)
    const report = inspectDshDowngradeSafety({ dshHome: f.dir, target: 'stable-v2', maxLogBytes: 10 })
    assert.equal(report.decision, 'block')
    assert.equal(report.unreadable, 1)
  } finally { f.close() }
})

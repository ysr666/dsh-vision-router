import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  inspectLegacySessionArtifact,
  isStructuredGuardStopEvent,
  repairLegacySessionLogs,
  scanZstdFrameRanges,
} from '../lib/legacy-session-repair.js'

const ZSTD_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }
const BUDGET_TEXT = '本轮视觉总时间预算已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。'

function header(id = 'session-a') {
  return { type: 'session', version: 0, id, createdAt: 1, delegationDepth: 0 }
}
function turnStart(seq = 0) { return { type: 'turn/start', seq, time: 1, data: { turn: 1 } } }
function guard(seq, id = 'vision-router-structured-guard-stop-1', text = BUDGET_TEXT) {
  return {
    type: 'user/message', seq, time: seq + 1,
    data: {
      role: 'user', id,
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-vision-router' },
    },
    surfaceOp: 'append',
  }
}
function turnEnd(seq) { return { type: 'turn/end', seq, time: seq + 1, data: { turn: 1, reason: { kind: 'completed' } } } }
function oldReminder(seq = 1) {
  return {
    type: 'user/message', seq, time: seq + 1,
    data: {
      role: 'user',
      content: [{ type: 'text', text: '视觉深看工具已挂载：vision_describe。现在可以直接调用已启用的工具。' }],
      source: { kind: 'plugin', plugin: 'dsh-vision-router' },
    },
    surfaceOp: 'append',
  }
}
function fixture(filename = 'session.jsonl') {
  const home = mkdtempSync(path.join(tmpdir(), 'vr-session-'))
  const dir = path.join(home, 'sessions', '--project--', 'session-a')
  mkdirSync(dir, { recursive: true })
  return { home, file: path.join(dir, filename) }
}
function raw(events, customHeader = header()) { return [JSON.stringify(customHeader), ...events.map(JSON.stringify), ''].join('\n') }
function decodeAllEvents(buffer) {
  const scan = scanZstdFrameRanges(buffer)
  return scan.frames.slice(1)
    .map((range) => zstdDecompressSync(buffer.subarray(range.start, range.end)).toString('utf8'))
    .join('')
    .trimEnd().split('\n').filter(Boolean).map(JSON.parse)
}

test('structured guard matcher is deliberately exact', () => {
  assert.equal(isStructuredGuardStopEvent(guard(1)), true)
  assert.equal(isStructuredGuardStopEvent({ ...guard(1), data: { ...guard(1).data, source: { kind: 'plugin', plugin: 'other' } } }), false)
  assert.equal(isStructuredGuardStopEvent(guard(1, 'vision-router-structured-guard-stop-1', 'different text')), false)
})

test('raw repair preserves seq and gives later exact guard-stop duplicates deterministic unique ids', () => {
  const { home, file } = fixture()
  const original = raw([turnStart(), guard(1), guard(2), guard(3), turnEnd(4)])
  writeFileSync(file, original)

  const check = repairLegacySessionLogs({ dshHome: home, fix: false })
  assert.equal(check.affected, 2)
  const repaired = repairLegacySessionLogs({ dshHome: home, fix: true })
  assert.equal(repaired.ok, true)
  assert.equal(repaired.repaired, 1)
  assert.equal(existsSync(repaired.reports[0].backupPath), true)
  assert.equal(readFileSync(repaired.reports[0].backupPath, 'utf8'), original)

  const rows = readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse)
  const events = rows.slice(1)
  assert.deepEqual(events.map((row) => row.seq), [0, 1, 2, 3, 4])
  assert.equal(events[1].data.id, 'vision-router-structured-guard-stop-1')
  assert.equal(events[2].data.id, 'vision-router-recovered-structured-guard:session-a:2')
  assert.equal(events[3].data.id, 'vision-router-recovered-structured-guard:session-a:3')

  const second = repairLegacySessionLogs({ dshHome: home, fix: true })
  assert.equal(second.affected, 0)
  assert.equal(second.repaired, 0)
})

test('duplicate guard-stop detection works across separate Zstandard frames and preserves a DSH-valid contiguous seq stream', () => {
  const { file } = fixture('session.jsonl.zstd')
  const headerFrame = zstdCompressSync(`${JSON.stringify(header())}\n`, ZSTD_OPTIONS)
  const firstFrame = zstdCompressSync(`${JSON.stringify(turnStart())}\n${JSON.stringify(guard(1))}\n`, ZSTD_OPTIONS)
  const secondFrame = zstdCompressSync(`${JSON.stringify(guard(2))}\n${JSON.stringify(turnEnd(3))}\n`, ZSTD_OPTIONS)
  const original = Buffer.concat([headerFrame, firstFrame, secondFrame])
  writeFileSync(file, original)

  const report = inspectLegacySessionArtifact(file, { fix: true })
  assert.deepEqual(report.affectedSeqs, [2])
  const repaired = readFileSync(file)
  const scan = scanZstdFrameRanges(repaired)
  assert.deepEqual(repaired.subarray(scan.frames[0].start, scan.frames[0].end), headerFrame)
  assert.deepEqual(repaired.subarray(scan.frames[1].start, scan.frames[1].end), firstFrame)
  const events = decodeAllEvents(repaired)
  assert.deepEqual(events.map((row) => row.seq), [0, 1, 2, 3])
  assert.equal(events[2].data.id, 'vision-router-recovered-structured-guard:session-a:2')
})

test('one legitimate guard-stop message is not modified', () => {
  const { file } = fixture()
  const original = raw([turnStart(), guard(1), turnEnd(2)])
  writeFileSync(file, original)
  const report = inspectLegacySessionArtifact(file, { fix: true })
  assert.equal(report.repaired, false)
  assert.deepEqual(report.affectedSeqs, [])
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('duplicate guard id with a near-miss event fails closed instead of deleting data', () => {
  const { file } = fixture()
  const nearMiss = guard(2)
  nearMiss.data.content[0].text = 'user content that happens to reuse the old id'
  const original = raw([turnStart(), guard(1), nearMiss])
  writeFileSync(file, original)
  assert.throws(() => inspectLegacySessionArtifact(file, { fix: true }), /refusing automatic repair/)
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('legacy missing-id repair still works alongside the new repair registry', () => {
  const { home, file } = fixture()
  writeFileSync(file, raw([turnStart(), oldReminder(1), turnEnd(2)]))
  const report = repairLegacySessionLogs({ dshHome: home, fix: true })
  assert.equal(report.repaired, 1)
  const rows = readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse)
  assert.equal(rows[2].data.id, 'vision-router-recovered-auto-mount:session-a:1')
})

test('repair refuses unknown future session format versions', () => {
  const { file } = fixture()
  writeFileSync(file, raw([turnStart()], { ...header(), version: 1 }))
  assert.throws(() => inspectLegacySessionArtifact(file, { fix: true }), /unsupported session format version/)
})

test('recovered guard id collision fails closed without changing the source', () => {
  const { file } = fixture()
  const collision = {
    type: 'user/message', seq: 2, time: 3,
    data: { role: 'user', id: 'vision-router-recovered-structured-guard:session-a:3', content: [], source: { kind: 'plugin', plugin: 'other' } },
  }
  const original = raw([turnStart(), guard(1), collision, guard(3)])
  writeFileSync(file, original)
  assert.throws(() => inspectLegacySessionArtifact(file, { fix: true }), /collides with an existing message/)
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('repair refuses an already seq-gapped session instead of papering over unrelated corruption', () => {
  const { file } = fixture()
  writeFileSync(file, raw([turnStart(), guard(2)]))
  assert.throws(() => inspectLegacySessionArtifact(file, { fix: true }), /seq is not contiguous/)
})

test('repair understands packed chunk storage rows when validating contiguous seq', () => {
  const { file } = fixture()
  const packed = {
    type: 'text-chunks', seq0: 1, time0: 2,
    data: { turn: 1, step: 0, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] },
  }
  writeFileSync(file, raw([turnStart(), packed, guard(4), guard(5), turnEnd(6)]))
  const report = inspectLegacySessionArtifact(file, { fix: true })
  assert.deepEqual(report.affectedSeqs, [5])
})

test('legacy auto-mount recovery id collisions fail closed', () => {
  const { file } = fixture()
  const collision = {
    type: 'user/message', seq: 1, time: 2,
    data: { role: 'user', id: 'vision-router-recovered-auto-mount:session-a:2', content: [], source: { kind: 'plugin', plugin: 'other' } },
  }
  const original = raw([turnStart(), collision, oldReminder(2)])
  writeFileSync(file, original)
  assert.throws(() => inspectLegacySessionArtifact(file, { fix: true }), /collides with an existing message/)
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('repair refuses malformed current-version session headers before touching events', () => {
  const { file } = fixture()
  const malformed = { type: 'session', version: 0, id: 'session-a', createdAt: -1, delegationDepth: 0 }
  writeFileSync(file, raw([turnStart()], malformed))
  assert.throws(() => inspectLegacySessionArtifact(file, { fix: true }), /createdAt is invalid/)
})

test('read-only session scan treats an incomplete live tail as advisory', () => {
  const { home, file } = fixture()
  writeFileSync(file, raw([turnStart(), guard(1)]).slice(0, -1))
  const report = repairLegacySessionLogs({ dshHome: home, fix: false })
  assert.equal(report.ok, true)
  assert.equal(report.errors.length, 0)
  assert.equal(report.advisories.length, 1)
  assert.equal(report.advisories[0].kind, 'incomplete-live-tail')
})

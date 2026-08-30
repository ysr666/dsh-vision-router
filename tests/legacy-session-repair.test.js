import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'

import {
  inspectLegacySessionArtifact,
  isLegacyVisionRouterAutoMountEvent,
  repairLegacySessionLogs,
  scanZstdFrameRanges,
} from '../lib/legacy-session-repair.js'

const ZSTD_OPTIONS = {
  params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
}

function header(id = 'session-a') {
  return {
    type: 'session',
    version: 0,
    id,
    createdAt: 1,
    delegationDepth: 0,
  }
}

function oldReminder(seq = 1) {
  return {
    type: 'user/message',
    seq,
    time: 2,
    data: {
      role: 'user',
      content: [{
        type: 'text',
        text: '视觉深看工具已挂载：vision_describe、vision_ground。现在可以直接调用已启用的工具。',
      }],
      source: { kind: 'plugin', plugin: 'dsh-vision-router' },
    },
    surfaceOp: 'append',
  }
}

function fixturePath(filename) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-session-repair-'))
  const dir = path.join(home, 'sessions', '--project--', 'session-a')
  mkdirSync(dir, { recursive: true })
  return { home, file: path.join(dir, filename) }
}

function rawLog(events, id = 'session-a') {
  return [JSON.stringify(header(id)), ...events.map((event) => JSON.stringify(event)), ''].join('\n')
}

function decodeFrames(buffer) {
  const scan = scanZstdFrameRanges(buffer)
  assert.equal(scan.tornStart, undefined)
  return scan.frames.map((range) =>
    zstdDecompressSync(buffer.subarray(range.start, range.end)).toString('utf8'))
}

test('legacy matcher is deliberately limited to the old Vision Router auto-mount reminder', () => {
  assert.equal(isLegacyVisionRouterAutoMountEvent(oldReminder()), true)

  assert.equal(isLegacyVisionRouterAutoMountEvent({
    ...oldReminder(),
    data: { ...oldReminder().data, id: 'already-fixed' },
  }), false)
  assert.equal(isLegacyVisionRouterAutoMountEvent({
    ...oldReminder(),
    data: { ...oldReminder().data, source: { kind: 'plugin', plugin: 'someone-else' } },
  }), false)
  assert.equal(isLegacyVisionRouterAutoMountEvent({
    ...oldReminder(),
    data: {
      ...oldReminder().data,
      content: [{ type: 'text', text: 'unrelated plugin message' }],
    },
  }), false)
})

test('raw JSONL repair adds only the missing id, keeps a backup, and is idempotent', () => {
  const { home, file } = fixturePath('session.jsonl')
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    oldReminder(1),
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const original = rawLog(events)
  writeFileSync(file, original)

  const check = repairLegacySessionLogs({ dshHome: home, fix: false })
  assert.equal(check.scanned, 1)
  assert.equal(check.affected, 1)
  assert.equal(check.repaired, 0)
  assert.equal(readFileSync(file, 'utf8'), original)

  const repaired = repairLegacySessionLogs({ dshHome: home, fix: true })
  assert.equal(repaired.ok, true)
  assert.equal(repaired.repaired, 1)
  assert.deepEqual(repaired.reports[0].affectedSeqs, [1])
  assert.equal(existsSync(repaired.reports[0].backupPath), true)
  assert.equal(readFileSync(repaired.reports[0].backupPath, 'utf8'), original)

  const lines = readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines[2].data.id, 'vision-router-recovered-auto-mount:session-a:1')
  assert.equal(lines[2].data.role, 'user')
  assert.deepEqual(lines[2].data.source, { kind: 'plugin', plugin: 'dsh-vision-router' })
  assert.deepEqual(lines[2].data.content, oldReminder(1).data.content)

  const second = repairLegacySessionLogs({ dshHome: home, fix: true })
  assert.equal(second.repaired, 0)
  assert.equal(second.affected, 0)
  assert.equal(second.errors.length, 0)
})

test('default Zstandard session logs are repaired while unchanged frames stay byte-identical', () => {
  const { file } = fixturePath('session.jsonl.zstd')
  const headerFrame = zstdCompressSync(`${JSON.stringify(header())}\n`, ZSTD_OPTIONS)
  const firstBatchPlain = `${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`
  const firstBatchFrame = zstdCompressSync(firstBatchPlain, ZSTD_OPTIONS)
  const affectedBatchPlain = [
    JSON.stringify(oldReminder(1)),
    JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
    '',
  ].join('\n')
  const affectedBatchFrame = zstdCompressSync(affectedBatchPlain, ZSTD_OPTIONS)
  const original = Buffer.concat([headerFrame, firstBatchFrame, affectedBatchFrame])
  writeFileSync(file, original)

  const result = inspectLegacySessionArtifact(file, { fix: true })
  assert.equal(result.repaired, true)
  assert.deepEqual(result.affectedSeqs, [1])
  assert.equal(existsSync(result.backupPath), true)
  assert.deepEqual(readFileSync(result.backupPath), original)

  const repairedBytes = readFileSync(file)
  const repairedScan = scanZstdFrameRanges(repairedBytes)
  assert.equal(repairedScan.frames.length, 3)
  assert.deepEqual(
    repairedBytes.subarray(repairedScan.frames[0].start, repairedScan.frames[0].end),
    headerFrame,
    'header frame should stay byte-identical',
  )
  assert.deepEqual(
    repairedBytes.subarray(repairedScan.frames[1].start, repairedScan.frames[1].end),
    firstBatchFrame,
    'unaffected event frame should stay byte-identical',
  )

  const frames = decodeFrames(repairedBytes)
  const repairedEvents = frames.slice(1).join('').trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(repairedEvents[1].data.id, 'vision-router-recovered-auto-mount:session-a:1')
  assert.equal(repairedEvents[2].type, 'turn/end')
})

test('near-miss malformed messages are reported as untouched instead of being papered over', () => {
  const { file } = fixturePath('session.jsonl')
  const unrelated = {
    ...oldReminder(1),
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'another plugin forgot an id' }],
      source: { kind: 'plugin', plugin: 'other-plugin' },
    },
  }
  const original = rawLog([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    unrelated,
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  writeFileSync(file, original)

  const result = inspectLegacySessionArtifact(file, { fix: true })
  assert.equal(result.repaired, false)
  assert.deepEqual(result.affectedSeqs, [])
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('repair refuses a torn raw log instead of discarding the unfinished tail', () => {
  const { file } = fixturePath('session.jsonl')
  const torn = rawLog([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    oldReminder(1),
  ]).slice(0, -1)
  writeFileSync(file, torn)
  assert.throws(
    () => inspectLegacySessionArtifact(file, { fix: true }),
    /incomplete final record/,
  )
  assert.equal(readFileSync(file, 'utf8'), torn)
})

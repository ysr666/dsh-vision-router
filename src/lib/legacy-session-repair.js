import {
  closeSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const DEFAULT_MAX_LOG_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_FRAME_PLAINTEXT_BYTES = 128 * 1024 * 1024
const SESSION_FILENAMES = new Set(['session.jsonl', 'session.jsonl.zstd'])
const REMINDER_PREFIX = '视觉深看工具已挂载：'
const GUARD_STOP_ID = /^vision-router-structured-guard-stop-(?:\d+|undefined)$/
const GUARD_STOP_TEXTS = new Set([
  '本轮视觉总时间预算已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。',
  '本轮识图深度配额已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。',
])
const CHECKSUM_OPTIONS = {
  params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableRepairId(sessionId, seq) {
  return `vision-router-recovered-auto-mount:${sessionId}:${seq}`
}

export function isLegacyVisionRouterAutoMountEvent(event) {
  if (!isRecord(event) || event.type !== 'user/message') return false
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) return false
  const data = event.data
  if (!isRecord(data) || Object.hasOwn(data, 'id') || data.role !== 'user') return false
  if (Object.keys(data).some((key) => !['role', 'content', 'source'].includes(key))) return false
  if (!Array.isArray(data.content) || !isRecord(data.source)) return false
  if (data.source.kind !== 'plugin' || data.source.plugin !== 'dsh-vision-router') return false
  return data.content.some((block) =>
    isRecord(block)
      && block.type === 'text'
      && typeof block.text === 'string'
      && block.text.startsWith(REMINDER_PREFIX),
  )
}

export function repairLegacyVisionRouterEvent(event, sessionId) {
  if (!isLegacyVisionRouterAutoMountEvent(event)) return event
  return {
    ...event,
    data: {
      ...event.data,
      id: stableRepairId(sessionId, event.seq),
    },
  }
}

export function isStructuredGuardStopEvent(event) {
  if (!isRecord(event) || event.type !== 'user/message') return false
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) return false
  const data = event.data
  if (!isRecord(data) || data.role !== 'user' || typeof data.id !== 'string' || !GUARD_STOP_ID.test(data.id)) return false
  if (Object.keys(data).some((key) => !['id', 'role', 'content', 'source'].includes(key))) return false
  if (!isRecord(data.source) || data.source.kind !== 'plugin' || data.source.plugin !== 'dsh-vision-router') return false
  if (!Array.isArray(data.content) || data.content.length !== 1) return false
  const block = data.content[0]
  if (!isRecord(block) || Object.keys(block).some((key) => !['type', 'text'].includes(key))) return false
  return block.type === 'text' && typeof block.text === 'string' && GUARD_STOP_TEXTS.has(block.text)
}

function guardStopSignature(event) {
  if (!isStructuredGuardStopEvent(event)) return undefined
  return { id: event.data.id, text: event.data.content[0].text }
}

export function scanZstdFrameRanges(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function parseHeaderLine(line) {
  let header
  try {
    header = JSON.parse(line)
  } catch {
    throw new Error('session header is not valid JSON')
  }
  if (!isRecord(header) || header.type !== 'session') {
    throw new Error('session header is not a session record')
  }
  if (header.version !== 0) {
    throw new Error(`unsupported session format version ${String(header.version)}; refusing automatic repair`)
  }
  if (typeof header.id !== 'string' || header.id === '') {
    throw new Error('session header does not contain a valid id')
  }
  if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
    throw new Error('session header createdAt is invalid')
  }
  if (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0) {
    throw new Error('session header delegationDepth is invalid')
  }
  return header
}

function messageIdOf(row) {
  if (!isRecord(row)) return undefined
  if (row.type === 'user/message') return typeof row.data?.id === 'string' ? row.data.id : undefined
  if (row.type === 'assistant/message' || row.type === 'tool/result') {
    return typeof row.data?.message?.id === 'string' ? row.data.message.id : undefined
  }
  return undefined
}

function packedRowMemberCount(row) {
  if (!isRecord(row)) return undefined
  const payload = row.type === 'tool-call-chunks' ? row.data?.args
    : row.type === 'text-chunks' || row.type === 'reasoning-chunks' ? row.data?.texts
      : undefined
  if (payload === undefined) return undefined
  if (!Number.isSafeInteger(row.seq0) || row.seq0 < 0 || !Number.isSafeInteger(row.time0)) {
    throw new Error(`malformed ${row.type} storage row envelope`)
  }
  if (!isRecord(row.data) || !Array.isArray(payload) || payload.length === 0 || payload.some((v) => typeof v !== 'string')) {
    throw new Error(`malformed ${row.type} storage row payload`)
  }
  if (!Array.isArray(row.data.dt) || row.data.dt.length !== payload.length - 1 || row.data.dt.some((v) => !Number.isSafeInteger(v))) {
    throw new Error(`malformed ${row.type} storage row timestamp gaps`)
  }
  if (!Number.isSafeInteger(row.seq0 + payload.length - 1)) {
    throw new Error(`malformed ${row.type} storage row seq range`)
  }
  return payload.length
}

function seqRangeOfStorageRow(row) {
  const packed = packedRowMemberCount(row)
  if (packed !== undefined) return { first: row.seq0, last: row.seq0 + packed - 1 }
  if (!isRecord(row) || !Number.isSafeInteger(row.seq) || row.seq < 0) {
    throw new Error('session storage record has an invalid seq')
  }
  return { first: row.seq, last: row.seq }
}

function parseEventLines(text, { frameLabel = 'session frame' } = {}) {
  if (!text.endsWith('\n')) throw new Error(`logical ${frameLabel} ends with a torn JSONL record`)
  const rows = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]
    if (line === '') continue
    try {
      rows.push({ line, row: JSON.parse(line) })
    } catch {
      throw new Error(`${frameLabel} event line ${index + 1} is not valid JSON`)
    }
  }
  return rows
}

function scanRows(frames) {
  let expectedSeq = 0
  const usedIds = new Map()
  const guardFirst = new Map()
  const eventsBySeq = new Map()
  for (const rows of frames) {
    for (const item of rows) {
      const row = item.row
      const range = seqRangeOfStorageRow(row)
      if (range.first !== expectedSeq) {
        throw new Error(`session seq is not contiguous: expected ${expectedSeq}, got ${range.first}`)
      }
      expectedSeq = range.last + 1
      if (packedRowMemberCount(row) !== undefined) continue

      const id = messageIdOf(row)
      if (id) {
        const existing = usedIds.get(id)
        if (!existing) usedIds.set(id, { seq: row.seq, row })
        else if (existing.seq !== row.seq) {
          const firstExact = isStructuredGuardStopEvent(existing.row)
          const nextExact = isStructuredGuardStopEvent(row)
          const sameKnownGuard = firstExact && nextExact
            && existing.row.data.content[0].text === row.data.content[0].text
            && GUARD_STOP_ID.test(id)
          if (!sameKnownGuard) {
            throw new Error(`duplicate message id ${id} is not the exact known Vision Router guard corruption; refusing automatic repair`)
          }
        }
      }
      if (isStructuredGuardStopEvent(row) && !guardFirst.has(row.data.id)) {
        guardFirst.set(row.data.id, { seq: row.seq, text: row.data.content[0].text })
      }
      eventsBySeq.set(row.seq, row)
    }
  }
  return { usedIds, guardFirst, eventsBySeq }
}

function generatedGuardRepairId(sessionId, seq) {
  return `vision-router-recovered-structured-guard:${sessionId}:${seq}`
}

function assertGeneratedIdAvailable(id, seq, state) {
  const collision = state.usedIds.get(id)
  if (collision && collision.seq !== seq) {
    throw new Error(`recovered Vision Router message id ${id} collides with an existing message; refusing automatic repair`)
  }
  state.usedIds.set(id, { seq })
}

function repairStorageRows(rows, sessionId, state) {
  const output = []
  const changedSeqs = []
  const repairs = []
  for (const item of rows) {
    let row = item.row
    const originalLine = item.line

    if (isLegacyVisionRouterAutoMountEvent(row)) {
      const id = stableRepairId(sessionId, row.seq)
      assertGeneratedIdAvailable(id, row.seq, state)
      row = repairLegacyVisionRouterEvent(row, sessionId)
      changedSeqs.push(row.seq)
      repairs.push({ kind: 'legacy-auto-mount-id', seq: row.seq })
    }

    if (isStructuredGuardStopEvent(row)) {
      const first = state.guardFirst.get(row.data.id)
      if (first && first.seq !== row.seq) {
        if (first.text !== row.data.content[0].text) {
          throw new Error(`duplicate Vision Router guard id ${row.data.id} changed text; refusing automatic repair`)
        }
        const oldId = row.data.id
        const newId = generatedGuardRepairId(sessionId, row.seq)
        assertGeneratedIdAvailable(newId, row.seq, state)
        row = { ...row, data: { ...row.data, id: newId } }
        changedSeqs.push(row.seq)
        repairs.push({ kind: 'duplicate-structured-guard-stop', seq: row.seq })
      }
    }

    output.push(row === item.row ? originalLine : JSON.stringify(row))
  }
  return { text: `${output.join('\n')}\n`, changedSeqs, repairs }
}

function inspectRawArtifact(buffer) {
  const text = buffer.toString('utf8')
  if (!text.endsWith('\n')) {
    throw new Error('raw session log has an incomplete final record; let DSH finish crash recovery first')
  }
  const newline = text.indexOf('\n')
  if (newline < 0) throw new Error('raw session log has no header line')
  const header = parseHeaderLine(text.slice(0, newline))
  const rows = parseEventLines(text.slice(newline + 1), { frameLabel: 'raw session log' })
  const state = scanRows([rows])
  const repaired = repairStorageRows(rows, header.id, state)
  const output = repaired.changedSeqs.length === 0
    ? buffer
    : Buffer.from(`${text.slice(0, newline + 1)}${repaired.text}`, 'utf8')
  return { sessionId: header.id, output, changedSeqs: repaired.changedSeqs, repairs: repaired.repairs }
}

function decodeZstdFrame(buffer, range, maxOutputLength) {
  return zstdDecompressSync(buffer.subarray(range.start, range.end), { maxOutputLength })
}

function inspectZstdArtifact(buffer, maxFramePlaintextBytes) {
  const scan = scanZstdFrameRanges(buffer)
  if (scan.tornStart !== undefined) {
    throw new Error('Zstandard session log has an incomplete final frame; let DSH finish crash recovery first')
  }
  if (scan.frames.length === 0) throw new Error('Zstandard session log has no header frame')

  const headerPlain = decodeZstdFrame(buffer, scan.frames[0], maxFramePlaintextBytes)
  const headerText = headerPlain.toString('utf8')
  if (!headerText.endsWith('\n') || headerText.indexOf('\n') !== headerText.length - 1) {
    throw new Error('Zstandard session header frame is not exactly one JSONL line')
  }
  const header = parseHeaderLine(headerText.slice(0, -1))

  const decoded = scan.frames.slice(1).map((frame, index) => {
    const plain = decodeZstdFrame(buffer, frame, maxFramePlaintextBytes)
    return {
      frame,
      rows: parseEventLines(plain.toString('utf8'), { frameLabel: `Zstandard frame ${index + 1}` }),
    }
  })
  const state = scanRows(decoded.map((item) => item.rows))
  const chunks = [buffer.subarray(scan.frames[0].start, scan.frames[0].end)]
  const changedSeqs = []
  const repairs = []
  for (const item of decoded) {
    const original = buffer.subarray(item.frame.start, item.frame.end)
    const repaired = repairStorageRows(item.rows, header.id, state)
    changedSeqs.push(...repaired.changedSeqs)
    repairs.push(...repaired.repairs)
    chunks.push(repaired.changedSeqs.length === 0
      ? original
      : zstdCompressSync(Buffer.from(repaired.text, 'utf8'), CHECKSUM_OPTIONS))
  }

  return {
    sessionId: header.id,
    output: changedSeqs.length === 0 ? buffer : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    changedSeqs,
    repairs,
  }
}

function fileIdentity(filePath) {
  const identity = statSync(filePath, { bigint: true })
  return {
    dev: identity.dev,
    ino: identity.ino,
    size: identity.size,
    mtimeNs: identity.mtimeNs,
    ctimeNs: identity.ctimeNs,
    mode: identity.mode,
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function writeSyncedFile(filePath, bytes, mode) {
  const fd = openSync(filePath, 'wx', Number(mode & 0o777n))
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function backupPathFor(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${filePath}.vision-router-backup-${stamp}-${randomBytes(3).toString('hex')}`
}

function temporaryPathFor(filePath) {
  return `${filePath}.vision-router-repair-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
}

export function inspectLegacySessionArtifact(filePath, {
  fix = false,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  maxFramePlaintextBytes = DEFAULT_MAX_FRAME_PLAINTEXT_BYTES,
} = {}) {
  const before = fileIdentity(filePath)
  if (before.size > BigInt(maxLogBytes)) {
    throw new Error(`session log exceeds the ${maxLogBytes}-byte offline repair limit`)
  }
  const input = readFileSync(filePath)
  const zstd = filePath.endsWith('.zstd')
  const inspected = zstd
    ? inspectZstdArtifact(input, maxFramePlaintextBytes)
    : inspectRawArtifact(input)

  if (!fix || inspected.changedSeqs.length === 0) {
    return {
      path: filePath,
      sessionId: inspected.sessionId,
      encoding: zstd ? 'zstd' : 'none',
      affectedSeqs: inspected.changedSeqs,
      repairs: inspected.repairs,
      repaired: false,
    }
  }

  const latest = fileIdentity(filePath)
  if (!sameIdentity(before, latest)) {
    throw new Error('session log changed while it was being inspected; stop DSH and retry')
  }

  const backupPath = backupPathFor(filePath)
  const tempPath = temporaryPathFor(filePath)
  copyFileSync(filePath, backupPath, fsConstants.COPYFILE_EXCL)
  try {
    writeSyncedFile(tempPath, inspected.output, before.mode)
    const rightBeforeReplace = fileIdentity(filePath)
    if (!sameIdentity(before, rightBeforeReplace)) {
      throw new Error('session log changed before replacement; stop DSH and retry')
    }
    renameSync(tempPath, filePath)
    const verified = inspectLegacySessionArtifact(filePath, {
      fix: false,
      maxLogBytes,
      maxFramePlaintextBytes,
    })
    if (verified.affectedSeqs.length !== 0) {
      throw new Error('repaired session log still contains a known Vision Router corruption signature')
    }
  } catch (error) {
    rmSync(tempPath, { force: true })
    try {
      copyFileSync(backupPath, filePath)
    } catch {
      // Preserve the original error; the backup path is included below.
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message} (backup: ${backupPath})`)
  }

  return {
    path: filePath,
    sessionId: inspected.sessionId,
    encoding: zstd ? 'zstd' : 'none',
    affectedSeqs: inspected.changedSeqs,
    repairs: inspected.repairs,
    repaired: true,
    backupPath,
  }
}

export function listSessionArtifacts(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return []
  const found = []
  const pending = [sessionsRoot]
  while (pending.length > 0) {
    const dir = pending.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(full)
        continue
      }
      if (entry.isFile() && SESSION_FILENAMES.has(entry.name)) found.push(full)
    }
  }
  return found.sort()
}

export function repairLegacySessionLogs({
  dshHome,
  fix = true,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  maxFramePlaintextBytes = DEFAULT_MAX_FRAME_PLAINTEXT_BYTES,
} = {}) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') {
    throw new TypeError('repairLegacySessionLogs requires dshHome')
  }
  const sessionsRoot = path.join(dshHome, 'sessions')
  const artifacts = listSessionArtifacts(sessionsRoot)
  const reports = []
  const errors = []
  const advisories = []
  for (const filePath of artifacts) {
    try {
      const report = inspectLegacySessionArtifact(filePath, { fix, maxLogBytes, maxFramePlaintextBytes })
      if (report.affectedSeqs.length > 0 || report.repaired) reports.push(report)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const incompleteLiveTail = !fix && /(?:incomplete final record|incomplete final frame|torn JSONL record)/i.test(message)
      if (incompleteLiveTail) advisories.push({ path: filePath, kind: 'incomplete-live-tail' })
      else errors.push({ path: filePath, error: message })
    }
  }
  return {
    sessionsRoot,
    exists: existsSync(sessionsRoot),
    scanned: artifacts.length,
    affected: reports.reduce((sum, item) => sum + item.affectedSeqs.length, 0),
    repaired: reports.filter((item) => item.repaired).length,
    reports,
    errors,
    advisories,
    ok: errors.length === 0,
  }
}

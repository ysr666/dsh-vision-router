import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'

const LIMIT_LINE = /vision-router: effective vision limits\s+taskTimeoutMs=(\d+)\s+taskSource=([^\s]+)\s+turnBudgetMs=(\d+)\s+turnSource=([^\s]+)/i
const EXHAUSTED_LINE = /vision-router: vision turn deadline exhausted\s+turn=([^\s]+)\s+budgetMs=(\d+)\s+elapsedMs=([^\s]+)/i

function readTail(file, maxBytes = 2 * 1024 * 1024) {
  if (!file || !existsSync(file)) return ''
  let fd
  try {
    const stat = statSync(file)
    const size = Math.min(stat.size, maxBytes)
    if (size <= 0) return ''
    const buffer = Buffer.alloc(size)
    fd = openSync(file, 'r')
    readSync(fd, buffer, 0, size, Math.max(0, stat.size - size))
    return buffer.toString('utf8')
  } catch {
    try { return readFileSync(file, 'utf8') } catch { return '' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function parseVisionLimitLog(text) {
  let latest
  let latestExhaustion
  for (const line of String(text || '').split(/\r?\n/)) {
    const limit = LIMIT_LINE.exec(line)
    if (limit) {
      latest = {
        taskTimeoutMs: Number(limit[1]),
        taskSource: limit[2],
        turnBudgetMs: Number(limit[3]),
        turnSource: limit[4],
      }
    }
    const exhausted = EXHAUSTED_LINE.exec(line)
    if (exhausted) {
      latestExhaustion = {
        turn: exhausted[1],
        budgetMs: Number(exhausted[2]),
        elapsedMs: exhausted[3] === 'unknown' ? undefined : Number(exhausted[3]),
      }
    }
  }
  if (!latest && !latestExhaustion) return undefined
  return {
    ...latest,
    latestExhaustion,
    explicitTurnLimit: Number(latest?.turnBudgetMs) > 0,
  }
}

export function inspectDoctorVisionLimits(logFile) {
  return parseVisionLimitLog(readTail(logFile))
}

export function formatDoctorVisionLimits(limits) {
  if (!limits) return []
  const task = Number.isFinite(limits.taskTimeoutMs) ? `${limits.taskTimeoutMs / 1000}s` : 'unknown'
  const turn = Number.isFinite(limits.turnBudgetMs)
    ? limits.turnBudgetMs === 0 ? 'unlimited' : `${limits.turnBudgetMs / 1000}s`
    : 'unknown'
  const lines = [
    `Vision task timeout: ${task}${limits.taskSource ? ` (${limits.taskSource})` : ''}`,
    `Vision turn deadline: ${turn}${limits.turnSource ? ` (${limits.turnSource})` : ''}`,
  ]
  if (limits.explicitTurnLimit) {
    lines.push('WARN: an explicit whole-turn vision deadline is active; v2 defaults to unlimited and long multi-image tasks may stop after this deadline.')
  }
  return lines
}

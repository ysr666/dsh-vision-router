import { legacySessionEvents } from './session-event-history-compat.js'

const MAX_ROWS = 20
const MAX_EVENTS = 10_000
function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : undefined
}
function usageRow(usage) {
  const input = count(usage?.inputTokens)
  const read = count(usage?.cacheReadTokens)
  const write = count(usage?.cacheWriteTokens)
  const output = count(usage?.outputTokens)
  const total = count(usage?.totalTokens)
  // Require the authoritative total to reconcile with DSH 0.2.2's disjoint
  // counters. Missing read must never be interpreted as zero.
  const prompt = total !== undefined && output !== undefined && total >= output
    ? total - output : undefined
  const reconciled = input !== undefined && read !== undefined &&
    (usage?.cacheWriteTokens === undefined || write !== undefined) &&
    prompt !== undefined && prompt > 0 &&
    Number.isSafeInteger(input + read + (write ?? 0)) &&
    input + read + (write ?? 0) === prompt
  return { input, read, write, output, total,
    hitPercent: reconciled ? Math.round(read / prompt * 1000) / 10 : undefined }
}

/** Manual Session-local diagnostic: do not copy message content, route
 * identifiers, account names, request IDs, or other raw provider fields. */
export function summarizeSessionCacheUsage(events) {
  if (!Array.isArray(events)) return undefined
  const recent = []
  let examined = 0
  for (let i = events.length - 1; i >= 0 && examined < MAX_EVENTS && recent.length < MAX_ROWS; i--) {
    examined++
    const event = events[i]
    if (event?.type !== 'assistant/message' || event.data?.interrupted === true) continue
    const data = event.data
    const source = data?.message?.source
    const route = source?.kind === 'model' && typeof source.provider === 'string' &&
      typeof source.model === 'string' && source.provider && source.model
      ? JSON.stringify([source.provider, source.model]) : undefined
    recent.push({ turn: count(data?.turn), step: count(data?.step), route, ...usageRow(data?.usage) })
  }
  const labels = new Map()
  const rows = recent.reverse().map(({ route, ...row }) => {
    if (route === undefined) return { ...row, route: '?' }
    if (!labels.has(route)) labels.set(route, 'R' + (labels.size + 1))
    return { ...row, route: labels.get(route) }
  })
  return { rows, truncated: examined < events.length }
}

function format(report) {
  const show = value => value === undefined ? '?' : String(value)
  return [
    'DVR cache usage · latest committed assistant responses',
    'turn/step | route | input | cache read | cache write | output | total | hit',
    ...report.rows.map(row =>
      [show(row.turn) + '/' + show(row.step), row.route, show(row.input),
        show(row.read), show(row.write), show(row.output), show(row.total),
        row.hitPercent === undefined ? '?' : row.hitPercent.toFixed(1) + '%'].join(' | ')),
    '',
    'Route labels are anonymous recorded routes, not proof of the actual upstream account.',
    '? = missing or unreconciled; 0 = explicitly reported zero.',
    'Hit = cache read / (total - output), only when disjoint counters reconcile.',
    'Committed non-interrupted main-Session responses only; excludes uncommitted retries and separate vision calls. Not billed cost.',
    report.truncated ? 'Bounded to the latest 20 responses / 10,000 events; earlier events omitted.' : 'No earlier events omitted by this report.',
  ].join('\n')
}

export function installSessionCacheUsageCommand(ctx) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['commands'], scope => {
    scope.commands.register({
      name: 'vision-cache',
      description: 'Show anonymous cache token counts for this Session without a model request',
      handler: ({ agent, rawInput, attachments, signal }) => {
        if (signal?.aborted) return { kind: 'error', text: 'Cache report was cancelled.' }
        if ((typeof rawInput === 'string' && rawInput.trim()) ||
            (Array.isArray(attachments) && attachments.length > 0)) {
          return { kind: 'error', text: 'Use /vision-cache without arguments or attachments.' }
        }
        const session = agent?.session
        if (typeof session?.id !== 'string' || !session.id || agent?.id !== session.id) {
          return { kind: 'error', text: 'Cache report requires the authorized active Session.' }
        }
        const report = summarizeSessionCacheUsage(legacySessionEvents(session))
        if (!report) return { kind: 'error', text: 'This Host does not expose a readable active Session history.' }
        return { kind: 'success', text: format(report) }
      },
    })
  })
}

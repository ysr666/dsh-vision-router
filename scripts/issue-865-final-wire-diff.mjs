// #865: compare TWO actual final, already-serialized DeepSeek request objects.
// Local-only forensic analysis. No network, credentials, provider calls or logs
// of prompts/tool arguments/images. Ephemeral HMAC-SHA256 digests here identify local JSON
// serialization differences; they are NOT DeepSeek cache-key proofs.
import { createHmac, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const MAX_INPUT_BYTES = 32 * 1024 * 1024
const HEADER_CLASSES = Object.freeze({
  model: ['model'],
  tools: ['tools', 'tool_choice', 'toolChoice'],
  system: ['system', 'system_prompt', 'systemPrompt'],
  reasoning: ['thinking', 'reasoning', 'reasoning_effort', 'reasoningEffort'],
})
const COMMON_FIELDS = new Set(Object.values(HEADER_CLASSES).flat())

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function json(value) {
  // JSON request shape is the input contract. Undefined is an absent property.
  return value === undefined ? undefined : JSON.stringify(value)
}
function digest(value, key) {
  const encoded = json(value)
  // Per-comparison ephemeral HMAC: users may share the structural report,
  // but a low-entropy prompt must not be dictionary-guessed from a plain hash.
  // The key is never exported, logged, persisted or included in the report.
  return encoded === undefined ? null : createHmac('sha256', key).update(encoded).digest('hex')
}
function different(left, right) { return json(left) !== json(right) }
function classifyMessage(message) {
  const role = message?.role
  if (role === 'system') return 'system'
  if (role === 'developer') {
    const blocks = Array.isArray(message.content) ? message.content : []
    if (blocks.some(x => x?.type === 'tool_addition' || x?.type === 'tool_removal' ||
      x?.type === 'tool-addition' || x?.type === 'tool-removal')) return 'tools'
    return 'system'
  }
  return 'history'
}
function modelInfo(record) {
  const route = record.upstream
  if (route === undefined) return undefined
  if (!object(route) || typeof route.provider !== 'string' || !route.provider ||
      typeof route.model !== 'string' || !route.model) {
    throw new TypeError('invalid upstream identity: provider and model required')
  }
  return route
}
function validate(record) {
  if (!object(record) || !object(record.wire) || !Array.isArray(record.wire.messages)) {
    throw new TypeError('expected {wire:{messages:[...]}, upstream?:{provider,model}}')
  }
  if (!record.wire.messages.every(object)) throw new TypeError('malformed final wire messages')
  return { wire: record.wire, upstream: modelInfo(record) }
}
function header(wire) {
  const { messages: _messages, ...rest } = wire
  return rest
}
function hasChangedClass(a, b, keys) {
  return keys.some(key => different(a[key], b[key]))
}
function changedUnknownHeader(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .some(key => !COMMON_FIELDS.has(key) && different(a[key], b[key]))
}

/**
 * Compare the previously serialized request against a later one. If the
 * previous messages are a true prefix and the header is unchanged, the local
 * JSON wire-prefix contract holds. This does NOT assert the provider cached it.
 *
 * Returned fields are strictly structural + ephemeral keyed digests, never content,
 * schema names, tool names, prompt excerpts, image bytes or provider IDs.
 * Source route identity is supplied explicitly; aliases are not invented.
 */
export function compareFinalWireRequests(beforeRecord, afterRecord) {
  const before = validate(beforeRecord)
  const after = validate(afterRecord)
  const a = before.wire
  const b = after.wire
  const reportKey = randomBytes(32)
  const ah = header(a)
  const bh = header(b)
  const older = a.messages
  const newer = b.messages
  let common = 0
  while (common < older.length && common < newer.length &&
         !different(older[common], newer[common])) common++
  const historyChanged = common < older.length
  const firstHistoricalDifference = historyChanged ? common : null
  const changed = {
    upstream: before.upstream && after.upstream
      ? before.upstream.provider !== after.upstream.provider ||
        before.upstream.model !== after.upstream.model : null,
    model: hasChangedClass(ah, bh, HEADER_CLASSES.model),
    tools: hasChangedClass(ah, bh, HEADER_CLASSES.tools),
    system: hasChangedClass(ah, bh, HEADER_CLASSES.system),
    reasoning: hasChangedClass(ah, bh, HEADER_CLASSES.reasoning),
    // A stable set of top-level values is not enough: reordering JSON keys
    // changes the actual native serializer byte sequence even when every
    // isolated field value compares equal.
    otherHeader: changedUnknownHeader(ah, bh) || different(ah, bh) &&
      !Object.values(HEADER_CLASSES).some(keys => hasChangedClass(ah, bh, keys)),
    history: historyChanged,
  }
  if (historyChanged) {
    const beforeClass = classifyMessage(older[common])
    const afterClass = classifyMessage(newer[common])
    if (beforeClass === 'tools' || afterClass === 'tools') changed.tools = true
    if (beforeClass === 'system' || afterClass === 'system') changed.system = true
  }
  const dimensions = Object.entries(changed).filter(([, state]) => state === true)
    .map(([key]) => key)
  const comparable = changed.upstream !== null
  const prefixPreserved = dimensions.length === 0
  return {
    schema: 'dvr-final-wire-diff-v1',
    upstreamComparable: comparable,
    changes: changed,
    changedDimensions: dimensions,
    // True is a wire-shape property, never a promise of provider cache hits.
    localSerializedPrefixPreserved: prefixPreserved,
    before: {
      historicalMessages: older.length,
      headerHmacSha256: digest(ah, reportKey),
      historyHmacSha256: digest(older, reportKey),
    },
    after: {
      messages: newer.length,
      appendedMessages: historyChanged ? null : newer.length - older.length,
      headerHmacSha256: digest(bh, reportKey),
      oldHistoryPrefixHmacSha256: digest(newer.slice(0, older.length), reportKey),
    },
    commonHistoricalMessages: common,
    firstDifferentHistoricalIndex: firstHistoricalDifference,
    firstDifferentHistoricalKind: historyChanged
      ? classifyMessage(older[common] ?? newer[common]) : null,
    limitations: [
      'Local JSON structural evidence, not a provider cache-key or actual paid cache-hit proof.',
      'Actual upstream identities are caller-supplied; missing identities are UNKNOWN.',
      'Tool permission or provider/model transitions may legitimately create a new cache baseline.',
    ],
  }
}

async function readRecord(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) {
    throw new TypeError('request fixture is not a regular file within bounded size')
  }
  return JSON.parse(await readFile(path, 'utf8'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--before' || args[2] !== '--after') {
    process.stderr.write('Usage: node scripts/issue-865-final-wire-diff.mjs --before <local.json> --after <local.json>\n')
    process.exitCode = 2
  } else {
    try {
      const before = await readRecord(args[1])
      const after = await readRecord(args[3])
      process.stdout.write(JSON.stringify(compareFinalWireRequests(before, after), null, 2) + '\n')
    } catch {
      // Never expose exception messages or file contents in logs.
      process.stderr.write('Local wire comparison failed; no request content was printed.\n')
      process.exitCode = 1
    }
  }
}

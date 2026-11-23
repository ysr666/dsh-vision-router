// #865 opt-in, offline comparison of sanitized live provider usage + billing exports.
// Does not send requests, touch credentials, log prompts, or infer billed cost.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SCHEMA = 'dvr-cache-ab-v1'
const LIMIT = 1000
const FIELDS = new Set([
  'case', 'trial', 'variant', 'call', 'routeTag', 'modelTag', 'usageSource',
  'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
  'totalTokens', 'billedCny', 'billingSource', 'wirePrefixSha256', 'usage',
])
const safeTag = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(x)
const natural = x => Number.isSafeInteger(x) && x >= 0 && x <= 1000000000
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x)
function fail(message) { throw new TypeError('Invalid sanitized cache A/B input: ' + message) }
function moneyMicros(x) {
  if (typeof x !== 'string' || !/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/.test(x)) fail('billedCny must be a nonnegative decimal string')
  const [whole, frac = ''] = x.split('.')
  const amount = Number(whole) * 1000000 + Number(frac.padEnd(6, '0'))
  if (amount > 10000 * 1000000) fail('billedCny exceeds the safe per-call bound')
  return amount
}
function fromNativeUsage(r) {
  const source = r.usageSource
  if (!['deepseek-messages-final', 'deepseek-chat-final'].includes(source)) {
    if (r.usage !== undefined) fail('nested usage requires explicit DeepSeek final format')
    return r
  }
  const usage = r.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) fail('DeepSeek final usage must be an object')
  if (['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','totalTokens'].some(k => r[k] !== undefined)) {
    fail('native and normalized usage fields must not be mixed')
  }
  const required = source === 'deepseek-messages-final'
    ? ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens']
    : ['prompt_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','completion_tokens','total_tokens']
  // The native final Usage objects are extensible. Official DeepSeek replies
  // may include service_tier, prompt_tokens_details, output_tokens_details and
  // server_tool_use alongside these counters. Validate REQUIRED arithmetic but
  // do not reject otherwise valid official responses for additional fields.
  // The entire original usage object is discarded below; it is never echoed to
  // the shareable report, so extensions cannot leak private content.
  if (required.some(k => !Object.prototype.hasOwnProperty.call(usage, k) || !natural(usage[k]))) {
    fail('DeepSeek final usage is missing a required valid numeric counter')
  }
  if (source === 'deepseek-chat-final' && usage.prompt_tokens_details !== undefined) {
    const detail = usage.prompt_tokens_details
    if (!detail || typeof detail !== 'object' || Array.isArray(detail) ||
        !natural(detail.cached_tokens) ||
        detail.cached_tokens !== usage.prompt_cache_hit_tokens) {
      fail('DeepSeek cached token detail contradicts final cache hit count')
    }
  }
  let numbers
  if (source === 'deepseek-messages-final') {
    if (usage.cache_creation_input_tokens !== 0) fail('unexpected DeepSeek cache creation count')
    numbers = {
      inputTokens: usage.input_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.cache_read_input_tokens +
        usage.cache_creation_input_tokens + usage.output_tokens,
    }
  } else {
    if (usage.prompt_tokens !== usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens ||
        usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) {
      fail('DeepSeek Chat completion usage does not reconcile')
    }
    numbers = {
      inputTokens: usage.prompt_cache_miss_tokens,
      cacheReadTokens: usage.prompt_cache_hit_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    }
  }
  const { usage: ignored, ...metadata } = r
  return { ...metadata, ...numbers }
}
function readRow(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('observation must be an object')
  if (Object.keys(r).some(k => !FIELDS.has(k))) fail('unknown field (potentially private data)')
  if (!safeTag(r.case) || !safeTag(r.routeTag) || !safeTag(r.modelTag)) fail('case/routeTag/modelTag must be opaque short tags')
  if (!natural(r.trial) || r.trial < 1 || r.trial > 100) fail('trial must be an integer in [1,100]')
  if (!['before', 'after'].includes(r.variant) || !['main', 'vision'].includes(r.call)) fail('variant/call must be known values')
  if (!['provider-response','provider-dashboard','deepseek-messages-final','deepseek-chat-final'].includes(r.usageSource)) fail('usageSource must identify the actual provider evidence')
  r = fromNativeUsage(r)
  for (const k of ['inputTokens','outputTokens','totalTokens']) if (!natural(r[k])) fail('invalid or missing token counter')
  for (const k of ['cacheReadTokens','cacheWriteTokens']) if (r[k] !== undefined && !natural(r[k])) fail('malformed cache counter')
  if (r.wirePrefixSha256 !== undefined && !hash(r.wirePrefixSha256)) fail('wire prefix digest must be SHA256')
  // The provider's total includes every explicit disjoint token category.
  // Reject impossible rows even when a missing cache field would otherwise
  // suppress only the hit percentage but still allow a billing comparison.
  const explicitTotal = r.inputTokens + r.outputTokens +
    (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0)
  if (!Number.isSafeInteger(explicitTotal) || explicitTotal > r.totalTokens) {
    fail('explicit token counters exceed provider total')
  }
  // When all disjoint categories were reported, there is no missing
  // component that could explain an additional unexplained token count.
  // Do not promote a contradictory full record to billed-cost evidence.
  if (r.cacheReadTokens !== undefined && r.cacheWriteTokens !== undefined &&
      explicitTotal !== r.totalTokens) {
    fail('complete disjoint token counters do not reconcile with provider total')
  }
  if (r.billedCny === undefined && r.billingSource !== undefined || r.billedCny !== undefined && r.billingSource !== 'provider-billing-export') fail('billed cost requires provider-billing-export evidence')
  return { ...r, costMicros: r.billedCny === undefined ? undefined : moneyMicros(r.billedCny) }
}
function combine(rows) {
  const sum = key => rows.reduce((n, r) => n + r[key], 0)
  const complete = rows.every(r => {
    const prompt = r.totalTokens - r.outputTokens
    return r.cacheReadTokens !== undefined && prompt > 0 &&
      prompt === r.inputTokens + r.cacheReadTokens + (r.cacheWriteTokens ?? 0)
  })
  const costComplete = rows.every(r => r.costMicros !== undefined)
  const input = sum('inputTokens')
  const read = complete ? sum('cacheReadTokens') : null
  const prompt = rows.reduce((n, r) => n + (r.totalTokens - r.outputTokens), 0)
  const costMicros = costComplete ? sum('costMicros') : null
  return { calls: rows.length, mainCalls: rows.filter(r => r.call === 'main').length,
    visionCalls: rows.filter(r => r.call === 'vision').length,
    uncachedInputTokens: input, cacheReadTokens: read,
    cacheHitPercent: complete && prompt > 0 ? Math.round(read / prompt * 1000) / 10 : null,
    billedCny: costMicros === null ? null : (costMicros / 1000000).toFixed(6),
    _costMicros: costMicros, _prompt: complete ? prompt : null }
}
function aggregate(pairs, side) {
  const rows = pairs.map(p => p[side])
  const sum = key => rows.reduce((s, r) => s + r[key], 0)
  const complete = rows.every(x => x.cacheReadTokens !== null)
  const moneyComplete = rows.every(x => x._costMicros !== null)
  const read = complete ? sum('cacheReadTokens') : null
  const prompt = complete ? sum('_prompt') : null
  const costMicros = moneyComplete ? sum('_costMicros') : null
  return {
    _costMicros: costMicros,
    calls: sum('calls'), mainCalls: sum('mainCalls'), visionCalls: sum('visionCalls'),
    uncachedInputTokens: sum('uncachedInputTokens'),
    cacheReadTokens: read,
    cacheHitPercent: prompt > 0 && read !== null ? Math.round(read / prompt * 1000) / 10 : null,
    billedCny: costMicros === null ? null : (costMicros / 1000000).toFixed(6),
  }
}
/** The caller must supply actual, redacted provider observations; no synthetic inference. */
export function compareCacheAB(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      Object.keys(document).some(k => !['schema','observations'].includes(k)) ||
      document.schema !== SCHEMA || !Array.isArray(document.observations) ||
      !document.observations.length || document.observations.length > LIMIT) fail('schema or observation count')
  const groups = new Map()
  for (const raw of document.observations) {
    const row = readRow(raw)
    const key = JSON.stringify([row.case, row.trial])
    let group = groups.get(key)
    if (!group) { group = { before: [], after: [] }; groups.set(key, group) }
    group[row.variant].push(row)
  }
  let incompletePairs = 0, mismatchedRoutes = 0, changedPrefixes = 0, unknownPrefixes = 0
  let referenceMainRoute
  const valid = []
  for (const group of groups.values()) {
    if (!group.before.length || !group.after.length) { incompletePairs++; continue }
    const identities = side => call => new Set(group[side].filter(r => r.call === call)
      .map(r => JSON.stringify([r.routeTag, r.modelTag])))
    const mainBefore = identities('before')('main')
    const mainAfter = identities('after')('main')
    const visionBefore = identities('before')('vision')
    const visionAfter = identities('after')('vision')
    const mainTag = mainBefore.size === 1 ? [...mainBefore][0] : undefined
    const visionTags = new Set([...visionBefore, ...visionAfter])
    if (!mainTag || mainAfter.size !== 1 || !mainAfter.has(mainTag) ||
        (visionBefore.size && visionAfter.size && visionTags.size !== 1) ||
        (referenceMainRoute !== undefined && mainTag !== referenceMainRoute)) {
      mismatchedRoutes++; continue
    }
    referenceMainRoute = mainTag
    const prefixes = ['before', 'after'].map(side => group[side].filter(r => r.call === 'main').map(r => r.wirePrefixSha256))
    if (prefixes[0].length === 1 && prefixes[1].length === 1 && prefixes.every(a => a[0] !== undefined)) {
      if (prefixes[0][0] !== prefixes[1][0]) changedPrefixes++
    } else unknownPrefixes++
    valid.push({ before: combine(group.before), after: combine(group.after) })
  }
  const before = valid.length ? aggregate(valid, 'before') : null
  const after = valid.length ? aggregate(valid, 'after') : null
  const moneyDelta = before?._costMicros === null || after?._costMicros === null || !valid.length
    ? null : after._costMicros - before._costMicros
  if (before) delete before._costMicros
  if (after) delete after._costMicros
  return { schema: SCHEMA, pairedTrials: valid.length,
    excluded: { incompletePairs, mismatchedRoutes },
    prefixComparison: { changedPairs: changedPrefixes, unknownPairs: unknownPrefixes,
      samePairs: valid.length - changedPrefixes - unknownPrefixes },
    before, after,
    deltas: valid.length ? {
      requests: after.calls - before.calls,
      uncachedInputTokens: after.uncachedInputTokens - before.uncachedInputTokens,
      cacheHitPercentagePoints: before.cacheHitPercent === null || after.cacheHitPercent === null
        ? null : Math.round((after.cacheHitPercent - before.cacheHitPercent) * 10) / 10,
      billedCny: moneyDelta === null ? null : (moneyDelta / 1000000).toFixed(6),
    } : null,
    limits: [
      'Input labels and provider export provenance are user supplied, not independently authenticated.',
      'Token cache read is not a billing statement. Money comparison needs provider-billing-export values on every included request.',
      'A changed wire prefix or unverified matching scenario prevents causal attribution to DVR alone.',
      'Reports include only submitted calls; missing vision/retry calls invalidate a full-cost conclusion.',
      'DeepSeek cache is best effort; few paired trials cannot establish generalizable savings.',
    ],
  }
}
export function formatCacheAB(report) {
  const show = x => x === null || x === undefined ? 'unknown' : String(x)
  const entry = (name, x) => name + ': ' + (x ? [
    'calls=' + x.calls + ' (main=' + x.mainCalls + ', vision=' + x.visionCalls + ')',
    'uncached-input=' + x.uncachedInputTokens,
    'cache-read=' + show(x.cacheReadTokens), 'hit=' + show(x.cacheHitPercent) + '%',
    'billed-CNY=' + show(x.billedCny),
  ].join(', ') : 'no comparable pairs')
  return [
    '# #865 actual provider cache A/B audit (local report)',
    'Comparable paired trials: ' + report.pairedTrials + '; incomplete: ' + report.excluded.incompletePairs + '; route/model mismatch: ' + report.excluded.mismatchedRoutes,
    'Wire prefix: same=' + report.prefixComparison.samePairs + ', changed=' + report.prefixComparison.changedPairs + ', unknown=' + report.prefixComparison.unknownPairs,
    entry('Before', report.before), entry('After', report.after),
    'Deltas (after-before): calls=' + show(report.deltas?.requests) + ', uncached-input=' + show(report.deltas?.uncachedInputTokens) + ', hit-pp=' + show(report.deltas?.cacheHitPercentagePoints) + ', billed-CNY=' + show(report.deltas?.billedCny),
    ...report.limits.map(x => '- ' + x),
  ].join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--input') {
    process.stderr.write('Usage: node scripts/issue-865-cache-ab-report.mjs --input <sanitized.json>\n')
    process.exitCode = 2
  } else {
    try {
      const { stat } = await import('node:fs/promises')
      if ((await stat(args[1])).size > 2_000_000) fail('file too large')
      const report = compareCacheAB(JSON.parse(await readFile(args[1], 'utf8')))
      process.stdout.write(formatCacheAB(report) + '\n')
    } catch (error) {
      process.stderr.write('Cache A/B report rejected input: ' + String(error?.message || 'invalid input') + '\n')
      process.exitCode = 1
    }
  }
}

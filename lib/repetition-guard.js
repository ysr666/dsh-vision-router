/**
 * Repetition-loop guard for vision backend output.
 *
 * Some vision backends occasionally degenerate into repetition loops when
 * asked for long constrained output (e.g. the structured-bootstrap JSON
 * schema) over a tall screenshot — the "answer" is one short phrase repeated
 * hundreds of times (observed in the wild as 「網絡路由器 互聯網 路由器…」
 * or 「華爲數據中心…」). Such output is useless to the agent and, worse,
 * it looks like a successful backend result, so the fallback chain never
 * runs. This module detects the signature of such loops so the vision chain
 * can treat them as backend failures and move to the next candidate.
 *
 * Detection is intentionally cheap and heuristic:
 *  - whitespace is stripped first, because loops are often separated by
 *    spaces/punctuation that vary;
 *  - a consecutive-run scan looks for one window repeated back-to-back
 *    (the classic loop shape);
 *  - a token-density check catches non-consecutive-but-overwhelming
 *    repetition (the "路由器 / 互聯網 路由器" alternation shape).
 */

export const REPETITION_LOOP_MARKER = 'vision backend returned a repetition loop'

/** Strip whitespace (and NBSP) so loops split by varying whitespace collapse. */
export function compactForRepetition(text) {
  return String(text ?? '').replace(/[\s\u00a0]+/gu, '')
}

const CANDIDATE_WINDOWS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40]

/**
 * @param {string} text raw backend output
 * @param {object} [options]
 * @param {number} [options.minRun=6] minimum consecutive repeats for a run
 * @param {number} [options.minCoveredChars=32] minimum chars a loop must cover
 * @param {number} [options.minCoveredRatio=0.35] minimum share of the text a
 *   consecutive run must cover (0..1)
 * @param {number} [options.maxWindow=40] largest window size to try
 * @returns {object|undefined} loop description, or undefined when healthy
 */
export function detectRepetitionLoop(text, options = {}) {
  const source = compactForRepetition(text)
  const total = source.length
  const minRun = options.minRun ?? 6
  const minCoveredChars = options.minCoveredChars ?? 32
  const minCoveredRatio = options.minCoveredRatio ?? 0.35
  const maxWindow = options.maxWindow ?? 40
  if (total < minCoveredChars) return undefined
  const coveredFloor = Math.max(minCoveredChars, total * minCoveredRatio)

  // Pass 0: exact period — the whole text is one phrase repeated, possibly
  // with a partial trailing repeat. Handles clean loops whose period is not
  // one of the candidate windows below.
  const maxPeriod = Math.min(64, Math.floor(total / 2))
  for (let period = 2; period <= maxPeriod; period++) {
    const full = Math.floor(total / period)
    const remainder = total % period
    if (full < minRun) continue
    const prefix = source.slice(0, period)
    let matches = true
    for (let block = 1; block < full; block++) {
      if (!source.startsWith(prefix, block * period)) {
        matches = false
        break
      }
    }
    if (matches && source.startsWith(prefix.slice(0, remainder), full * period)) {
      return {
        looped: true,
        mode: 'exact-period',
        window: prefix,
        windowSize: period,
        repetitions: full,
        coveredChars: full * period,
        totalChars: total,
        sample: source.slice(0, 120),
      }
    }
  }

  // Pass 1: one window repeated consecutively, back-to-back.
  for (const windowSize of CANDIDATE_WINDOWS) {
    if (windowSize > maxWindow || windowSize > Math.floor(total / 2)) continue
    let bestCount = 0
    let bestWindow = ''
    for (let i = 0; i + windowSize <= total; ) {
      const candidate = source.slice(i, i + windowSize)
      let count = 1
      let cursor = i + windowSize
      while (source.startsWith(candidate, cursor)) {
        count += 1
        cursor += windowSize
      }
      if (count > bestCount) {
        bestCount = count
        bestWindow = candidate
      }
      i = cursor
    }
    const covered = bestCount * windowSize
    if (bestCount >= minRun && covered >= coveredFloor) {
      return {
        looped: true,
        mode: 'consecutive-run',
        window: bestWindow,
        windowSize,
        repetitions: bestCount,
        coveredChars: covered,
        totalChars: total,
        sample: source.slice(0, 120),
      }
    }
  }

  // Pass 2: one short token dominating the text without being consecutive
  // (the alternating loop shape).
  for (const windowSize of [2, 3, 4]) {
    if (windowSize > maxWindow) continue
    const counts = new Map()
    for (let i = 0; i + windowSize <= total; i++) {
      const token = source.slice(i, i + windowSize)
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    let topToken = ''
    let topCount = 0
    for (const [token, count] of counts) {
      if (count > topCount) {
        topCount = count
        topToken = token
      }
    }
    const covered = topCount * windowSize
    if (topCount >= minRun && covered >= Math.max(minCoveredChars, total * 0.5)) {
      return {
        looped: true,
        mode: 'token-density',
        window: topToken,
        windowSize,
        repetitions: topCount,
        coveredChars: covered,
        totalChars: total,
        sample: source.slice(0, 120),
      }
    }
  }

  return undefined
}

/**
 * Throw when the output is a repetition loop. The thrown Error carries no
 * status/code, so the vision chain's classifier maps it by message pattern;
 * the message intentionally includes a stable marker for that classifier.
 */
export function assertNoRepetitionLoop(text, backendKey) {
  const loop = detectRepetitionLoop(text)
  if (loop === undefined) return
  const label = backendKey ? ` (${backendKey})` : ''
  throw new Error(
    `${REPETITION_LOOP_MARKER}${label}: ${loop.repetitions} repeats of ${JSON.stringify(loop.window)} ` +
      `(${loop.mode}) covering ${loop.coveredChars}/${loop.totalChars} chars; first ${loop.windowSize}-char window sampled from ${JSON.stringify(loop.sample)}`,
  )
}

/**
 * Repetition-loop guard for vision backend output.
 *
 * The guard targets language-generation loops, not legitimate OCR filler,
 * numeric tables or long machine data. Analysis is deliberately bounded so a
 * near-limit backend response cannot turn the detector itself into a memory
 * spike.
 */

export const REPETITION_LOOP_MARKER = 'vision backend returned a repetition loop'
export const DEFAULT_REPETITION_ANALYSIS_CHARS = 128 * 1024
export const DEFAULT_REPETITION_DENSITY_CHARS = 64 * 1024

/** Strip whitespace (and NBSP) so loops split by varying whitespace collapse. */
export function compactForRepetition(text) {
  return String(text ?? '').replace(/[\s\u00a0]+/gu, '')
}

/**
 * Bound analysis to front/middle/tail samples. NUL separators prevent a phrase
 * ending one sample and starting another from fabricating a consecutive run.
 */
export function sampleForRepetition(text, maxChars = DEFAULT_REPETITION_ANALYSIS_CHARS) {
  const source = String(text ?? '')
  const limit = Math.max(256, Math.floor(Number(maxChars) || DEFAULT_REPETITION_ANALYSIS_CHARS))
  if (source.length <= limit) return source
  const frontSize = Math.floor(limit * 0.5)
  const middleSize = Math.floor(limit * 0.25)
  const tailSize = Math.max(1, limit - frontSize - middleSize)
  const middleStart = Math.max(frontSize, Math.floor((source.length - middleSize) / 2))
  return [
    source.slice(0, frontSize),
    source.slice(middleStart, middleStart + middleSize),
    source.slice(-tailSize),
  ].join('\u0000')
}

const CANDIDATE_WINDOWS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40]

// Repetition failures seen from generative models contain words/ideographs.
// Pure digits/punctuation are common in OCR, matrices, serial numbers and
// telemetry, so those windows must not be treated as language loops.
function informativeWindow(value) {
  return /\p{L}/u.test(String(value ?? ''))
}

/**
 * @param {string} text raw backend output
 * @param {object} [options]
 * @param {number} [options.minRun=6] minimum consecutive repeats for a run
 * @param {number} [options.minCoveredChars=32] minimum chars a loop must cover
 * @param {number} [options.minCoveredRatio=0.35] minimum share of analyzed text
 * @param {number} [options.maxWindow=40] largest window size to try
 * @param {number} [options.maxAnalysisChars=131072] maximum sampled chars
 * @param {number} [options.maxDensityChars=65536] maximum density-map chars
 * @returns {object|undefined} loop description, or undefined when healthy
 */
export function detectRepetitionLoop(text, options = {}) {
  const sampled = sampleForRepetition(text, options.maxAnalysisChars)
  const source = compactForRepetition(sampled)
  const total = source.length
  const minRun = options.minRun ?? 6
  const minCoveredChars = options.minCoveredChars ?? 32
  const minCoveredRatio = options.minCoveredRatio ?? 0.35
  const maxWindow = options.maxWindow ?? 40
  if (total < minCoveredChars) return undefined
  const coveredFloor = Math.max(minCoveredChars, total * minCoveredRatio)

  // Pass 0: exact period. Require semantic characters so an OCR column made of
  // zeros/dashes is not mistaken for a model language loop.
  const maxPeriod = Math.min(64, Math.floor(total / 2))
  for (let period = 2; period <= maxPeriod; period++) {
    const full = Math.floor(total / period)
    const remainder = total % period
    if (full < minRun) continue
    const prefix = source.slice(0, period)
    if (!informativeWindow(prefix)) continue
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

  // Pass 1: one language-bearing window repeated consecutively, back-to-back.
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
      if (informativeWindow(candidate) && count > bestCount) {
        bestCount = count
        bestWindow = candidate
      }
      i = Math.max(i + 1, cursor)
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

  // Pass 2: one short language token dominating the text. Build maps only over
  // a bounded slice, so high-entropy megabyte responses have a fixed ceiling.
  const densityLimit = Math.max(
    256,
    Math.floor(Number(options.maxDensityChars) || DEFAULT_REPETITION_DENSITY_CHARS),
  )
  const densitySource = source.slice(0, densityLimit)
  const densityTotal = densitySource.length
  for (const windowSize of [2, 3, 4]) {
    if (windowSize > maxWindow) continue
    const counts = new Map()
    for (let i = 0; i + windowSize <= densityTotal; i++) {
      const token = densitySource.slice(i, i + windowSize)
      if (!informativeWindow(token)) continue
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
    if (topCount >= minRun && covered >= Math.max(minCoveredChars, densityTotal * 0.5)) {
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

/** Throw when the output is a repetition loop. */
export function assertNoRepetitionLoop(text, backendKey) {
  const loop = detectRepetitionLoop(text)
  if (loop === undefined) return
  const label = backendKey ? ` (${backendKey})` : ''
  throw new Error(
    `${REPETITION_LOOP_MARKER}${label}: ${loop.repetitions} repeats of ${JSON.stringify(loop.window)} ` +
      `(${loop.mode}) covering ${loop.coveredChars}/${loop.totalChars} analyzed chars; sampled from ${JSON.stringify(loop.sample)}`,
  )
}

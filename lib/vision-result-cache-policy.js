import { VISION_RESULT_CODES } from './vision-resilience.js'

const VISION_FAILURE_CODES = new Set(Object.values(VISION_RESULT_CODES))

function parsedResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Answer-cache publication guard.
 *
 * Vision Router's resilience layer returns infrastructure/control-plane
 * failures as structured tool results instead of throwing. Those results must
 * never become semantic image answers: turn memory and the circuit breaker own
 * failure state, while the answer cache owns only reusable visual knowledge.
 *
 * Match only the package's machine contract (`ok:false` + a known
 * `VISION_RESULT_CODES` value). Plain text that mentions errors, malformed JSON
 * and foreign `{ ok:false }` payloads are deliberately not guessed at here.
 */
export function isVisionControlPlaneFailureResult(value) {
  const result = parsedResult(value)
  return result?.ok === false && VISION_FAILURE_CODES.has(result.code)
}

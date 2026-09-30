import { randomBytes } from 'node:crypto'

const PROOF_PREFIX = 'VR-CODE:'
const PROOF_JSON_KEY = '_vr_code'
const PROOF_LINE_RE = /^\s*VR-CODE\s*:\s*([A-Z0-9-]{6,32})\s*$/i
const PROOF_PREFIX_LOOSE_RE = /\bVR\s*[-‐‑–—]?\s*CODE\b/i
const PROOF_LIKE_LINE_RE = /^\s*VR\s*[-‐‑–—]?\s*CODE\s*[:：]\s*[A-Z0-9-]{6,32}\s*$/i

function proofError(message = 'benchmark visual proof missing', diagnostic) {
  const suffix = diagnostic
    ? ` [vr-proof responseEmpty=${diagnostic.responseEmpty ? 1 : 0} prefixSeen=${diagnostic.prefixSeen ? 1 : 0} expectedCodeSeen=${diagnostic.expectedCodeSeen ? 1 : 0} proofLikeLineSeen=${diagnostic.proofLikeLineSeen ? 1 : 0}]`
    : ''
  const error = new Error(`${message}${suffix}`)
  error.code = 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED'
  error.benchmarkClass = 'visual-proof'
  if (diagnostic) error.proofDiagnostic = Object.freeze({ ...diagnostic })
  return error
}

function scoredFixture(fixture) {
  return !!fixture?.expected && typeof fixture.expected === 'object' && !Array.isArray(fixture.expected)
}

function jsonOnlyFixture(fixture) {
  return /\bonly\s+json\b/i.test(String(fixture?.prompt ?? ''))
}

function proofFailureDiagnostic(output, expectedChallenge) {
  const text = String(output ?? '')
  const expected = String(expectedChallenge ?? '').trim().toUpperCase()
  const normalized = text.replace(/\r\n?/g, '\n')
  return {
    responseEmpty: normalized.trim() === '',
    prefixSeen: PROOF_PREFIX_LOOSE_RE.test(normalized) || normalized.includes(`"${PROOF_JSON_KEY}"`),
    expectedCodeSeen: expected !== '' && normalized.toUpperCase().includes(expected),
    proofLikeLineSeen: normalized.split('\n').some((line) => PROOF_LIKE_LINE_RE.test(line)),
  }
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  const candidates = [trimmed]
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) candidates.push(fenced[1].trim())
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return undefined
}

function verifyAndStripJsonProof(output, expected) {
  const parsed = parseJsonObject(output)
  if (!parsed || typeof parsed[PROOF_JSON_KEY] !== 'string') return undefined
  if (parsed[PROOF_JSON_KEY].trim().toUpperCase() !== expected) return undefined
  const body = { ...parsed }
  delete body[PROOF_JSON_KEY]
  return JSON.stringify(body)
}

export function createBenchmarkVisualChallenge() {
  return randomBytes(6).toString('hex').toUpperCase()
}

export function hardenCapabilityBenchmarkFixture(fixture, challenge = createBenchmarkVisualChallenge()) {
  // The exact invoker is also exercised directly by low-level transport tests.
  // Visual proof is an evidence-integrity requirement for scored capability
  // fixtures, not a generic requirement for every exact transport call.
  if (!scoredFixture(fixture)) return { ...fixture }

  const code = String(challenge || '').trim().toUpperCase()
  if (!/^[A-Z0-9-]{6,32}$/.test(code)) throw new TypeError('invalid benchmark visual challenge')
  const svg = String(fixture?.svg ?? '')
  const overlay = [
    '<g data-vision-router-proof="1">',
    '<rect x="442" y="8" width="314" height="42" rx="7" fill="#111" opacity="0.92"/>',
    `<text x="456" y="36" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="18" fill="#fff">${PROOF_PREFIX}${code}</text>`,
    '</g>',
  ].join('')
  const hardenedSvg = svg.includes('</svg>') ? svg.replace('</svg>', `${overlay}</svg>`) : `${svg}${overlay}`
  const jsonProof = jsonOnlyFixture(fixture)
  const proofInstruction = jsonProof
    ? [
        'A small dark badge in the image contains benchmark verification metadata.',
        'The badge is not part of the task content: ignore it when extracting or scoring the requested document/UI data.',
        `Keep the response valid JSON only, but add one extra top-level string key named "${PROOF_JSON_KEY}" whose value is the code copied from the image badge after ${PROOF_PREFIX}.`,
        'Do not guess or infer that code from this instruction.',
      ].join(' ')
    : [
        'A small dark badge in the image contains benchmark verification metadata.',
        'The badge is not part of the task content: ignore it when following any transcription order, all-visible-text, answer-only, or no-prose requirement above.',
        `The sole exception to those output-format constraints is one final line exactly in the form ${PROOF_PREFIX}<code>, copying the code from the image.`,
        'Do not place the badge in the requested answer body, and do not guess or infer the code from this instruction.',
      ].join(' ')
  return {
    ...fixture,
    svg: hardenedSvg,
    prompt: `${String(fixture?.prompt ?? '').trim()}\n\n${proofInstruction}`.trim(),
    visualProofChallenge: code,
    visualProofMode: jsonProof ? 'json-field' : 'line',
  }
}

export function verifyAndStripBenchmarkVisualProof(output, expectedChallenge) {
  const expected = String(expectedChallenge ?? '').trim().toUpperCase()
  if (expected === '') return String(output ?? '')
  const jsonBody = verifyAndStripJsonProof(output, expected)
  if (jsonBody !== undefined) return jsonBody
  const text = String(output ?? '')
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let verified = false
  const body = []
  for (const line of lines) {
    const match = line.match(PROOF_LINE_RE)
    if (match && match[1].toUpperCase() === expected) {
      verified = true
      continue
    }
    body.push(line)
  }
  if (!verified) {
    throw proofError(
      'benchmark response did not prove that the generated image was actually inspected',
      proofFailureDiagnostic(text, expected),
    )
  }
  return body.join('\n').replace(/\s+$/, '')
}

export async function withHardDeadline(promiseLike, timeoutMs, message = 'capability benchmark timed out') {
  const ms = Math.max(1, Number(timeoutMs) || 1)
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promiseLike),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message)
          error.name = 'TimeoutError'
          error.code = 'CAPABILITY_BENCHMARK_TIMEOUT'
          reject(error)
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

import { randomBytes } from 'node:crypto'

const PROOF_PREFIX = 'VR-CODE:'
const PROOF_LINE_RE = /^\s*VR-CODE\s*:\s*([A-Z0-9-]{6,32})\s*$/i

function proofError(message = 'benchmark visual proof missing') {
  const error = new Error(message)
  error.code = 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED'
  error.benchmarkClass = 'visual-proof'
  return error
}

function scoredFixture(fixture) {
  return !!fixture?.expected && typeof fixture.expected === 'object' && !Array.isArray(fixture.expected)
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
    '<rect x="530" y="8" width="226" height="42" rx="7" fill="#111" opacity="0.92"/>',
    `<text x="542" y="36" font-family="Arial,Helvetica,sans-serif" font-size="18" fill="#fff">${PROOF_PREFIX}${code}</text>`,
    '</g>',
  ].join('')
  const hardenedSvg = svg.includes('</svg>') ? svg.replace('</svg>', `${overlay}</svg>`) : `${svg}${overlay}`
  const proofInstruction = [
    'A small dark badge in the image contains benchmark verification metadata.',
    'The badge is not part of the task content: ignore it when following any transcription order, all-visible-text, JSON-only, answer-only, or no-prose requirement above.',
    `The sole exception to those output-format constraints is one final line exactly in the form ${PROOF_PREFIX}<code>, copying the code from the image.`,
    'Do not place the badge in the requested answer body, and do not guess or infer the code from this instruction.',
  ].join(' ')
  return {
    ...fixture,
    svg: hardenedSvg,
    prompt: `${String(fixture?.prompt ?? '').trim()}\n\n${proofInstruction}`.trim(),
    visualProofChallenge: code,
  }
}

export function verifyAndStripBenchmarkVisualProof(output, expectedChallenge) {
  const expected = String(expectedChallenge ?? '').trim().toUpperCase()
  if (expected === '') return String(output ?? '')
  const lines = String(output ?? '').replace(/\r\n?/g, '\n').split('\n')
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
    throw proofError('benchmark response did not prove that the generated image was actually inspected')
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

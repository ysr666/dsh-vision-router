// Preload stub for offline release-state-machine tests.
// Install with: node --import tests/fixtures/registry-fetch-stub.mjs <script> ...
// RELEASE_TEST_SCENARIO = JSON array of steps, consumed in order, the last one repeats:
//   { "status": 200, "body": {...} } | { "throws": "message" }
// RELEASE_TEST_LOG = optional path receiving one request URL per line.
import { appendFileSync } from 'node:fs'

const steps = JSON.parse(process.env.RELEASE_TEST_SCENARIO ?? '[]')
const logPath = process.env.RELEASE_TEST_LOG
let index = 0

globalThis.fetch = async (url) => {
  const step = steps.length === 0 ? { status: 500 } : steps[Math.min(index, steps.length - 1)]
  index += 1
  if (logPath) appendFileSync(logPath, `${String(url)}\n`)
  if (step.throws) throw new Error(step.throws)
  const body = step.body === undefined ? '' : JSON.stringify(step.body)
  return new Response(body, {
    status: step.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

import {
  ERROR_RESPONSE_MAX_BYTES,
  readResponseJsonBounded,
  readResponseTextBounded,
} from '../../../src/lib/http-body-limit.js'

const textResult: Promise<string> = readResponseTextBounded(
  new Response('ok'),
  ERROR_RESPONSE_MAX_BYTES,
)
const jsonResult: Promise<unknown> = readResponseJsonBounded(
  new Response('{"ok":true}'),
  ERROR_RESPONSE_MAX_BYTES,
)

void textResult
void jsonResult

const synthetic = {
  headers: { get: (_name: string) => null },
  async text() { return 'synthetic' },
}
const syntheticResult: Promise<string> = readResponseTextBounded(synthetic, 1024)
void syntheticResult

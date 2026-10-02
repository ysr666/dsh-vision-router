import {
  directSessionAffinityHeaders,
  openCodeSessionAffinityHeaderForUrl,
  rawSessionIdentity,
  sessionIdentityOf,
  wireSessionAffinityId,
  type SessionAffinityErrorCode,
} from '../../../src/lib/session-affinity.js'
import {
  currentVisionSessionAffinityId,
  runWithVisionSessionAffinity,
  streamWithVisionSessionAffinity,
} from '../../../src/lib/session-affinity-runtime.js'

const raw: string | undefined = rawSessionIdentity('session-a')
const sessionId: string | undefined = sessionIdentityOf({ id: 'session-a' })
const wire: string | undefined = wireSessionAffinityId('session-a')
const headers: Record<string, string> = directSessionAffinityHeaders(
  { baseURL: 'https://opencode.ai/zen/go/v1' },
  'session-a',
)
const projected: string | undefined = openCodeSessionAffinityHeaderForUrl(
  'https://opencode.ai/zen/go/v1/responses',
  'session-a',
)

const syncResult: number = runWithVisionSessionAffinity('session-a', () => 42)
const asyncResult: Promise<number> = runWithVisionSessionAffinity(
  'session-a',
  async () => 42,
)

const stream = streamWithVisionSessionAffinity('session-a', () => ({
  async *[Symbol.asyncIterator]() {
    yield 'ok'
  },
}))

const current: string | undefined = currentVisionSessionAffinityId()

void raw
void sessionId
void wire
void headers
void projected
void syncResult
void asyncResult
void stream
void current

const errorCode: SessionAffinityErrorCode = 'OPENCODE_SESSION_INVALID'
void errorCode

// @ts-expect-error affinity errors expose only the two stable wire-contract codes
const invalidErrorCode: SessionAffinityErrorCode = 'OPENCODE_SESSION_TRUNCATED'
void invalidErrorCode

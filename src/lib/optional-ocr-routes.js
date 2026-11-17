import { randomBytes } from 'node:crypto'
import { isLocalUiRequest } from './web-capability-boundary.js'
import { mutateOptionalOcr, optionalOcrStatus } from './optional-ocr-engines.js'

export const OPTIONAL_OCR_ROUTE = '/_dsh/vision-router/local-ocr'
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
function respond(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}
async function archiveFromRequest(req) {
  const len = req.headers?.['content-length']
  if (len !== undefined && (!/^\d+$/.test(String(len)) || Number(len) > MAX_BUNDLE_BYTES))
    throw Error('bundle too large')
  if (String(req.headers?.['content-type'] ?? '').split(';')[0].trim() !== 'application/octet-stream')
    throw Error('expected a single binary OCR archive')
  const blocks = []
  let length = 0
  for await (const part of req) {
    length += part.length
    if (length > MAX_BUNDLE_BYTES) throw Error('bundle too large')
    blocks.push(part)
  }
  if (length < 128) throw Error('missing OCR bundle')
  return Buffer.concat(blocks, length)
}
export function installOptionalOcrRoutes(ctx, {
  statusReader = optionalOcrStatus,
  mutate = mutateOptionalOcr,
  tokenFactory = () => randomBytes(24).toString('base64url'),
} = {}) {
  if (!ctx || typeof ctx.inject !== 'function') return
  let token = tokenFactory()
  let inFlight = false
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: OPTIONAL_OCR_ROUTE,
      handler: async (req, res) => {
        if (!isLocalUiRequest(req)) return respond(res, 403, { ok: false, error: 'local DSH UI required' })
        if (req.method === 'GET') {
          try {
            const state = await statusReader()
            return respond(res, 200, { ...state, token })
          } catch {
            return respond(res, 500, { ok: false, error: 'local OCR status unavailable' })
          }
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST')
          return respond(res, 405, { ok: false, error: 'method not allowed' })
        }
        const fetchSite = String(req.headers?.['sec-fetch-site'] ?? '')
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')
          return respond(res, 403, { ok: false, error: 'cross-origin OCR operation rejected' })
        if (String(req.headers?.['x-dsh-vision-router-ocr-token'] ?? '') !== token || !token)
          return respond(res, 403, { ok: false, error: 'invalid OCR operation token' })
        let url
        try { url = new URL(req.url, 'http://localhost') }
        catch { return respond(res, 400, { ok: false, error: 'invalid request' }) }
        const engine = url.searchParams.get('engine')
        const action = url.searchParams.get('action')
        if (!['tesseract', 'ppocrv6'].includes(engine) || !['install', 'uninstall'].includes(action))
          return respond(res, 400, { ok: false, error: 'unsupported OCR operation' })
        if (inFlight) return respond(res, 409, { ok: false, error: 'OCR installation already running' })
        inFlight = true
        try {
          const archive = engine === 'ppocrv6' && action === 'install'
            ? await archiveFromRequest(req) : undefined
          const result = await mutate({ engine, action, archive })
          token = tokenFactory()
          return respond(res, 200, result)
        } catch (error) {
          const message = String(error?.message ?? '')
          const expected = /(?:missing|not installed|already exists|unavailable|busy|invalid|integrity|unsupported|untrusted|not approved|too large|OCR bundle|unowned|refusing|timed out|failed|mismatch)/i.test(message)
          return respond(res, expected ? 409 : 500, {
            ok: false, error: expected ? message.slice(0, 240) : 'local OCR management failed',
          })
        } finally { inFlight = false }
      },
    }), 'vision-router: optional local OCR manager')
  })
}

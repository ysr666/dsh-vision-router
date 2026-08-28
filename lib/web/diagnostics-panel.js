import { createVisionProductStateSnapshot } from './product-state.js'

export const VISION_PRODUCT_STATE_PATH = '/_dsh/vision-router/product-state'

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function installVisionDiagnosticsPanel(ctx, options = {}) {
  const snapshot = options.snapshot ?? (() => createVisionProductStateSnapshot({
    ctx,
    config: options.config,
    core: options.core,
    store: options.store,
    runtimePerformanceStore: options.runtimePerformanceStore,
    healthForCandidate: options.healthForCandidate,
  }))

  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: VISION_PRODUCT_STATE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, await snapshot())
        } catch {
          // Product-state diagnostics are advisory. Fail closed to an
          // unavailable snapshot without exposing provider errors or secrets.
          sendJson(res, 503, { ok: false, code: 'VISION_PRODUCT_STATE_UNAVAILABLE' })
        }
      },
    }), 'vision-router: structured product state')
  })
  return ctx
}

import { randomBytes } from 'node:crypto'
import { createCachedUpdateChecker } from './update-check.js'
import { detectDshSelfUpdatePlan, runDshPluginUpdate } from './self-update.js'

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

/**
 * Product-maintenance Web routes kept outside the visual Core.
 *
 * The supplied context must already carry DVR's Web capability/auth boundary;
 * this installer deliberately owns only update-product state and the narrow
 * per-route CSRF/replay checks that existed in Core before extraction.
 */
export function installVisionMaintenanceRoutes(ctx, options = {}) {
  if (!ctx || typeof ctx.inject !== 'function') return
  const logger = options.logger ?? ctx.logger
  const updateChecker = options.updateChecker ?? createCachedUpdateChecker()
  const selfUpdatePlan = options.selfUpdatePlan ?? detectDshSelfUpdatePlan()
  const updateRunner = options.runUpdate ?? runDshPluginUpdate
  const tokenFactory = options.tokenFactory ?? (() => randomBytes(24).toString('base64url'))
  let selfUpdateToken = tokenFactory()
  let selfUpdateInFlight

  const updateResultForClient = (result) => ({
    ...result,
    autoUpdate: {
      supported: selfUpdatePlan.available === true,
      method: selfUpdatePlan.available === true ? selfUpdatePlan.method : undefined,
      profile: selfUpdatePlan.profile,
      reason: selfUpdatePlan.available === true ? undefined : selfUpdatePlan.reason,
      token:
        selfUpdatePlan.available === true &&
        result &&
        result.ok === true &&
        result.updateAvailable === true
          ? selfUpdateToken
          : undefined,
    },
  })

  void updateChecker.check(false).then((result) => {
    if (result && result.ok === true && result.updateAvailable === true) {
      logger?.info?.(
        'vision-router: update available %s -> %s',
        result.currentVersion,
        result.latestVersion,
      )
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: '/_dsh/vision-router/update-check',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            res.writeHead(405)
            res.end()
            return
          }
          const force = /(?:[?&])force=1(?:&|$)/.test(String(req.url ?? ''))
          const result = await updateChecker.check(force)
          json(res, 200, updateResultForClient(result), { 'cache-control': 'no-store' })
        },
      }),
      'vision-router: update-check route',
    )

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: '/_dsh/vision-router/self-update',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST')
            res.writeHead(405)
            res.end()
            return
          }
          const fetchSite = String(req.headers?.['sec-fetch-site'] ?? '')
          if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
            json(res, 403, { ok: false, error: 'cross-origin update request rejected' })
            return
          }
          const token = String(req.headers?.['x-dsh-vision-router-update-token'] ?? '')
          if (!token || token !== selfUpdateToken) {
            json(res, 403, { ok: false, error: 'invalid update token' })
            return
          }
          if (selfUpdatePlan.available !== true) {
            json(res, 409, { ok: false, error: 'automatic update is not safe for this DSH launch' })
            return
          }
          try {
            const fresh = await updateChecker.check(true)
            if (!fresh || fresh.ok !== true) {
              json(res, 502, { ok: false, error: fresh?.error || 'could not refresh update metadata' })
              return
            }
            if (fresh.updateAvailable !== true) {
              json(res, 409, { ok: false, error: 'no newer version is currently available' })
              return
            }
            if (!selfUpdateInFlight) {
              const pending = updateRunner(selfUpdatePlan, { targetVersion: fresh.latestVersion })
              selfUpdateInFlight = pending
              void pending.then(
                () => { if (selfUpdateInFlight === pending) selfUpdateInFlight = undefined },
                () => { if (selfUpdateInFlight === pending) selfUpdateInFlight = undefined },
              )
            }
            const result = await selfUpdateInFlight
            selfUpdateToken = tokenFactory()
            json(res, 200, result, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, {
              ok: false,
              error: error && error.message ? error.message : String(error),
            })
          }
        },
      }),
      'vision-router: self-update route',
    )
  })
}

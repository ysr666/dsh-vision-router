import { collectCapabilityShadowCandidates } from './vision-capability-shadow.js'
import {
  benchmarkAxisForVisionIntent,
  suggestVisionOrder,
} from './vision-capability-router.js'
import { resolveVisionRoutingProduct } from './vision-routing-product.js'

export const VISION_ROUTING_PREVIEW_PATH = '/_dsh/vision-router/routing-preview'
export const VISION_ROUTING_PREVIEW_INTENTS = Object.freeze([
  'structured',
  'ocr',
  'document',
  'grounding',
  'general',
])

function activeSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function measuredMap(candidates) {
  return Object.fromEntries(
    candidates
      .filter((candidate) => candidate?.measured)
      .map((candidate) => [candidate.key, {
        scores: candidate.measured,
        measuredAt: candidate.measuredAt,
        medianLatencyMs: candidate.medianLatencyMs,
      }]),
  )
}

function safeDecision(decision) {
  if (!decision || typeof decision !== 'object') return undefined
  if (decision.type === 'reorder') {
    return {
      type: 'reorder',
      reason: decision.reason,
      before: decision.before,
      promoted: decision.promoted,
      axis: decision.axis,
      delta: decision.delta,
    }
  }
  if (decision.type === 'availability') {
    return {
      type: 'availability',
      reason: decision.reason,
      backend: decision.backend,
    }
  }
  return undefined
}

function previewReason({ changed, preference, decisions, incomparableBackends }) {
  if (changed && preference === 'local') return 'local-preference'
  if (changed && decisions.some((decision) => decision?.type === 'reorder')) return 'measured-advantage'
  if (incomparableBackends.length > 0) return 'insufficient-comparable-evidence'
  return 'configured-order'
}

export async function buildVisionRoutingPreview({
  ctx,
  config,
  core,
  store,
  now = Date.now(),
} = {}) {
  const current = activeSettings(ctx, config)
  const product = resolveVisionRoutingProduct(current)
  const candidates = await collectCapabilityShadowCandidates(ctx, current, core, store)
  const currentOrder = candidates.map((candidate) => candidate.key)
  const measured = measuredMap(candidates)
  const freshMeasuredBackends = Object.keys(measured)

  const previews = VISION_ROUTING_PREVIEW_INTENTS.map((intent) => {
    const suggestion = suggestVisionOrder({
      intent,
      strategy: product.strategy,
      candidates,
      measured,
      health: {},
      now,
    })
    const order = suggestion.ranked.map((candidate) => candidate.key)
    const decisions = suggestion.decisions.map(safeDecision).filter(Boolean)
    const incomparableBackends = Array.isArray(suggestion.incomparableBackends)
      ? suggestion.incomparableBackends.slice()
      : []
    const changed = order.join('\u0000') !== currentOrder.join('\u0000')
    return {
      intent,
      axis: benchmarkAxisForVisionIntent(intent),
      first: order[0],
      order,
      changed,
      reason: previewReason({
        changed,
        preference: product.preference,
        decisions,
        incomparableBackends,
      }),
      decisions,
      incomparableBackends,
    }
  })

  return {
    ok: true,
    routingMode: product.mode,
    routingPreference: product.preference,
    strategy: product.strategy,
    currentOrder,
    freshMeasuredBackends,
    previews,
    autoPreviewOnly: true,
    executionActive: false,
    healthIncluded: false,
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function installVisionRoutingPreviewService(ctx, config, core, options = {}) {
  const logger = options.logger ?? ctx?.logger
  const store = options.store
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: VISION_ROUTING_PREVIEW_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            sendJson(res, 200, await buildVisionRoutingPreview({
              ctx,
              config,
              core,
              store,
            }))
          } catch (error) {
            logger?.warn?.(
              'vision-router: routing preview failed: %s',
              error?.message ?? String(error),
            )
            sendJson(res, 500, {
              ok: false,
              error: 'routing preview unavailable',
            })
          }
        },
      }),
      'vision-router: read-only routing preview service',
    )
  })
}

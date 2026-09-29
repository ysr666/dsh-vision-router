import { htmlHasScriptMarker } from './html-script-marker.js'

const CARRIER_REGISTRY = '__dshVisionRouterClientCarriers'

function carrierKey(marker) {
  const value = String(marker || 'vision-router-client-script')
  return `vr:${value.replace(/^data-vision-router-/, '')}`
}

/**
 * Wrap one browser prelude with a shared one-shot fence. Modern served-Web
 * pages can receive both structured index rows and tapIndex HTML transforms,
 * while Desktop/static carriers receive only the structured row. The fence
 * keeps both delivery paths safe without relying on each prelude to implement
 * its own duplicate-execution semantics.
 */
export function clientCarrierSource(marker, prelude) {
  const key = JSON.stringify(carrierKey(marker))
  return `(function(){\n  var root = window;\n  var registry = root.${CARRIER_REGISTRY};\n  if (!registry || typeof registry !== 'object') {\n    registry = Object.create(null);\n    try { Object.defineProperty(root, '${CARRIER_REGISTRY}', { value: registry, configurable: true }); }\n    catch (_) { root.${CARRIER_REGISTRY} = registry; }\n  }\n  var key = ${key};\n  if (registry[key]) return;\n  registry[key] = true;\n  try {\n${prelude}\n  } catch (error) {\n    try { delete registry[key]; } catch (_) { registry[key] = false; }\n    throw error;\n  }\n})();`
}

export function injectClientCarrierHtml(html, marker, prelude) {
  const structuredMark = `/* ${marker} */`
  if (typeof html !== 'string' || htmlHasScriptMarker(html, marker) || html.includes(structuredMark)) return html
  const safe = clientCarrierSource(marker, prelude).replace(/<\/script/gi, '<\\/script')
  const script = `<script ${marker}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  return closeHead === -1 ? `${html}${script}` : `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
}


export function injectClientStyleHtml(html, marker, css) {
  if (typeof html !== 'string' || typeof marker !== 'string' || marker === '') return html
  if (html.includes(`<style ${marker}>`)) return html
  const style = `<style ${marker}>${String(css || '')}</style>`
  const closeHead = html.indexOf('</head>')
  return closeHead === -1 ? `${html}${style}` : `${html.slice(0, closeHead)}${style}${html.slice(closeHead)}`
}

export function appendStructuredClientStyle(table, marker, css) {
  if (!Array.isArray(table) || typeof marker !== 'string' || marker === '') return false
  const signature = `/* ${marker}:style */`
  if (table.some((row) => row?.kind === 'style' && typeof row.text === 'string' && row.text.includes(signature))) return false
  table.push({ kind: 'style', placement: 'head', text: `${signature}
${String(css || '')}` })
  return true
}

export function appendStructuredClientCarrier(table, marker, prelude) {
  if (!Array.isArray(table)) return false
  const signature = `/* ${marker} */`
  if (table.some((row) => row?.kind === 'script' && typeof row.text === 'string' && row.text.includes(signature))) {
    return false
  }
  table.push({
    kind: 'script',
    placement: 'head',
    text: `${signature}\n${clientCarrierSource(marker, prelude)}`,
  })
  return true
}

/**
 * Register the same client prelude on both supported browser carriers:
 * - structured `webserver/index-inject` rows for Desktop/static shells;
 * - `tapIndex()` HTML transforms for served-Web and older Hosts.
 */
export function installClientScriptCarriers(ctx, { marker, prelude, label, injectHtml, style }) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    if (typeof webCtx.on === 'function') {
      webCtx.on('webserver/index-inject', (table) => {
        if (style) appendStructuredClientStyle(table, style.marker || marker, style.text)
        appendStructuredClientCarrier(table, marker, prelude)
      })
    }
    if (typeof webCtx.effect === 'function' && webCtx.webServer?.tapIndex) {
      const baseTransform = typeof injectHtml === 'function'
        ? injectHtml
        : (html) => injectClientCarrierHtml(html, marker, prelude)
      const transform = style
        ? (html) => baseTransform(injectClientStyleHtml(html, style.marker || marker, style.text))
        : baseTransform
      webCtx.effect(
        () => webCtx.webServer.tapIndex(transform),
        label,
      )
    }
  })
}

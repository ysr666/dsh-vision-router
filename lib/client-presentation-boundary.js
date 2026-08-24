import { htmlHasScriptMarker } from './html-script-marker.js'
import {
  CLIENT_PRESENTATION_PRELUDE,
  resolveVisionModePair,
} from './client-presentation-boundary-main.js'
import { installVisionModelVisibilityBoundary } from './vision-model-visibility-boundary.js'

const CLIENT_PRESENTATION_MARK = 'data-vision-router-presentation-boundary'

export {
  CLIENT_PRESENTATION_PRELUDE,
  resolveVisionModePair,
} from './client-presentation-boundary-main.js'

export function injectClientPresentationBoundary(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, CLIENT_PRESENTATION_MARK)) return html
  const safe = CLIENT_PRESENTATION_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${CLIENT_PRESENTATION_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installClientPresentationBoundary(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectClientPresentationBoundary),
      'vision-router: client presentation boundary',
    )
  })
  // #286 keeps real wrapper routes registered while hiding only confidently
  // owned wrappers from DSH's stock model-selection presentation. Compose that
  // presentation boundary here so v2 can retain its hardened script-marker
  // injector without duplicating the large composer implementation.
  installVisionModelVisibilityBoundary(ctx)
}

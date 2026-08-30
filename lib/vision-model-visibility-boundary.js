import { htmlHasScriptMarker } from './html-script-marker.js'
import { VISION_MODEL_VISIBILITY_PRELUDE } from './vision-model-visibility-boundary-main.js'

const VISIBILITY_MARK = 'data-vision-router-model-visibility-boundary'

export {
  VISION_MODEL_VISIBILITY_PRELUDE,
  projectVisionModeDirectoryState,
  mapVisionPresentationSelection,
} from './vision-model-visibility-boundary-main.js'

export function injectVisionModelVisibilityBoundary(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, VISIBILITY_MARK)) return html
  const safe = VISION_MODEL_VISIBILITY_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${VISIBILITY_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installVisionModelVisibilityBoundary(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectVisionModelVisibilityBoundary),
      'vision-router: model visibility boundary',
    )
  })
}

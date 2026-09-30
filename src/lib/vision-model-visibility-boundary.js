import { injectClientCarrierHtml, installClientScriptCarriers } from './client-script-carrier.js'
import { VISION_MODEL_VISIBILITY_PRELUDE } from './vision-model-visibility-boundary-main.js'

const VISIBILITY_MARK = 'data-vision-router-model-visibility-boundary'

export {
  VISION_MODEL_VISIBILITY_PRELUDE,
  projectVisionModeDirectoryState,
  mapVisionPresentationSelection,
} from './vision-model-visibility-boundary-main.js'

export function injectVisionModelVisibilityBoundary(html) {
  return injectClientCarrierHtml(html, VISIBILITY_MARK, VISION_MODEL_VISIBILITY_PRELUDE)
}

export function installVisionModelVisibilityBoundary(ctx) {
  installClientScriptCarriers(ctx, {
    marker: VISIBILITY_MARK,
    prelude: VISION_MODEL_VISIBILITY_PRELUDE,
    label: 'vision-router: model visibility boundary',
    injectHtml: injectVisionModelVisibilityBoundary,
  })
}

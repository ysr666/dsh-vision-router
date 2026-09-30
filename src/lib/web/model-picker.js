import { installClientPresentationBoundary } from '../client-presentation-boundary.js'
import { installVisionModelVisibilityBoundary } from '../vision-model-visibility-boundary.js'
import { installStrictLiveModelClientPrelude } from '../strict-live-model-client-prelude.js'
import { installWrapperScopeClientPrelude } from '../wrapper-scope-client-prelude.js'

export function installVisionModelPickerPresentation(ctx) {
  installClientPresentationBoundary(ctx)
  return ctx
}

export function installVisionModelPickerControls(ctx) {
  installVisionModelVisibilityBoundary(ctx)
  installStrictLiveModelClientPrelude(ctx)
  installWrapperScopeClientPrelude(ctx)
  return ctx
}

export function installVisionModelPicker(ctx) {
  installVisionModelPickerPresentation(ctx)
  installVisionModelPickerControls(ctx)
  return ctx
}

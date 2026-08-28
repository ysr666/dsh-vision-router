import { installClientPresentationBoundary } from '../client-presentation-boundary.js'
import { installVisionModelVisibilityBoundary } from '../vision-model-visibility-boundary.js'
import { installStrictLiveModelClientPrelude } from '../strict-live-model-client-prelude.js'
import { installWrapperScopeClientPrelude } from '../wrapper-scope-client-prelude.js'

export function installVisionModelPicker(ctx) {
  installClientPresentationBoundary(ctx)
  installVisionModelVisibilityBoundary(ctx)
  installStrictLiveModelClientPrelude(ctx)
  installWrapperScopeClientPrelude(ctx)
  return ctx
}

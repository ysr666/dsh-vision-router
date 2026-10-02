// Compatibility tombstone for 1.7.x entry bundles.
//
// The primary Settings IA now owns `autoWrapProviders` / `wrappedProviders`.
// Keep these exports until the next entrypoint cleanup so older generated
// bundles that still import this module do not fail at module resolution, but
// deliberately register no browser transform and render no duplicate editor.
export const WRAPPER_SCOPE_CLIENT_PRELUDE = ''

export function injectWrapperScopeClientPrelude(html) {
  return html
}

export function installWrapperScopeClientPrelude() {
  // Intentionally inert: settings-ia-client-prelude.js is the sole UI owner.
}

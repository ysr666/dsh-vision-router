/**
 * Retired pre-step compatibility shell.
 *
 * This module remains as a stable internal import while the 2.x composition is
 * still being collapsed, but it deliberately owns no runtime behavior.
 *
 * Historical versions intercepted `agent/pre-step` for two model-only concerns:
 * rewriting text-only image messages into `[attached image: ...]` markers and
 * appending a synthetic attachment-id user message for Vision Router wrappers.
 * DSH persists every admitted pre-step message as `user/message`, so both
 * transforms crossed the durable transcript boundary and could surface in the
 * Web conversation. User-owned image messages must instead remain byte-for-byte
 * Session facts; request-only image projection belongs to the selected adapter.
 *
 * Keep this function identity-only until runtime-composition removes the import
 * in a dedicated closure cleanup. No Settings/config/service identity is
 * impersonated and no `agent/pre-step` listener is installed here.
 */
export function installLegacyCoreVisionPolicyBridge(ctx, config = {}) {
  return { ctx, config }
}

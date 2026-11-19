/**
 * Provider provenance for DeepSeek Messages v1 replay forwarded by a DVR twin.
 *
 * Native DSH replay metadata has a model id but no source-provider field.
 * DVR knows the actual delegate only at the point that the delegate's native
 * finish chunk is received; this is the sole place to attach that provenance.
 *
 * These functions never manufacture or modify a reasoning signature.
 * Unsupported, malformed, error and ambiguous envelopes pass through.
 */
export function stampDelegatedDeepSeekReplayChunk(chunk, delegateProvider, model) {
  if (chunk?.type !== 'finish' || chunk.reason?.kind !== 'stop') return chunk
  if (typeof delegateProvider !== 'string' || delegateProvider === '' ||
      typeof model !== 'string' || model === '') return chunk
  const envelope = chunk.replayState
  const response = envelope?.response
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
      response.kind !== 'deepseek-messages' || response.version !== 1 ||
      response.model !== model || !Array.isArray(envelope.blocks)) return chunk
  if (response.provider !== undefined && response.provider !== delegateProvider) return chunk
  if (response.provider === delegateProvider) return chunk
  return {
    ...chunk,
    replayState: {
      ...envelope,
      response: { ...response, provider: delegateProvider },
    },
  }
}

/** Read ONLY provenance DVR attached to the exact delegate's native finish. */
export function hasDelegatedDeepSeekReplayProvenance(replayState, delegateProvider, model) {
  if (!replayState || typeof replayState !== 'object' || Array.isArray(replayState)) return false
  const response = replayState.response
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false
  return response.kind === 'deepseek-messages' &&
    response.version === 1 &&
    response.provider === delegateProvider &&
    response.model === model &&
    Array.isArray(replayState.blocks)
}

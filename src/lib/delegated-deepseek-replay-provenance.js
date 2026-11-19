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

/**
 * Rebind only the selected DVR twin's own previous assistant responses.
 *
 * A generic Host llm/stream interceptor cannot safely trust a foreign
 * provider's replayState.provider field. The wrapper body, however, knows
 * both its exact public route and the actual delegate it just selected.
 * Perform this transformation only at that narrow trusted boundary.
 */
export function rebindStampedDeepSeekTwinMessages(messages, twinProvider, delegateProvider, model) {
  if (!Array.isArray(messages) ||
      typeof twinProvider !== 'string' || twinProvider === '' ||
      typeof delegateProvider !== 'string' || delegateProvider === '' ||
      twinProvider === delegateProvider ||
      typeof model !== 'string' || model === '') return messages
  let changed = false
  const result = messages.map(message => {
    if (message?.role !== 'assistant' ||
        message.source?.kind !== 'model' ||
        message.source.provider !== twinProvider ||
        message.source.model !== model ||
        !hasDelegatedDeepSeekReplayProvenance(message.source.replayState, delegateProvider, model)) {
      return message
    }
    changed = true
    return {
      ...message,
      source: { ...message.source, provider: delegateProvider },
    }
  })
  return changed ? result : messages
}

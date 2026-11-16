import { randomUUID } from 'node:crypto'

/**
 * Per-invocation, privacy-safe stage timings. Never log paths, attachment IDs,
 * prompt text, response contents, headers or credentials. A pending Host
 * Promise gets an abort-stage log even if its own operation never settles.
 */
export function createVisionToolStageTrace(logger, toolName, signal) {
  const traceId = randomUUID().slice(0, 12)
  const report = (level, phase, status, elapsed) => {
    try {
      logger?.[level]?.(
        'vision-router: tool=%s trace=%s stage=%s status=%s elapsedMs=%d',
        toolName, traceId, phase, status, elapsed,
      )
    } catch {
      // Diagnostics cannot change the outcome of an image/tool operation.
    }
  }

  return async (phase, operation) => {
    const started = Date.now()
    let completed = false
    let abortReported = false
    let rejectAborted
    const canceled = signal && new Promise((_, reject) => { rejectAborted = reject })
    const onAbort = () => {
      if (completed || abortReported) return
      abortReported = true
      report('warn', phase, 'aborted', Date.now() - started)
      rejectAborted?.(signal?.reason ?? new Error('vision stage aborted'))
    }

    report('info', phase, 'begin', 0)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      if (signal?.aborted) throw signal.reason ?? new Error('vision stage aborted')
      // A legacy or broken Host Promise may ignore AbortSignal indefinitely.
      // Race the stage *without* publishing its late result, while still
      // observing the detached Promise and releasing our abort listener.
      const running = Promise.resolve(operation())
      const value = await (canceled ? Promise.race([running, canceled]) : running)
      if (signal?.aborted) throw signal.reason ?? new Error('vision stage aborted')
      report('info', phase, 'ok', Date.now() - started)
      return value
    } catch (error) {
      if (!abortReported) report('warn', phase, 'error', Date.now() - started)
      throw error
    } finally {
      completed = true
      signal?.removeEventListener?.('abort', onAbort)
    }
  }
}

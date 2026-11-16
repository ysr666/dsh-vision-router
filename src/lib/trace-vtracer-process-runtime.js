import { fork } from 'node:child_process'

/**
 * Own one VTracer child process without sharing native/WASM address space with
 * the Host. The injected childUrl is an internal test seam, never user input.
 */
export function runIsolatedTraceProcess({
  mode,
  payload,
  timeoutMs,
  signal,
  abortReason,
  childUrl = new URL('./trace-vtracer-process.js', import.meta.url),
}) {
  const aborted = () => abortReason?.() ?? new Error('vector trace aborted')
  if (signal?.aborted) return Promise.reject(aborted())
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('vector trace timed out'))
  }

  return new Promise((resolve, reject) => {
    let child
    let timer
    let finished = false
    let pendingSvg
    const finish = (error, svg) => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      // Cancellation, timeouts, and native crashes stay inside the child.
      if (error && child && !child.killed) child.kill()
      if (error) reject(error)
      else resolve(svg)
    }
    const onAbort = () => finish(aborted())
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) { finish(aborted()); return }

    timer = setTimeout(() => finish(new Error(
      'vector trace timed out — crop the image or reduce its complexity',
    )), timeoutMs)
    try {
      // No inherited Host CLI/test loader flags or NODE_OPTIONS preload.
      const childEnv = { ...process.env, NODE_OPTIONS: '' }
      if (process.versions?.electron) childEnv.ELECTRON_RUN_AS_NODE = '1'
      child = fork(childUrl, [], {
        execArgv: [],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
        env: childEnv,
      })
      child.once('message', (message) => {
        if (message?.ok === true && typeof message.svg === 'string') pendingSvg = message.svg
        else finish(new Error('vector trace process returned an invalid result'))
      })
      child.once('error', () => finish(new Error('vector trace process startup failed')))
      child.once('exit', (code, termSignal) => {
        if (finished) return
        if (code === 0 && typeof pendingSvg === 'string') finish(undefined, pendingSvg)
        else finish(new Error('vector trace process exited before producing SVG (' +
          (code === null ? String(termSignal ?? 'signal') : String(code)) + ')'))
      })
      child.send({ type: 'trace', mode, payload }, (error) => {
        if (error) finish(new Error('vector trace process IPC failed'))
      })
    } catch {
      finish(new Error('vector trace process launch failed'))
    }
  })
}

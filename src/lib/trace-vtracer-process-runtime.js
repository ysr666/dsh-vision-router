import { fork } from 'node:child_process'

// Avoid unbounded Host-memory retention and process storms under hostile
// concurrent tool calls. Waiting consumes the caller's original deadline.
const MAX_ACTIVE_TRACE_PROCESSES = 3
const MAX_WAITING_TRACE_PROCESSES = 8
let active = 0
const waiting = []

function dispatchWaiting() {
  while (active < MAX_ACTIVE_TRACE_PROCESSES && waiting.length > 0) {
    const next = waiting.shift()
    if (next.finished()) continue
    active++
    next.start()
  }
}

/**
 * Own one VTracer child process without sharing native/WASM address space
 * with the Host. The injected childUrl is an internal test seam, never a
 * user-provided path or executable.
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
  if (waiting.length >= MAX_WAITING_TRACE_PROCESSES && active >= MAX_ACTIVE_TRACE_PROCESSES) {
    return Promise.reject(new Error('vector trace process capacity exceeded'))
  }

  return new Promise((resolve, reject) => {
    let child
    let timer
    let finished = false
    let started = false
    let slotHeld = false
    let pendingSvg

    const release = () => {
      if (!slotHeld) return
      slotHeld = false
      active--
      dispatchWaiting()
    }
    const finish = (error, svg) => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (!started) {
        const index = waiting.indexOf(entry)
        if (index >= 0) waiting.splice(index, 1)
      }
      // Cancellation, timeouts, and native crashes stay inside the child.
      if (error && child && !child.killed) {
        try { child.kill() } catch { /* a closing child is already terminal */ }
      }
      if (error) reject(error)
      else resolve(svg)
    }
    const onAbort = () => finish(aborted())

    const entry = {
      finished: () => finished,
      start: () => {
        if (finished) { release(); return }
        started = true
        slotHeld = true
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
            const svg = message?.svg
            // The subprocess is a trust boundary, not an output validator.
            // Native faults must never let bogus or oversized markup reach
            // the Host artifact writer, even if IPC closes with status zero.
            if (
              message?.ok === true && typeof svg === 'string' &&
              svg.length > 0 && svg.length <= 16 * 1024 * 1024 &&
              /<svg[\s>]/.test(svg) && Buffer.byteLength(svg) <= 16 * 1024 * 1024
            ) {
              pendingSvg = svg
            } else {
              finish(new Error('vector trace process returned an invalid result'))
            }
          })
          child.once('error', () => finish(new Error('vector trace process startup failed')))
          child.once('close', (code, termSignal) => {
            // Do not resolve a healthy result before the IPC pipe is closed
            // and this process' concurrency slot has actually been released.
            release()
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
          if (!child) release()
        }
      },
    }

    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) { finish(aborted()); return }
    timer = setTimeout(() => finish(new Error(
      'vector trace timed out — crop the image or reduce its complexity',
    )), timeoutMs)
    waiting.push(entry)
    dispatchWaiting()
  })
}

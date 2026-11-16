import { Worker } from 'node:worker_threads'

// Trusted, one-shot VTracer child. All native/WASM work lives outside the Host
// process; a native access violation kills this child, not the Host.
let sent = false
function reply(message) {
  if (sent) return
  sent = true
  if (typeof process.send !== 'function') {
    process.exitCode = 1
    return
  }
  process.send(message, (error) => {
    if (error) process.exitCode = 1
    process.disconnect?.()
  })
}

process.once('message', (task) => {
  if (task?.type !== 'trace' || !['grayscale', 'color'].includes(task.mode)) {
    reply({ ok: false, error: 'invalid trace task' })
    return
  }
  let pendingSvg
  try {
    const worker = new Worker(new URL('./trace-vtracer-worker.js', import.meta.url), {
      execArgv: [],
      workerData: { mode: task.mode, ...task.payload },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
    })
    worker.once('message', (message) => {
      if (message?.ok === true && typeof message.svg === 'string') pendingSvg = message.svg
      else reply({ ok: false, error: 'vector trace worker returned an error' })
    })
    worker.once('error', () => reply({ ok: false, error: 'vector trace worker failed' }))
    worker.once('exit', (code) => {
      if (code === 0 && typeof pendingSvg === 'string') reply({ ok: true, svg: pendingSvg })
      else reply({ ok: false, error: 'vector trace worker exited before producing SVG' })
    })
  } catch {
    reply({ ok: false, error: 'vector trace worker startup failed' })
  }
})

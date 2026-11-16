// Deterministic fault-injection process used only by tests.
// No native crash is required to verify fail-closed subprocess ownership.
process.once('message', (task) => {
  if (task?.mode === 'premature-success') {
    process.send?.({ ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }, () => {
      process.exit(93)
    })
    return
  }
  if (task?.mode === 'exit-without-message') {
    process.exit(94)
    return
  }
  if (task?.mode === 'invalid-svg' || task?.mode === 'valid-svg') {
    const svg = task.mode === 'valid-svg'
      ? '<svg xmlns="http://www.w3.org/2000/svg"/>'
      : '<html><body>not a vector artifact</body></html>'
    process.send?.({ ok: true, svg }, () => process.disconnect?.())
    return
  }
  if (task?.mode === 'hang') { setInterval(() => {}, 1_000); return }
  process.send?.({ ok: false, error: 'invalid fixture mode' }, () => {
    process.disconnect?.()
  })
})

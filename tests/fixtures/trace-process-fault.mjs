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
  if (task?.mode === 'hang') return
  process.send?.({ ok: false, error: 'invalid fixture mode' }, () => {
    process.disconnect?.()
  })
})

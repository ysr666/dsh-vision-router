export async function probeLocalBackends(providers, probe, startedAt = Date.now()) {
  const locals = Array.isArray(providers) ? providers.filter(Boolean) : []
  if (locals.length === 0) return undefined
  if (typeof probe !== 'function') throw new TypeError('probe must be a function')

  if (locals.length === 1) return probe(locals[0])

  const attempts = []
  for (let index = 0; index < locals.length; index++) {
    const provider = locals[index]
    const result = await probe(provider)
    attempts.push({ backend: provider.name, ...result })
    if (result?.ok === true) {
      return {
        ...result,
        backend: provider.name,
        fallbackUsed: index > 0,
        latencyMs: Math.max(0, Date.now() - startedAt),
        attempts,
      }
    }
  }

  return {
    ok: false,
    latencyMs: Math.max(0, Date.now() - startedAt),
    error: 'all enabled local vision backends failed the connection probe',
    attempts,
  }
}

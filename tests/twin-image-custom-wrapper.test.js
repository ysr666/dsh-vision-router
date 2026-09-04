import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextWithTwinImageCapabilityFallback } from '../lib/twin-image-capability-fallback.js'

function sourceAdapter() {
  return {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('live custom main wrapper route is never mistaken for a generated twin', () => {
  const registrations = new Map([['src', { adapter: sourceAdapter() }]])
  const settings = {
    get(namespace) {
      return namespace === 'vision-router' ? { wrapperRoute: 'src-vision' } : undefined
    },
  }
  const ctx = {
    get(service) {
      return service === 'settings' ? settings : undefined
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) registrations.set(provider, { adapter })
        return () => {}
      },
      registration(provider) {
        const hit = registrations.get(provider)
        if (!hit) throw new Error(`no adapter ${provider}`)
        return hit
      },
    },
  }

  const wrapped = contextWithTwinImageCapabilityFallback(ctx)
  const mainWrapper = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  wrapped.llm.registerAdapter(['src-vision'], mainWrapper)

  assert.equal(
    registrations.get('src-vision').adapter,
    mainWrapper,
    'the live Settings wrapperRoute is a distinct product route, not a generated source twin',
  )
})

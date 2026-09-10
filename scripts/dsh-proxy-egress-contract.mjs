import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dshRoot = path.resolve(process.env.DSH_SOURCE_ROOT || '')
const dvrRoot = path.resolve(process.env.DVR_SOURCE_ROOT || path.join(dshRoot, '..', 'dvr'))
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')

// Import DVR first. The Host proxy is deliberately installed only afterwards:
// this proves a fetch captured by VisionProviderTransport still resolves the
// Host-owned global dispatcher at request time.
const { createVisionProviderTransport } = await import(
  pathToFileURL(path.join(dvrRoot, 'lib/vision-provider-transport.js')).href
)
const { installProxyFromEnvironment, proxyRouteFor } = await import(
  pathToFileURL(path.join(dshRoot, 'packages/util/http-proxy/src/index.ts')).href
)

let seen = []
const proxy = createServer((request, response) => {
  const target = request.url || ''
  seen.push(`REQ ${target}`)
  if (target.includes('dvr-redirect-probe.invalid/start')) {
    response.writeHead(302, { location: 'http://dvr-bypass-probe.invalid/final' })
    response.end()
    return
  }
  response.writeHead(502)
  response.end('fake-host-proxy')
})
proxy.on('connect', (request, socket) => {
  seen.push(`CONNECT ${request.url || ''}`)
  socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  socket.end()
})
await new Promise((resolve, reject) => {
  proxy.once('error', reject)
  proxy.listen(0, '127.0.0.1', resolve)
})
const address = proxy.address()
if (!address || typeof address === 'string') throw new Error('fake proxy did not bind a TCP port')
const proxyUrl = `http://127.0.0.1:${address.port}`

function environment(noProxy) {
  return {
    get(name) {
      if (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY') return { value: proxyUrl }
      if ((name === 'NO_PROXY' || name === 'no_proxy') && noProxy) return { value: noProxy }
      return undefined
    },
  }
}

async function withHostProxy(noProxy, run) {
  seen = []
  const diagnostics = []
  const dispose = await installProxyFromEnvironment(environment(noProxy), (message) => diagnostics.push(message))
  try {
    assert.deepEqual(diagnostics, [])
    await run()
  } finally {
    await dispose()
  }
}

try {
  await withHostProxy(undefined, async () => {
    const url = new URL('http://dvr-proxy-probe.invalid/proof')
    const route = proxyRouteFor(url)
    assert.equal(route.proxied, true, 'exact Host must report the request as proxied')

    let pluginUndiciImports = 0
    const transport = createVisionProviderTransport({
      config: { proxy: '', proxyHosts: ['dvr-proxy-probe.invalid'] },
      importUndici: async () => {
        pluginUndiciImports += 1
        throw new Error('blank plugin proxy must not construct a private ProxyAgent')
      },
    })
    assert.equal(transport.proxyDecision(url).proxied, false, 'plugin override must remain inactive')
    const response = await transport.fetch(url)
    assert.equal(response.status, 502)
    assert.equal(pluginUndiciImports, 0)
    assert.ok(seen.some((entry) => entry.includes('dvr-proxy-probe.invalid')), 'Host fake proxy must receive DVR egress')
  })

  await withHostProxy('dvr-bypass-probe.invalid', async () => {
    const url = new URL('http://dvr-bypass-probe.invalid/proof')
    assert.equal(proxyRouteFor(url).proxied, false, 'Host NO_PROXY must own the bypass decision')
    const transport = createVisionProviderTransport({ config: { proxy: '' } })
    await assert.rejects(
      transport.fetch(url, { signal: AbortSignal.timeout(1500) }),
      'bypassed .invalid host should fail direct rather than reaching the fake proxy',
    )
    assert.equal(seen.some((entry) => entry.includes('dvr-bypass-probe.invalid')), false)
  })

  await withHostProxy('dvr-bypass-probe.invalid', async () => {
    const start = new URL('http://dvr-redirect-probe.invalid/start')
    assert.equal(proxyRouteFor(start).proxied, true)
    assert.equal(proxyRouteFor(new URL('http://dvr-bypass-probe.invalid/final')).proxied, false)
    const transport = createVisionProviderTransport({ config: { proxy: '' } })
    await assert.rejects(
      transport.fetch(start, { signal: AbortSignal.timeout(1500) }),
      'redirect target is bypassed by Host and should fail direct on .invalid',
    )
    assert.ok(seen.some((entry) => entry.includes('dvr-redirect-probe.invalid/start')))
    assert.equal(
      seen.some((entry) => entry.includes('dvr-bypass-probe.invalid/final')),
      false,
      'Host dispatcher must re-evaluate NO_PROXY after redirect instead of pinning the first-hop route',
    )
  })

  console.log('DSH Host proxy egress contract: PASS')
} finally {
  await new Promise((resolve) => proxy.close(resolve))
}

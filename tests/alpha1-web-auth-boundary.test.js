import test from 'node:test'
import assert from 'node:assert/strict'

import { installLocalMutationRouteBoundary } from '../lib/web-capability-boundary.js'

function responseRecorder() {
  const state = { status: undefined, headers: undefined, body: '' }
  return {
    state,
    response: {
      writeHead(status, headers) {
        state.status = status
        state.headers = headers
        return this
      },
      setHeader() {},
      removeHeader() {},
      end(body = '') {
        state.body += body == null ? '' : String(body)
        return this
      },
    },
  }
}

function realRequest({ method = 'GET', remoteAddress = '192.168.1.20', host = 'dsh.local:3000' } = {}) {
  return {
    method,
    headers: { host },
    socket: { remoteAddress },
  }
}

function registerThroughBoundary({ connection, path, method = 'GET' }) {
  let registered
  let calls = 0
  const disposers = []
  const webServer = {
    register(route) {
      registered = route
      return () => { registered = undefined }
    },
  }
  const root = {
    get(name) {
      if (name === 'connection') return connection
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(dependencies, callback) {
      const child = {
        webServer,
        get: root.get.bind(root),
        effect: root.effect.bind(root),
      }
      return callback(child)
    },
  }
  const wrapped = installLocalMutationRouteBoundary(root)
  wrapped.inject(['webServer'], (ctx) => ctx.webServer.register({
    kind: 'exact',
    path,
    handler(req, res) {
      calls += 1
      assert.equal(req.method, method)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    },
  }))
  return {
    route: () => registered,
    calls: () => calls,
    dispose() {
      for (const disposer of disposers.splice(0).reverse()) disposer()
    },
  }
}

test('alpha.1 Host browser authentication gates every DVR named route before its handler', () => {
  let authCalls = 0
  const mounted = registerThroughBoundary({
    connection: {
      requestRejection() {
        authCalls += 1
        return 401
      },
    },
    path: '/_dsh/vision-router/product-state',
  })
  try {
    const { response, state } = responseRecorder()
    mounted.route().handler(realRequest(), response)
    assert.equal(authCalls, 1)
    assert.equal(mounted.calls(), 0)
    assert.equal(state.status, 401)
    assert.match(state.body, /authentication required/)
  } finally {
    mounted.dispose()
  }
})

test('Host requestRejection 403 is preserved and a thrown Host auth check fails closed', () => {
  for (const behavior of ['reject', 'throw']) {
    const mounted = registerThroughBoundary({
      connection: {
        requestRejection() {
          if (behavior === 'throw') throw new Error('auth unavailable')
          return 403
        },
      },
      path: '/_dsh/vision-router/model-capabilities',
    })
    try {
      const { response, state } = responseRecorder()
      mounted.route().handler(realRequest(), response)
      assert.equal(mounted.calls(), 0)
      assert.equal(state.status, 403)
    } finally {
      mounted.dispose()
    }
  }
})

test('authenticated alpha.1 requests continue into the existing local-machine policy', () => {
  const mounted = registerThroughBoundary({
    connection: { requestRejection: () => undefined },
    path: '/_dsh/vision-router/self-update',
    method: 'POST',
  })
  try {
    const { response, state } = responseRecorder()
    mounted.route().handler(realRequest({ method: 'POST' }), response)
    assert.equal(mounted.calls(), 0)
    assert.equal(state.status, 403)
    assert.match(state.body, /local DSH UI/)
  } finally {
    mounted.dispose()
  }
})

test('pre-alpha Hosts without requestRejection preserve the existing DVR route behavior', () => {
  const mounted = registerThroughBoundary({
    connection: {},
    path: '/_dsh/vision-router/product-state',
  })
  try {
    const { response, state } = responseRecorder()
    mounted.route().handler(realRequest(), response)
    assert.equal(mounted.calls(), 1)
    assert.equal(state.status, 200)
    assert.equal(state.body, 'ok')
  } finally {
    mounted.dispose()
  }
})

test('Host browser auth is scoped to DVR routes and does not claim another plugin route', () => {
  let authCalls = 0
  const mounted = registerThroughBoundary({
    connection: {
      requestRejection() {
        authCalls += 1
        return 401
      },
    },
    path: '/another-plugin/status',
  })
  try {
    const { response, state } = responseRecorder()
    mounted.route().handler(realRequest(), response)
    assert.equal(authCalls, 0)
    assert.equal(mounted.calls(), 1)
    assert.equal(state.status, 200)
  } finally {
    mounted.dispose()
  }
})

test('synthetic direct handler calls remain usable for Host composition tests', () => {
  let authCalls = 0
  const mounted = registerThroughBoundary({
    connection: {
      requestRejection() {
        authCalls += 1
        return 401
      },
    },
    path: '/_dsh/vision-router/product-state',
  })
  try {
    const { response, state } = responseRecorder()
    mounted.route().handler({ method: 'GET', headers: { host: 'localhost' } }, response)
    assert.equal(authCalls, 0)
    assert.equal(mounted.calls(), 1)
    assert.equal(state.status, 200)
  } finally {
    mounted.dispose()
  }
})

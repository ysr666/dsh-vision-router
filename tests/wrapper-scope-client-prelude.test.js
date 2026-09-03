import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WRAPPER_SCOPE_CLIENT_PRELUDE,
  injectWrapperScopeClientPrelude,
  installWrapperScopeClientPrelude,
} from '../lib/wrapper-scope-client-prelude.js'

test('wrapper scope compatibility prelude remains an inert tombstone', () => {
  assert.equal(WRAPPER_SCOPE_CLIENT_PRELUDE, '')

  const html = '<html><head></head><body>settings</body></html>'
  assert.equal(injectWrapperScopeClientPrelude(html), html)
})

test('wrapper scope compatibility installer cannot register a duplicate settings surface', () => {
  let touched = false
  const ctx = new Proxy({}, {
    get() {
      touched = true
      throw new Error('compatibility tombstone must not inspect the Host context')
    },
  })

  assert.doesNotThrow(() => installWrapperScopeClientPrelude(ctx))
  assert.equal(touched, false)
})

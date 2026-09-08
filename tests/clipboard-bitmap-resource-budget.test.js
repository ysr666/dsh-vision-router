import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLIENT_PRESENTATION_PRELUDE,
  transformBitmapDecodeBudget,
} from '../lib/client-presentation-boundary.js'
import {
  CLIENT_PRESENTATION_PRELUDE as BASE_CLIENT_PRESENTATION_PRELUDE,
} from '../lib/client-presentation-boundary-main.js'

test('clipboard BMP compatibility bounds decoded bytes before createImageBitmap', () => {
  const transformed = transformBitmapDecodeBudget(BASE_CLIENT_PRESENTATION_PRELUDE)

  assert.match(transformed, /maxBitmapDecodedBytes = 128 \* 1024 \* 1024/)
  assert.match(transformed, /maxBitmapBatchDecodedBytes = 256 \* 1024 \* 1024/)
  assert.match(transformed, /pixels \* 4 <= maxBitmapDecodedBytes/)
  assert.match(transformed, /decodedBytes > decodeBudget\.remaining/)
  assert.match(transformed, /decodeBudget\.remaining -= decodedBytes/)
})

test('clipboard BMP normalization is serialized instead of decoding a batch with Promise.all', () => {
  assert.doesNotMatch(
    CLIENT_PRESENTATION_PRELUDE,
    /Promise\.all\(files\.map\(function\(file\)\{[\s\S]*?normalizeFile\(file\)/,
  )
  assert.match(CLIENT_PRESENTATION_PRELUDE, /var normalizeChain = Promise\.resolve\(\)/)
  assert.match(CLIENT_PRESENTATION_PRELUDE, /normalizeChain = normalizeChain\.then\(function\(\)\{/)
  assert.match(CLIENT_PRESENTATION_PRELUDE, /normalizeFile\(file, decodeBudget\)/)
})

test('bitmap resource transform fails closed when the legacy anchor drifts', () => {
  assert.throws(
    () => transformBitmapDecodeBudget('not-the-legacy-prelude'),
    /bitmap limits transform anchor missing/,
  )
})

import {
  createCache,
  type CoreCache,
} from '../../../src/lib/core-cache.js'

const cache: CoreCache<{ readonly text: string }> = createCache(
  8,
  60_000,
  { maxBytes: 4096, maxEntryBytes: 1024 },
)

const accepted: boolean = cache.set('key', { text: 'value' })
const value: { readonly text: string } | undefined = cache.get('key')
const size: number = cache.size
const bytes: number = cache.bytes

void accepted
void value
void size
void bytes

// @ts-expect-error cache value type is owned by the instance
cache.set('other', 'not-an-object')

import {
  createBackgroundBenchmarkStopStoreCore,
  type BackgroundBenchmarkStopStore,
  type PersistentBackgroundFailureClass,
} from '../../../src/lib/vision-background-stop-store-core.js'

const store: BackgroundBenchmarkStopStore = createBackgroundBenchmarkStopStoreCore({
  file: '/tmp/background-stops.json',
  now: () => 1_000,
})

void store.mark({
  fingerprint: `ep2_${'a'.repeat(32)}`,
  key: 'provider/model',
  provider: 'provider',
  model: 'model',
  axis: 'ocr',
  errorClass: 'protocol',
  recordedAt: 1_000,
  expiresAt: 2_000,
})

const persistentClass: PersistentBackgroundFailureClass = 'unavailable'
void persistentClass

// @ts-expect-error auth is process-local and cannot enter the durable stop store
const invalidPersistentClass: PersistentBackgroundFailureClass = 'auth'
void invalidPersistentClass

void store.mark({
  fingerprint: `ep2_${'b'.repeat(32)}`,
  key: 'provider/model',
  provider: 'provider',
  model: 'model',
  // @ts-expect-error ui has no direct benchmark axis and cannot key durable benchmark evidence
  axis: 'ui',
  errorClass: 'protocol',
  recordedAt: 1_000,
  expiresAt: 2_000,
})

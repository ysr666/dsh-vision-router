import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dvrRoot = path.resolve(here, '..')
const dshRoot = path.resolve(process.env.DSH_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')

const expectedVersion = String(process.env.DSH_EXPECTED_VERSION || '').trim()
const expectedCommit = String(process.env.DSH_EXPECTED_COMMIT || '').trim()
if (!expectedVersion) throw new Error('DSH_EXPECTED_VERSION is required')
if (!expectedCommit) throw new Error('DSH_EXPECTED_COMMIT is required')

const MiB = 1024 * 1024
const DVR_POLICY = Object.freeze({
  maxImageBytes: 20 * MiB,
  maxImagePixels: 100_000_000,
  maxImageDimension: 10_000,
  normalizedImageMaxBytes: 20 * MiB,
  normalizedImageMaxPixels: 100_000_000,
  normalizedImageMaxDimension: 10_000,
})

const importSource = (relative) => import(pathToFileURL(path.join(dshRoot, relative)).href)
const [attachmentLocal, compat, adapterCompat] = await Promise.all([
  importSource('packages/attachment/attachment-local/src/index.ts'),
  import(pathToFileURL(path.join(dvrRoot, 'lib/dsh-contract-compat.js')).href),
  import(pathToFileURL(path.join(dvrRoot, 'lib/adapter-update-coalescer.js')).href),
])

const rootManifest = JSON.parse(await readFile(path.join(dshRoot, 'package.json'), 'utf8'))
assert.equal(rootManifest.version, expectedVersion, `expected DSH ${expectedVersion}`)
assert.equal(rootManifest.packageManager, 'pnpm@11.7.0')

// 1. The exact canary Host schema must retain every bundle field. This also
// protects the field names from drifting under us in a later source canary.
const resolved = attachmentLocal.LocalAttachmentStore.Config(DVR_POLICY)
for (const [key, value] of Object.entries(DVR_POLICY)) {
  assert.equal(resolved[key], value, `canary Host did not retain ${key}`)
}

// 2. Reproduce a real stale pre-alpha profile row. Because Cordis patch rows
// replace a whole config object, omitted alpha fields materialize as Host
// defaults instead of inheriting the newer bundle row.
const staleResolved = attachmentLocal.LocalAttachmentStore.Config({
  maxImageBytes: DVR_POLICY.maxImageBytes,
  maxImagePixels: DVR_POLICY.maxImagePixels,
})
assert.equal(staleResolved.maxImageDimension, attachmentLocal.DEFAULT_MAX_IMAGE_DIMENSION)
assert.equal(staleResolved.normalizedImageMaxPixels, attachmentLocal.DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS)
assert.equal(staleResolved.normalizedImageMaxDimension, attachmentLocal.DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION)
assert.equal(staleResolved.normalizedImageMaxBytes, attachmentLocal.DEFAULT_NORMALIZED_IMAGE_MAX_BYTES)

const staleNormalization = Object.freeze({
  maxPixels: staleResolved.normalizedImageMaxPixels,
  maxDimension: staleResolved.normalizedImageMaxDimension,
  maxBytes: staleResolved.normalizedImageMaxBytes,
})
const staleStore = Object.create(attachmentLocal.LocalAttachmentStore.prototype)
staleStore.imageLimits = Object.freeze({
  maxImageBytes: staleResolved.maxImageBytes,
  maxImagesPerMessage: staleResolved.maxImagesPerMessage,
  maxMessageImageBytes: staleResolved.maxMessageImageBytes,
  maxImagePixels: staleResolved.maxImagePixels,
  maxImageDimension: staleResolved.maxImageDimension,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
})
staleStore.normalizationPolicy = staleNormalization

const migrated = compat.ensureVisionAttachmentAdmissionPolicy({
  get(name) { return name === 'attachments' ? staleStore : undefined },
})
assert.equal(migrated.changed, true)
assert.equal(migrated.reason, 'legacy-alpha-policy-repaired')
assert.equal(staleStore.imageLimits.maxImageDimension, DVR_POLICY.maxImageDimension)
assert.deepEqual(staleStore.normalizationPolicy, {
  maxPixels: DVR_POLICY.normalizedImageMaxPixels,
  maxDimension: DVR_POLICY.normalizedImageMaxDimension,
  maxBytes: DVR_POLICY.normalizedImageMaxBytes,
})

// 3. Exercise the canary's actual normalization pipeline, not a hand-written
// size comparison. A clean 4096x2048 image exceeds the stale 4.2MP policy;
// the stale policy must shrink it, while the migrated DVR policy must retain
// its canonical pixel dimensions and byte-identical clean source.
const alphaRequire = createRequire(path.join(dshRoot, 'package.json'))
const sharpModule = alphaRequire('sharp')
const sharp = sharpModule.default ?? sharpModule
const source = new Uint8Array(await sharp({
  create: {
    width: 4096,
    height: 2048,
    channels: 4,
    background: { r: 17, g: 31, b: 47, alpha: 1 },
  },
}).png().toBuffer())

const stalePrepared = await attachmentLocal.prepareImageFile(
  { data: source, mediaType: 'image/png', name: 'alpha-contract.png' },
  staleStore.imageLimits,
  staleNormalization,
)
assert.ok(stalePrepared.ref.width < 4096 || stalePrepared.ref.height < 2048)
assert.deepEqual(stalePrepared.ref.originalDimensions, { width: 4096, height: 2048 })

const migratedPrepared = await attachmentLocal.prepareImageFile(
  { data: source, mediaType: 'image/png', name: 'alpha-contract.png' },
  staleStore.imageLimits,
  staleStore.normalizationPolicy,
)
assert.equal(migratedPrepared.ref.width, 4096)
assert.equal(migratedPrepared.ref.height, 2048)
assert.equal(migratedPrepared.ref.originalDimensions, undefined)
assert.equal(Buffer.compare(Buffer.from(migratedPrepared.data), Buffer.from(source)), 0)

// 4. The exact canary LLM runtime calls adapter.imageRequestPricing()
// synchronously without optional-chaining the method itself. Reproduce that
// call shape through DVR's private registration boundary so every duck-typed
// adapter receives LlmAdapter's `undefined` default before registration.
const llmSource = await readFile(path.join(dshRoot, 'packages/llm/llm/src/index.ts'), 'utf8')
assert.match(
  llmSource,
  /imageRequestPricing\(_provider: string, _model: string\): LlmImageRequestPricing \| undefined \{\s*return undefined/,
)
assert.match(
  llmSource,
  /this\.adapters\.get\(provider\)\?\.adapter\.imageRequestPricing\(provider, model\)/,
)
const alphaRegistrations = new Map()
const alphaLikeLlm = {
  registerAdapter(providers, adapter) {
    for (const provider of providers) alphaRegistrations.set(provider, adapter)
    return () => {}
  },
  imageRequestPricing(provider, model) {
    return alphaRegistrations.get(provider)?.imageRequestPricing(provider, model)
  },
}
const alphaCompatCtx = adapterCompat.contextWithCoalescedAdapterUpdates({
  llm: alphaLikeLlm,
  on() { return () => {} },
})
for (const provider of [
  'deepseek-official-native',
  'deepseek-official',
  'vision-http',
  'deepseek-vision',
  'third-party-vision',
  'vision-chain',
]) {
  alphaCompatCtx.llm.registerAdapter([provider], { async *stream() {} })
  assert.equal(alphaLikeLlm.imageRequestPricing(provider, 'model'), undefined)
}

// 5. The two client/Web bridges must point at exact public canary seams. Keep
// this source-level evidence next to the runtime behavioral tests in DVR.
const [sessionControllerSource, remoteEventsSource, connectionRpcSource] = await Promise.all([
  readFile(path.join(dshRoot, 'packages/api/session-controller/src/index.ts'), 'utf8'),
  readFile(path.join(dshRoot, 'packages/api/remotes/src/remote-events.ts'), 'utf8'),
  readFile(path.join(dshRoot, 'packages/client/connection/src/rpc.ts'), 'utf8'),
])
assert.match(sessionControllerSource, /@Remote\(['"]modelCatalog['"]\)/)
assert.match(sessionControllerSource, /modelCatalog\(\): Promise<ModelCatalog>/)
assert.match(remoteEventsSource, /['"]credentials\/reference-updated['"]/)
assert.match(connectionRpcSource, /requestRejection\(request: ConnectionTrustRequest\): ConnectionRequestRejection/)

console.log(JSON.stringify({
  ok: true,
  dsh: expectedVersion,
  canaryCommit: expectedCommit,
  platform: process.platform,
  node: process.version,
  staleCanonical: [stalePrepared.ref.width, stalePrepared.ref.height],
  migratedCanonical: [migratedPrepared.ref.width, migratedPrepared.ref.height],
}))

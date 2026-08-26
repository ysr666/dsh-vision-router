import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const hostDir = process.env.HOST_DIR
if (!hostDir) throw new Error('HOST_DIR is required')
const requireFromHost = createRequire(path.join(hostDir, 'package.json'))
const expectBatch = process.env.EXPECT_BATCH === 'true'
const expectDimension = process.env.EXPECT_DIMENSION === 'true'
const expectCurrent = process.env.EXPECT_CURRENT === 'true'

const pluginEntry = requireFromHost.resolve('dsh-vision-router')
const plugin = await import(pathToFileURL(pluginEntry).href)
assert.equal(typeof plugin.apply, 'function', 'packaged public entry must export apply()')
assert.ok(plugin.Config, 'packaged public entry must export Config')

const { hasBatchAttachmentContract } = plugin
assert.equal(typeof hasBatchAttachmentContract, 'function')
assert.equal(hasBatchAttachmentContract({ attachments: {} }), false)
assert.equal(hasBatchAttachmentContract({ attachments: { saveImages() {} } }), true)
assert.equal(expectBatch, hasBatchAttachmentContract({ attachments: expectBatch ? { saveImages() {} } : {} }))

const attachmentLocalEntry = requireFromHost.resolve('@deepseek-ai/dsh-attachment-local')
const attachmentLocal = await import(pathToFileURL(attachmentLocalEntry).href)
const AttachmentLocal = attachmentLocal.default
assert.ok(AttachmentLocal?.Config, 'attachment-local Config must be exported')
const parsed = AttachmentLocal.Config({ maxImageDimension: 10_000 })
if (expectDimension) {
  assert.equal(parsed.maxImageDimension, 10_000, 'Host must preserve maxImageDimension')
  assert.throws(() => AttachmentLocal.Config({ maxImageDimension: 10_001 }))
} else {
  assert.equal(Object.hasOwn(parsed, 'maxImageDimension'), false, 'legacy Host must not pretend to expose maxImageDimension')
}

const llmEntry = requireFromHost.resolve('@deepseek-ai/dsh-llm')
const llm = await import(pathToFileURL(llmEntry).href)
assert.equal(typeof llm.default, 'function', 'DSH LLM runtime must be exported')
assert.equal(typeof llm.default.prototype.registerAdapter, 'function', 'adapter registration seam must exist')

if (expectCurrent) {
  const llmRequire = createRequire(llmEntry)
  const cordisEntry = llmRequire.resolve('@deepseek-ai/cordis')
  const { Context } = await import(pathToFileURL(cordisEntry).href)
  const ctx = new Context()
  await ctx.plugin(llm.default)

  const adapter = {
    providerInfo(provider) { return { id: provider, name: provider } },
    providerRetryPolicy() { return undefined },
    listModels() { return Promise.resolve([]) },
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) },
    prepareCall(provider, model) {
      return Promise.resolve({
        model: { provider, id: model, name: model },
        stream: (options) => this.stream(options),
      })
    },
    async * stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const registration = ctx.llm.registerAdapter(['vision-router-p0-a'], adapter)
  assert.equal(typeof registration, 'function', 'adapter registration must return a disposer')
  assert.equal(typeof registration.replace, 'function', 'current Host registration must support atomic replace()')
  registration.replace(['vision-router-p0-b'])
  assert.equal(ctx.llm.listProviders().some((item) => item.id === 'vision-router-p0-b'), true)
  assert.equal(typeof ctx.llm.prepareCall, 'function', 'current Host must expose prepareCall()')
  const prepared = await ctx.llm.prepareCall({ provider: 'vision-router-p0-b', model: 'probe-model' })
  assert.equal(typeof prepared.stream, 'function')
  registration()
  assert.equal(ctx.llm.listProviders().some((item) => item.id === 'vision-router-p0-b'), false, 'registration disposer must clean up the route')

  const settingsEntry = requireFromHost.resolve('@deepseek-ai/dsh-settings')
  const settings = await import(pathToFileURL(settingsEntry).href)
  const settingsCtx = new Context()
  await settingsCtx.plugin(settings.default)
  const scope = settingsCtx.settings.register('vision-router-p0-probe', plugin.Config, { base: {} })
  assert.equal(typeof scope.get, 'function', 'settings registration must expose live get()')
  assert.equal(typeof scope.watch, 'function', 'settings registration must expose watch()')
  assert.equal(typeof scope.get(), 'object')
  const disposeWatch = scope.watch(() => {})
  assert.equal(typeof disposeWatch, 'function')
  disposeWatch()
}

console.log(`DSH Host contract smoke passed: batch=${expectBatch} dimension=${expectDimension} current=${expectCurrent}`)

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const hostDir = process.env.HOST_DIR ?? process.env.DSH_CONTRACT_HOST_DIR
if (!hostDir) throw new Error('HOST_DIR or DSH_CONTRACT_HOST_DIR is required')
const requireFromHost = createRequire(path.join(hostDir, 'package.json'))
const expectBatch = process.env.EXPECT_BATCH === 'true'
const expectDimension = process.env.EXPECT_DIMENSION === 'true'
const expectCurrent = process.env.EXPECT_CURRENT === 'true'
const expectSettingsMode = process.env.EXPECT_SETTINGS_MODE ?? 'native-register'
const expectSessionEventRead = process.env.EXPECT_SESSION_EVENT_READ === 'true'
const expectSessionLogRead = process.env.EXPECT_SESSION_LOG_READ === 'true'

const pluginEntry = requireFromHost.resolve('dsh-vision-router')
const plugin = await import(pathToFileURL(pluginEntry).href)
const { inspectDshHostCapabilities } = await import(
  pathToFileURL(path.join(path.dirname(pluginEntry), 'dsh-host-capabilities.js')).href
)
assert.equal(typeof plugin.apply, 'function', 'packaged public entry must export apply()')
assert.ok(plugin.Config, 'packaged public entry must export Config')

const attachmentEntry = requireFromHost.resolve('@deepseek-ai/dsh-attachment')
const attachment = await import(pathToFileURL(attachmentEntry).href)
const attachmentStore = Object.create(attachment.default.prototype)
const { hasBatchAttachmentContract, hostOwnsOfficialDeepSeekProvider } = plugin
assert.equal(typeof hasBatchAttachmentContract, 'function')
assert.equal(typeof hostOwnsOfficialDeepSeekProvider, 'function')
const contractCtx = { get(name) { return name === 'attachments' ? attachmentStore : undefined } }
assert.equal(
  hasBatchAttachmentContract(contractCtx),
  expectBatch,
  'batch attachment capability must match the released Host prototype',
)
assert.equal(
  hostOwnsOfficialDeepSeekProvider(contractCtx),
  expectBatch,
  'official DeepSeek ownership must track the batch-attachment Host generation',
)

const attachmentLocalEntry = requireFromHost.resolve('@deepseek-ai/dsh-attachment-local')
const attachmentLocal = await import(pathToFileURL(attachmentLocalEntry).href)
const AttachmentLocal = attachmentLocal.default
assert.ok(AttachmentLocal?.Config, 'attachment-local Config must be exported')
// The bundle deliberately carries maxImageDimension through the same row used
// by every supported Host. Older Schemastery versions may preserve an unknown
// field as parser input, so field presence is not a valid negative capability
// probe. The positive admission contract is asserted only where the Host owns
// the dimension policy (rc.8+), matching the long-standing CI smoke.
const parsed = AttachmentLocal.Config({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 100_000_000,
  maxImageDimension: 10_000,
})
if (expectDimension) {
  assert.equal(parsed.maxImageDimension, 10_000, 'Host must preserve maxImageDimension')
}

if (expectSessionEventRead) {
  const sessionQueryEntry = requireFromHost.resolve('@deepseek-ai/dsh-session-query')
  const sessionQuery = await import(pathToFileURL(sessionQueryEntry).href)
  assert.equal(
    typeof sessionQuery.default?.prototype?.readEvent,
    'function',
    'rc8+ Host contract must expose bounded async sessionQuery.readEvent()',
  )
}

if (expectSessionLogRead) {
  const sessionQueryEntry = requireFromHost.resolve('@deepseek-ai/dsh-session-query')
  const sessionQuery = await import(pathToFileURL(sessionQueryEntry).href)
  assert.equal(
    typeof sessionQuery.default?.prototype?.readSession,
    'function',
    'rc8+ Host contract must expose async replay-validated sessionQuery.readSession()',
  )
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
  const llmCapabilities = inspectDshHostCapabilities(ctx)
  assert.equal(llmCapabilities.adapterRegistration, true, 'Doctor must recognize current DSH adapter registration')
  assert.equal(llmCapabilities.registrationReplace, 'unknown', 'read-only Doctor must not manufacture a route to prove replace()')
  assert.equal(llmCapabilities.prepareCall, true, 'Doctor must recognize current DSH prepareCall()')

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

  const sessionEntry = requireFromHost.resolve('@deepseek-ai/dsh-session')
  const sessionApi = await import(pathToFileURL(sessionEntry).href)
  assert.equal(typeof sessionApi.Session?.create, 'function', 'current DSH Session.create() must be exported')
  assert.equal(typeof plugin.sessionSurfaceReplacementIntent, 'function', 'plugin must expose its Session surface contract adapter')
  assert.equal(typeof llm.createUserMessage, 'function', 'current DSH createUserMessage() must be exported')
  const surfaceSession = sessionApi.Session.create(sessionApi.SessionId('vision-router-surface-contract'))
  const firstSurface = surfaceSession.append(
    'user/message',
    llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'before' }] }),
    { surfaceOp: 'append' },
  )
  const replacementIntent = plugin.sessionSurfaceReplacementIntent(surfaceSession, firstSurface.seq)
  assert.ok(replacementIntent, 'current Session format must have a reviewed replacement contract')
  const replacementSurface = surfaceSession.append(
    'user/message',
    llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'after' }] }),
    replacementIntent,
  )
  assert.deepEqual(
    [...surfaceSession.surface.nodes],
    [replacementSurface.seq],
    'real DSH Session validator must accept the plugin replacement intent and shadow the original node',
  )

  const settingsEntry = requireFromHost.resolve('@deepseek-ai/dsh-settings')
  const settings = await import(pathToFileURL(settingsEntry).href)
  assert.equal(typeof settings.default, 'function', 'DSH settings service must be exported')
  if (expectSettingsMode === 'native-register') {
    // The legacy/current stable SettingsProvider is a service definition: a
    // production Host mounts a storage-backed subclass. Mount the smallest real
    // subclass instead of invoking the abstract provider without persistence.
    class MemorySettings extends settings.default {
      get writable() { return true }
      load() { return Promise.resolve({}) }
      persist() { return Promise.resolve() }
    }
    const settingsCtx = new Context()
    await settingsCtx.plugin(MemorySettings)
    const settingsCapabilities = inspectDshHostCapabilities(settingsCtx)
    assert.equal(
      settingsCapabilities.settingsLiveNamespace,
      true,
      'Doctor must recognize the native SettingsProvider register() live-namespace seam',
    )
    const scope = settingsCtx.settings.register('vision-router-p0-probe', plugin.Config, { base: {} })
    assert.equal(typeof scope.get, 'function', 'settings registration must expose live get()')
    assert.equal(typeof scope.watch, 'function', 'settings registration must expose watch()')
    assert.equal(typeof scope.get(), 'object')
    const disposeWatch = scope.watch(() => {})
    assert.equal(typeof disposeWatch, 'function')
    disposeWatch()
  } else if (expectSettingsMode === 'config-editor') {
    // DSH 0.1.7 removes SettingsProvider.register(). Its reviewed replacement
    // is SettingsForms.describe() backed by ConfigEditor configuration()/edit();
    // DVR turns those side-effect-free observable seams into the mature namespace.
    const settingsPrototype = settings.default.prototype
    assert.equal(typeof settingsPrototype.describe, 'function', 'SettingsForms must expose describe()')
    const settingsRequire = createRequire(settingsEntry)
    const configEditorEntry = settingsRequire.resolve('@deepseek-ai/dsh-config-editor')
    const configEditor = await import(pathToFileURL(configEditorEntry).href)
    assert.equal(typeof configEditor.default, 'function', 'DSH ConfigEditor must be exported')
    assert.equal(typeof configEditor.default.prototype.configuration, 'function', 'ConfigEditor must expose configuration()')
    assert.equal(typeof configEditor.default.prototype.edit, 'function', 'ConfigEditor must expose edit()')
    const settingsCapabilities = inspectDshHostCapabilities({
      get(name) {
        if (name === 'settings') return settingsPrototype
        if (name === 'configEditor') return configEditor.default.prototype
        return undefined
      },
    })
    assert.equal(
      settingsCapabilities.settingsLiveNamespace,
      true,
      'Doctor must recognize the reviewed SettingsForms + ConfigEditor live-namespace replacement',
    )
  } else {
    throw new Error(`unknown EXPECT_SETTINGS_MODE ${JSON.stringify(expectSettingsMode)}`)
  }

  const toolsEntry = requireFromHost.resolve('@deepseek-ai/dsh-tools')
  const systemPromptEntry = requireFromHost.resolve('@deepseek-ai/dsh-system-prompt')
  const tools = await import(pathToFileURL(toolsEntry).href)
  const systemPrompt = await import(pathToFileURL(systemPromptEntry).href)
  const toolsCtx = new Context()
  await toolsCtx.plugin(systemPrompt.default)
  await toolsCtx.plugin(tools.default)
  const toolCapabilities = inspectDshHostCapabilities(toolsCtx)
  assert.equal(toolCapabilities.toolRegistration, true, 'Doctor must recognize current DSH tool registration')
  assert.equal(toolCapabilities.toolExecution, true, 'Doctor must recognize current DSH tool execution')
  const probeTool = tools.defineTool({
    name: 'vision_router_p0_echo',
    description: 'P0 Host contract probe',
    parameters: { text: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) { return args.text ?? '' },
  })
  const disposeTool = toolsCtx.tools.register(probeTool)
  assert.equal(typeof disposeTool, 'function', 'tool registration must return a disposer')
  assert.equal(toolsCtx.tools.schemas().some((item) => item.name === probeTool.name), true)
  const toolResult = await toolsCtx.tools.execute({
    callId: 'vision-router-p0-call',
    name: probeTool.name,
    arguments: { text: 'ok' },
    signal: new AbortController().signal,
  })
  assert.deepEqual(toolResult, {
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    value: 'ok',
  })
  disposeTool()
  assert.equal(toolsCtx.tools.schemas().some((item) => item.name === probeTool.name), false, 'tool disposer must clean up registration')
}

console.log(`DSH Host contract smoke passed: batch=${expectBatch} dimension=${expectDimension} current=${expectCurrent} sessionEventRead=${expectSessionEventRead} sessionLogRead=${expectSessionLogRead}`)

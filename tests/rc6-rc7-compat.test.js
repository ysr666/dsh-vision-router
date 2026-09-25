import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config as EntryConfig, SETTINGS_CONTRACT_REVISION } from '../entry.js'
import { eventHasImage } from '../index.js'
import { classifyWebModulesRows } from '../scripts/dsh-web-modules-overlay-contract.mjs'
import { classifyWebConnectionRows } from '../scripts/dsh-web-connection-overlay-contract.mjs'
import {
  attachmentContextForContract,
  createSessionEventReader,
  createSessionEventTailReader,
  createSessionLogReader,
  hasBatchAttachmentContract,
  hostOwnsOfficialDeepSeekProvider,
  installHostSettingsCompatibility,
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectHostProviderOwnership,
  protectRc7ProviderOwnership,
} from '../lib/dsh-contract-compat.js'

function runtimeWithAttachments(attachments, llm = {}) {
  return {
    llm,
    get(name) {
      return name === 'attachments' ? attachments : undefined
    },
  }
}

test('contract detection follows the released attachment API, not unrelated LLM methods', () => {
  const single = runtimeWithAttachments(
    { saveImage() {}, readImage() {}, validateImage() {} },
    { registerConfigurableProviders() {} },
  )
  const batch = runtimeWithAttachments(
    { saveImage() {}, saveImages() {}, readImage() {}, validateImage() {} },
    { registerConfigurableProviders() {} },
  )
  assert.equal(hasBatchAttachmentContract(single), false)
  assert.equal(hasBatchAttachmentContract(batch), true)
  assert.equal(hasBatchAttachmentContract({ llm: { registerConfigurableProviders() {} } }), false)
  assert.equal(isRc7ContractRuntime, hasBatchAttachmentContract)
})

test('official DeepSeek ownership follows the same batch-attachment Host generation fact', () => {
  const single = runtimeWithAttachments({ saveImage() {}, readImage() {} })
  const batch = runtimeWithAttachments({ saveImage() {}, saveImages() {}, readImage() {} })
  assert.equal(hostOwnsOfficialDeepSeekProvider(single), false)
  assert.equal(hostOwnsOfficialDeepSeekProvider(batch), true)
})


test('bounded Session event reader follows the live Host service and keeps missing capability explicit', async () => {
  let query
  const ctx = {
    get(name) { return name === 'sessionQuery' ? query : undefined },
  }
  const read = createSessionEventReader(ctx)
  const session = { id: 'session-reader' }

  assert.deepEqual(await read(session, 3), { supported: false })

  const requests = []
  query = {
    async readEvent(request) {
      requests.push(request)
      return { target: { seq: request.seq, type: 'user/message', data: { id: 'x' } } }
    },
  }
  assert.deepEqual(await read(session, 3), {
    supported: true,
    event: { seq: 3, type: 'user/message', data: { id: 'x' } },
  })
  assert.deepEqual(requests, [{ sessionId: 'session-reader', seq: 3 }])
})

test('bounded Session event reader propagates advertised Host failures instead of masking them', async () => {
  const failure = new Error('query unavailable')
  const read = createSessionEventReader({
    sessionQuery: {
      async readEvent() { throw failure },
    },
  })
  await assert.rejects(() => read({ id: 'session-reader' }, 0), (error) => error === failure)
  await assert.rejects(() => read({ id: 'session-reader' }, -1), /non-negative safe integer/)
})


test('bounded Session tail reader adapts to Host window limits and returns only events after the anchor', async () => {
  const events = Array.from({ length: 5 }, (_, seq) => ({ seq, type: 'user/message', data: { seq } }))
  const requests = []
  const query = {
    async readEvent(request) {
      requests.push({ ...request })
      const after = request.after ?? 0
      if (after > 2) {
        const error = new Error('window too large')
        error.code = 'SESSION_QUERY_INVALID_WINDOW'
        throw error
      }
      if (request.seq >= events.length) {
        const error = new Error('event missing')
        error.code = 'SESSION_QUERY_EVENT_NOT_FOUND'
        throw error
      }
      const windowEvents = events.slice(request.seq, Math.min(events.length, request.seq + after + 1))
      return {
        target: events[request.seq],
        events: windowEvents,
        startSeq: request.seq,
        endSeq: windowEvents.at(-1).seq,
      }
    },
  }
  const readTail = createSessionEventTailReader({ sessionQuery: query })
  const session = { id: 'tail-reader' }
  const result = await readTail(session, 1)
  assert.equal(result.supported, true)
  assert.equal(result.capturedThroughSeq, 4)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.events.map((event) => event.seq), [2, 3, 4])
  assert.equal(requests.some((request) => (request.after ?? 0) > 2), true, 'reader must negotiate a lowered Host window')

  const requestCount = requests.length
  const captureOnly = await readTail(session, 3, { collect: false })
  assert.deepEqual(captureOnly.events, [])
  assert.equal(captureOnly.capturedThroughSeq, 4)
  assert.equal(requests.length > requestCount, true)
  assert.equal((requests.at(requestCount).after ?? 0) <= 2, true, 'accepted window hint should be reused')
})


test('bounded Session tail reader supports a Host configured with readWindowMax zero', async () => {
  const events = Array.from({ length: 4 }, (_, seq) => ({ seq, type: 'step/start', data: { seq } }))
  const requests = []
  const readTail = createSessionEventTailReader({
    sessionQuery: {
      async readEvent(request) {
        requests.push({ ...request })
        if ((request.after ?? 0) > 0) {
          const error = new Error('window disabled')
          error.code = 'SESSION_QUERY_INVALID_WINDOW'
          throw error
        }
        const event = events[request.seq]
        if (!event) {
          const error = new Error('tail reached')
          error.code = 'SESSION_QUERY_EVENT_NOT_FOUND'
          throw error
        }
        return { target: event, events: [event], startSeq: request.seq, endSeq: request.seq }
      },
    },
  })

  const result = await readTail({ id: 'zero-window' }, 1)
  assert.deepEqual(result.events.map((event) => event.seq), [2, 3])
  assert.equal(result.capturedThroughSeq, 3)
  assert.equal(result.truncated, false)
  assert.equal(requests.at(-1).seq, 4, 'exact-seq walk must terminate on the first missing tail event')
  assert.equal(requests.at(-2).after, undefined)
})


test('bounded Session tail reader fails closed on a sparse or shape-drifted Host window', async () => {
  const readSparse = createSessionEventTailReader({
    sessionQuery: {
      async readEvent(request) {
        return {
          target: { seq: request.seq, type: 'step/start', data: {} },
          events: [
            { seq: request.seq, type: 'step/start', data: {} },
            { seq: request.seq + 2, type: 'tool/result', data: {} },
          ],
          endSeq: request.seq + 2,
        }
      },
    },
  })
  await assert.rejects(
    () => readSparse({ id: 'sparse-window' }, 4),
    /non-contiguous seq 6; expected 5/,
  )

  const readMissingWindow = createSessionEventTailReader({
    sessionQuery: {
      async readEvent(request) {
        return { target: { seq: request.seq, type: 'step/start', data: {} } }
      },
    },
  })
  await assert.rejects(
    () => readMissingWindow({ id: 'missing-window' }, 4),
    /returned no event window/,
  )
})

test('bounded Session tail reader keeps missing capability explicit and propagates real failures', async () => {
  const readMissing = createSessionEventTailReader({ get() { return undefined } })
  assert.deepEqual(await readMissing({ id: 'tail-reader' }, 0), { supported: false })

  const failure = new Error('session query unavailable')
  const readFailing = createSessionEventTailReader({
    sessionQuery: { async readEvent() { throw failure } },
  })
  await assert.rejects(() => readFailing({ id: 'tail-reader' }, 0), (error) => error === failure)
  await assert.rejects(() => readFailing({ id: 'tail-reader' }, -1), /non-negative safe integer/)
})


test('async Session log reader prefers one observation lease and disposes it after materialization', async () => {
  let query
  const ctx = { get(name) { return name === 'sessionQuery' ? query : undefined } }
  const read = createSessionLogReader(ctx)
  const session = { id: 'session-log-reader' }

  assert.deepEqual(await read(session), { supported: false })
  let readSessionCalls = 0
  let disposed = 0
  const events = [{ seq: 0, type: 'user/message', data: {} }]
  query = {
    async observeSession(sessionId, options) {
      assert.equal(sessionId, session.id)
      assert.deepEqual(options, { projectionMode: 'none' })
      return {
        header: { id: sessionId },
        events,
        [Symbol.dispose]() { disposed += 1 },
      }
    },
    async readSession() {
      readSessionCalls += 1
      throw new Error('observeSession must be preferred')
    },
  }
  assert.deepEqual(await read(session), { supported: true, events })
  assert.equal(readSessionCalls, 0)
  assert.equal(disposed, 1)

  query = {
    async observeSession() {
      return { header: { id: 'other' }, events: [], [Symbol.dispose]() { disposed += 1 } }
    },
  }
  await assert.rejects(() => read(session), /returned session other/)
  assert.equal(disposed, 2)
})

test('async Session log reader falls back to readSession when observation capability is absent', async () => {
  const events = [{ seq: 0, type: 'user/message', data: {} }]
  const read = createSessionLogReader({
    sessionQuery: {
      async readSession(sessionId) {
        return { session: { id: sessionId }, events }
      },
    },
  })
  assert.deepEqual(await read({ id: 'session-log-reader' }), { supported: true, events })
})

test('async Session log reader propagates advertised Host failures instead of masking them', async () => {
  const failure = new Error('session log unavailable')
  const read = createSessionLogReader({
    sessionQuery: {
      async observeSession() { throw failure },
      async readSession() { throw new Error('must not mask an advertised observation failure') },
    },
  })
  await assert.rejects(() => read({ id: 'session-log-reader' }), (error) => error === failure)
})

test('host provider ownership blocks only synthetic official routes', () => {
  const registered = []
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        registered.push({ routes, adapter })
        return () => {}
      },
    },
  }
  const wrapped = protectHostProviderOwnership(ctx)
  const adapter = {}
  wrapped.llm.registerAdapter(['vision-http'], adapter)
  assert.deepEqual(registered, [{ routes: ['vision-http'], adapter }])
  assert.throws(
    () => wrapped.llm.registerAdapter(['deepseek-official-native'], {}),
    (error) => error?.code === 'DSH_HOST_PROVIDER_OWNERSHIP',
  )
  assert.throws(
    () => wrapped.llm.registerAdapter(['deepseek-official'], {}),
    (error) => error?.code === 'DSH_HOST_PROVIDER_OWNERSHIP',
  )
  assert.equal(protectRc7ProviderOwnership, protectHostProviderOwnership)
})

test('host settings bridge uses the common public SettingsProvider seam and masks legacy stealth', () => {
  let value = { foo: 'user', stealth: true }
  let serviceWatcher
  let observed
  let cleanup
  const scope = {
    get() {
      return value
    },
    watch(callback) {
      serviceWatcher = callback
      return () => {
        serviceWatcher = undefined
      }
    },
  }
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['settings'])
      callback({
        settings: {
          register(namespace, _Config, options) {
            assert.equal(namespace, 'vision-router')
            assert.deepEqual(options.base, { foo: 'base', stealth: true })
            return scope
          },
        },
        effect(factory) {
          cleanup = factory()
        },
      })
    },
  }
  const wrapped = installHostSettingsCompatibility(ctx, { foo: 'base', stealth: true }, {
    Config: { name: 'fake-schema' },
    namespace: 'vision-router',
  })
  wrapped.inject(['settings'], (sctx) => {
    const compatScope = sctx.settings.register('vision-router')
    assert.deepEqual(compatScope.get(), { foo: 'user', stealth: false })
    compatScope.watch((next) => {
      observed = next
    })
  })
  value = { foo: 'changed', stealth: true }
  serviceWatcher()
  assert.deepEqual(observed, { foo: 'changed', stealth: false })
  cleanup()
  assert.equal(serviceWatcher, undefined)
  assert.equal(installRc7SettingsCompatibility, installHostSettingsCompatibility)
})

test('host settings bridge registers the final entry settings contract including v2 routing fields', () => {
  let registeredConfig
  const scope = { get() { return EntryConfig({}) }, watch() { return () => {} } }
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['settings'])
      callback({
        settings: {
          register(namespace, Config) {
            assert.equal(namespace, 'vision-router')
            registeredConfig = Config
            return scope
          },
        },
        effect(factory) { factory() },
      })
    },
  }

  installHostSettingsCompatibility(ctx, {}, {
    Config: EntryConfig,
    namespace: 'vision-router',
  })

  assert.equal(SETTINGS_CONTRACT_REVISION, 7)
  assert.equal(registeredConfig, EntryConfig)
  assert.equal(registeredConfig({}).allowRemoteSettings, false)
  assert.equal(registeredConfig({ allowRemoteSettings: true }).allowRemoteSettings, true)
  assert.equal(registeredConfig({}).settingsContractRevision, SETTINGS_CONTRACT_REVISION)
  assert.equal(registeredConfig({}).visionDepth, 'standard')
  assert.equal(registeredConfig({ visionDepth: 'custom', visionDepthMaxCalls: 7 }).visionDepth, 'custom')
  assert.equal(registeredConfig({ visionDepth: 'custom', visionDepthMaxCalls: 7 }).visionDepthMaxCalls, 7)
  assert.equal(registeredConfig({}).routingMode, 'ordered')
  assert.equal(registeredConfig({}).routingPreference, 'balanced')
  assert.equal(registeredConfig({}).backgroundBenchmarking, 'off')
  assert.equal(registeredConfig({ backgroundBenchmarking: 'local-free' }).backgroundBenchmarking, 'local-free')
  assert.equal(registeredConfig({ backgroundBenchmarking: 'all' }).backgroundBenchmarking, 'all')
  assert.equal(registeredConfig({ backgroundBenchmarking: 'off' }).backgroundBenchmarking, 'off')
})

test('attachment compatibility follows the batch-attachment seam', () => {
  const single = runtimeWithAttachments({ saveImage() {}, readImage() {}, validateImage() {} })
  const batch = runtimeWithAttachments({ saveImage() {}, saveImages() {}, readImage() {}, validateImage() {} })
  let installs = 0
  const installAndroidAttachmentCompat = (ctx) => {
    installs += 1
    return { ...ctx, compat: true }
  }
  const wrappedSingle = attachmentContextForContract(single, undefined, { installAndroidAttachmentCompat })
  const wrappedBatch = attachmentContextForContract(batch, undefined, { installAndroidAttachmentCompat })
  assert.equal(wrappedSingle.compat, true)
  assert.equal(wrappedBatch, batch)
  assert.equal(installs, 1)
})

test('DSH image/offload bookkeeping is not itself classified as new visual input', () => {
  const offload = {
    type: 'image/offload',
    data: { targets: [{ seq: 3, occurrences: [0, 2] }] },
  }
  assert.equal(eventHasImage(offload), false)
})

test('same-turn tool image events remain detectable after the offload generation', () => {
  const toolResult = {
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          content: [{
            type: 'image',
            attachment: { attachmentId: 'sha256:0123456789abcdef0123456789abcdef' },
          }],
        }],
      },
    },
  }
  assert.equal(eventHasImage(toolResult), true)
})

test('mid-turn image recovery uses an async captured tail on modern Hosts and keeps legacy indexing isolated', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /sessionEventTailReader\(session, anchorSeq, \{ collect: false \}\)/)
  assert.match(source, /capturedThroughSeq:\s*tail\.capturedThroughSeq/)
  assert.match(source, /legacyStartIndex:\s*\(legacySessionEvents\(session\) \?\? \[\]\)\.length/)
  assert.match(source, /await refreshTurnImageState\(session, state\)/)
  assert.doesNotMatch(source, /state\.startIndex/)
})

test('settings compatibility keeps the first-class section without requiring a legacy plugin card', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /name: 'settings\.section'/)
  assert.match(source, /id: 'vision-router'/)
  assert.doesNotMatch(source, /name: 'settings\.plugin\.item'/)
  assert.doesNotMatch(source, /VisionRouterLegacyEntry/)
})

test('manifest publishes the DVR 2.2 rc8 host floor while admitting verified stable and preview host trains', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const expectedHostPeerRange = '^0.1.0-rc.8 || ^0.1.1-rc.1 || ^0.1.3-alpha.2 || 0.1.5-alpha.1 || 0.1.5-alpha.2 || 0.1.5-rc.1 || 0.1.5-rc.2 || 0.1.5-rc.3 || 0.1.6-alpha.1 || 0.1.7-rc.2'
  assert.equal(pkg.engines.node, '^22.19.0 || >=24.0.0')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm-deepseek'], expectedHostPeerRange)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-anonymous-user-id'], expectedHostPeerRange)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-settings'], undefined)
})

test('modules/webServer overlay lifecycle classifies required, retire-ready, and dangerous Host drift', () => {
  const base = { id: 'modules', name: '@deepseek-ai/dsh-client-modules' }
  assert.equal(classifyWebModulesRows([base]).status, 'shim-required')
  assert.equal(classifyWebModulesRows([{ ...base, inject: [] }]).status, 'shim-required')
  assert.equal(classifyWebModulesRows([{ ...base, inject: ['webServer'] }]).status, 'retire-ready')
  assert.equal(
    classifyWebModulesRows([{ ...base, inject: ['newCarrier', 'webServer'] }]).status,
    'retire-ready',
  )
  assert.equal(
    classifyWebModulesRows([{ ...base, inject: ['newCarrier'] }]).status,
    'dangerous-drift',
  )
  assert.equal(
    classifyWebModulesRows([{ ...base, name: '@deepseek-ai/renamed-modules' }]).status,
    'dangerous-drift',
  )
  assert.equal(classifyWebModulesRows([]).status, 'dangerous-drift')
})

test('web client modules wait for the official webServer carrier across supported Host trains', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(
    patch,
    /- id: modules\s+name: '@deepseek-ai\/dsh-client-modules'\s+inject: \[webServer\]/,
  )
})

test('connection/webServer overlay lifecycle classifies required, retire-ready, and dangerous Host drift', () => {
  const base = { id: 'connection', name: '@deepseek-ai/dsh-client-connection', inject: ['webRuntime'] }
  assert.equal(classifyWebConnectionRows([base]).status, 'shim-required')
  assert.equal(
    classifyWebConnectionRows([{ ...base, inject: ['webRuntime', 'webServer'] }]).status,
    'retire-ready',
  )
  assert.equal(
    classifyWebConnectionRows([{ ...base, inject: ['newCarrier', 'webRuntime', 'webServer'] }]).status,
    'retire-ready',
  )
  assert.equal(
    classifyWebConnectionRows([{ ...base, inject: ['webRuntime', 'newCarrier'] }]).status,
    'dangerous-drift',
  )
  assert.equal(
    classifyWebConnectionRows([{ ...base, inject: ['webServer'] }]).status,
    'dangerous-drift',
  )
  assert.equal(
    classifyWebConnectionRows([{ ...base, name: '@deepseek-ai/renamed-connection' }]).status,
    'dangerous-drift',
  )
  assert.equal(classifyWebConnectionRows([]).status, 'dangerous-drift')
})

test('web connection provider waits for both runtime trust and the Web route carrier', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(
    patch,
    /- id: connection\s+name: '@deepseek-ai\/dsh-client-connection'\s+inject: \[webRuntime, webServer\]/,
  )
})

test('release evidence gates keep stable and preview contracts capability-scoped', async () => {
  const [hostGate, browserGate, sourceGate, upstreamOverlayWatch] = await Promise.all([
    readFile(new URL('../.github/workflows/adversarial-compat-hardening.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-preview-browser-smoke.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-alpha-source-contract.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-upstream-web-modules-watch.yml', import.meta.url), 'utf8'),
  ])

  assert.match(hostGate, /dsh: \['0\.1\.5-rc\.3', '0\.1\.7-rc\.2'\]/)
  assert.match(hostGate, /Verify release-family Session native image process-restart lifecycle[\s\S]*?run: node scripts\/dsh-preview-native-lifecycle-contract\.mjs/)
  assert.doesNotMatch(hostGate, /if: matrix\.dsh ==/)
  assert.match(browserGate, /dsh: 0\.1\.5-rc\.1[\s\S]*?mixedGenericFiles: false/)
  assert.match(browserGate, /dsh: 0\.1\.5-rc\.3[\s\S]*?mixedGenericFiles: true/)
  assert.match(browserGate, /dsh: 0\.1\.5-alpha\.2[\s\S]*?mixedGenericFiles: true/)
  assert.match(browserGate, /dsh: 0\.1\.7-rc\.2[\s\S]*?mixedGenericFiles: true/)
  assert.match(browserGate, /if: matrix\.mixedGenericFiles/)
  assert.match(browserGate, /ref: 183f08e9c6dde7e36cd2318eaee70b0da08fb35e/)
  assert.match(browserGate, /ref: a4c74a91e06b00fe0b0937bde982170c526cc842/)
  assert.match(browserGate, /ref: dsh-v0\.1\.5-alpha\.2/)
  assert.match(browserGate, /ref: 477b4f420553e8a52c2fbccc464d7561b239c443/)
  assert.doesNotMatch(browserGate, /ref:\s*\$\{\{\s*matrix\./)

  assert.match(sourceGate, /name: DSH exact source contract/)
  assert.equal((sourceGate.match(/dsh: 0\.1\.5-rc\.1/g) ?? []).length, 3)
  assert.equal((sourceGate.match(/dsh: 0\.1\.5-rc\.3/g) ?? []).length, 3)
  assert.equal((sourceGate.match(/dsh: 0\.1\.5-alpha\.2/g) ?? []).length, 3)
  assert.equal((sourceGate.match(/dsh: 0\.1\.7-rc\.2/g) ?? []).length, 3)
  assert.equal((sourceGate.match(/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/g) ?? []).length, 2)
  assert.equal((sourceGate.match(/a4c74a91e06b00fe0b0937bde982170c526cc842/g) ?? []).length, 2)
  assert.equal((sourceGate.match(/b2e3b2a0125854567a4a5fcba75782e42fe84901/g) ?? []).length, 2)
  assert.equal((sourceGate.match(/477b4f420553e8a52c2fbccc464d7561b239c443/g) ?? []).length, 2)
  assert.doesNotMatch(sourceGate, /ref:\s*\$\{\{\s*matrix\./)
  assert.doesNotMatch(sourceGate, /cache:\s*pnpm/)
  assert.doesNotMatch(sourceGate, /cache-dependency-path:/)
  assert.match(sourceGate, /DSH_CONNECTION_WEBSERVER_EXPECTED: shim-required/)
  assert.match(sourceGate, /scripts\/dsh-web-connection-overlay-contract\.mjs/)
  assert.match(upstreamOverlayWatch, /name: DSH upstream Web compatibility overlay watch/)
  assert.match(upstreamOverlayWatch, /DSH_MODULES_WEBSERVER_EXPECTED: shim-required/)
  assert.match(upstreamOverlayWatch, /DSH_CONNECTION_WEBSERVER_EXPECTED: shim-required/)
  assert.match(upstreamOverlayWatch, /scripts\/dsh-web-modules-overlay-contract\.mjs/)
  assert.match(upstreamOverlayWatch, /scripts\/dsh-web-connection-overlay-contract\.mjs/)
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    assert.equal((sourceGate.match(new RegExp(`os: ${os}`, 'g')) ?? []).length, 4)
  }
})

test('bundle patch defines Vision Router attachment storage admission including rc8 dimensions', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /^\s*- id:\s*attachment-local/m)
  assert.match(patch, /maxImageBytes:\s*20971520/)
  assert.match(patch, /maxImagePixels:\s*100000000/)
  assert.match(patch, /maxImageDimension:\s*10000/)
  assert.doesNotMatch(patch, /maxImageDimension:\s*(?:32768|65535|99999)/)
})

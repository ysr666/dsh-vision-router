import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dshRoot = process.env.DSH_SOURCE_ROOT
if (!dshRoot) throw new Error('DSH_SOURCE_ROOT is required')

const hostPackage = join(dshRoot, 'packages/core/agent-loop/package.json')
const requireHost = createRequire(existsSync(hostPackage) ? hostPackage : join(dshRoot, 'package.json'))
const load = async (name) => import(pathToFileURL(requireHost.resolve(name)).href)
const toolEntry = requireHost.resolve('@deepseek-ai/dsh-tools')
const toolPackage = JSON.parse(readFileSync(resolve(dirname(toolEntry), '../package.json'), 'utf8'))
if (process.env.DSH_EXPECTED_VERSION) {
  assert.equal(toolPackage.version, process.env.DSH_EXPECTED_VERSION, 'Host tools must match pinned DSH')
}

const [{ Context }, { createScope }, { default: SystemPrompt }, { default: Tools }] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/dsh-scope'),
  load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-tools'),
])
const { installSessionVisionModeBoundary } = await import(
  pathToFileURL(resolve(process.env.DVR_SOURCE_ROOT || root, 'lib/session-vision-mode-boundary.js')).href
)

const host = new Context()
await host.plugin(SystemPrompt)
await host.plugin(Tools)
// Official RC3 accepts adapter identity via llm.registration(provider). This
// synthetic adapter registry proves route-derived Session authority independently
// from the separate explicit Session policy test below.
const adapterOwner = Symbol.for('dsh-vision-router.adapter-owner')
host.provide('llm', {
  registration(provider) {
    return { adapter: provider === 'native-mm-vision'
      ? { [adapterOwner]: { route: 'native-mm-vision' } }
      : {} }
  },
})

// This is a synthetic session-policy fixture on the official Host runtime,
// not a reproduction of the reporter's unknown active Desktop Session.
const policies = new Map([
  ['on', true],
  ['off', false],
  ['shadow', false],
])
const store = {
  get(id) {
    const enabled = policies.get(id)
    return enabled === undefined ? undefined : { revision: 1, enabled, source: 'user' }
  },
}
const boundary = installSessionVisionModeBoundary(host, { tool: true }, { sessionVisionPolicyStore: store })
const definition = (name, description = 'fixture') => ({
  name,
  description,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'string' }, render: String },
  async execute() { return 'ok' },
})

boundary.ctx.tools.register(definition('vision_colors', 'dvr'))
boundary.ctx.tools.register(definition('vision_ocr', 'dvr'))
host.tools.register(definition('office_status', 'foreign global'))

const scopes = []
async function makeAgent(id, provider) {
  const agent = {
    id,
    session: {
      id,
      provider,
      requestHeader() {
        return this.provider ? { config: { provider: this.provider, model: 'fixture-model' } } : undefined
      },
    },
  }
  // This is the same scope key/creation contract used by RC3 AgentLoop.
  const scope = createScope(host, agent)
  const fiber = scope.ctx.inject(['tools'], (ctx) => {
    agent.ctx = ctx
    return () => {}
  })
  await fiber
  scopes.push({ scope, fiber, agent })
  host.emit('agent/created', { agent })
  return agent
}

try {
  const on = await makeAgent('on')
  const off = await makeAgent('off')
  const routeOn = await makeAgent('route-on', 'native-mm-vision')
  const routeOff = await makeAgent('route-off', 'native-mm')
  assert.ok(host.tools.get('vision_colors', routeOn), 'owned route => Vision ON')
  assert.equal(host.tools.get('vision_colors', routeOff), undefined, 'ordinary route => Vision OFF')
  routeOn.session.provider = 'native-mm'
  host.emit('agent/status', { agent: routeOn, status: 'running' })
  assert.equal(host.tools.get('vision_colors', routeOn), undefined, 'route ON -> OFF masked')
  routeOff.session.provider = 'native-mm-vision'
  host.emit('agent/status', { agent: routeOff, status: 'running' })
  assert.ok(host.tools.get('vision_colors', routeOff), 'route OFF -> ON restored')
  assert.ok(host.tools.get('vision_colors'), 'DVR globally registered')
  assert.ok(host.tools.get('vision_colors', on), 'Vision ON Agent sees registered tool')
  assert.equal(host.tools.get('vision_colors', off), undefined, 'Vision OFF Agent must not see DVR tool')
  assert.equal(host.tools.resolveExecution('vision_ocr', off, false), undefined, 'Vision OFF cannot dispatch DVR tools')
  assert.ok(host.tools.resolveExecution('vision_ocr', on, false), 'Vision ON can dispatch DVR tools')
  assert.ok(host.tools.get('office_status', off), 'unrelated tool stays available while Vision OFF')

  policies.set('on', false)
  host.emit('agent/status', { agent: on, status: 'running' })
  assert.equal(host.tools.get('vision_colors', on), undefined, 'ON -> OFF revokes scope')
  policies.set('off', true)
  host.emit('agent/status', { agent: off, status: 'running' })
  assert.ok(host.tools.get('vision_colors', off), 'OFF -> ON restores scope')

  const shadow = await makeAgent('shadow')
  const shadowFiber = shadow.ctx.inject(['tools'], ctx => ctx.tools.register(
    definition('vision_colors', 'Agent-local foreign tool'),
  ))
  await shadowFiber
  assert.equal(host.tools.get('vision_colors', shadow)?.description, 'Agent-local foreign tool',
    'Agent-local same-name tool must survive OFF inherited restriction')

  const foreignScope = createScope(host, { role: 'unrelated-preset' })
  const foreignFiber = foreignScope.ctx.inject(['tools'], ctx => ctx.tools.register(
    definition('vision_describe', 'unrelated scope'),
  ))
  await foreignFiber
  assert.equal(host.tools.get('vision_describe'), undefined, 'unrelated scope is not global')
  assert.equal(host.tools.get('vision_describe', off), undefined, 'unrelated scope is not an Agent ancestor')
  await foreignFiber.dispose()
  await foreignScope.dispose()
  await shadowFiber.dispose()

  console.log(JSON.stringify({
    ok: true,
    dsh: toolPackage.version,
    actualHostTools: true,
    visionOnVisible: true,
    visionOffMasked: true,
    onOffTransitions: true,
    routeDerivedOnOffTransitions: true,
    foreignToolPreserved: true,
    foreignShadowPreserved: true,
    foreignPresetIsolated: true,
  }))
} finally {
  for (const { scope, fiber, agent } of scopes.reverse()) {
    host.emit('agent/disposed', { agent })
    await fiber.dispose()
    await scope.dispose()
  }
}

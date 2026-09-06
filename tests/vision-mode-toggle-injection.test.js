import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-boundary.js'
import { CLIENT_HOST_COMPAT_PRELUDE } from '../lib/client-host-compat-prelude.js'

// Execute the shipping preludes/loader/slot callback. The Host stand-in models
// Cordis service tracing: a service's `ctx` is rebound to its caller, not its
// constructor owner. A plain { directoryFor() {} } mock misses this failure.
function createHarness({ legacy = false, delayed = false, warmed = false } = {}) {
  const directories = new Map()
  const reads = []
  const injections = []
  const pending = []
  const warnings = []
  const selections = []
  let registration
  let registeredPlugin
  let owner
  const hostSession = { modelCatalog() {} }
  const services = {
    locale: { register() { return () => {} } },
    settingsScope: { bind() { return undefined } },
    sessions: {
      scope() { return {} },
      binding() { return { session: {} } },
      subagentAddress(id) { return id === 'child' ? { parent: 'parent' } : undefined },
    },
    remote: {},
    ...(!legacy && !delayed ? { 'remote.session': hostSession } : {}),
    slots: {
      inject(name, entries) {
        assert.equal(name, 'conversation.input.right')
        Array.from(entries())
        return () => {}
      },
      register(options) {
        assert.equal(registration, undefined, 'install exactly one toggle')
        registration = options
        return () => {}
      },
    },
  }
  const newDirectory = () => ({ async select(selection) { selections.push(selection) } })
  // Preserve the resolver's cache-before-context-access ordering from alpha.1
  // ModelDirectoryResolver.directoryFor. Transport, projection and React render
  // are deliberately not simulated here; existing #284 tests cover the button.
  const resolver = {
    ctx: null,
    directoryFor(id) {
      const existing = directories.get(id)
      if (existing !== undefined) return existing
      const sessions = this.ctx.sessions
      assert.ok(sessions.scope(id))
      assert.ok(sessions.binding(id))
      if (!legacy) assert.equal(this.ctx.remote.session, hostSession)
      const directory = newDirectory()
      directories.set(id, directory)
      return directory
    },
  }

  function context(declared, label) {
    let ctx
    const target = {
      get(name) { return services[name] }, // Cordis optional lookup, not property access
      effect(run) { return run() },
      inject(dependencies, callback) {
        injections.push({ label, dependencies: Array.from(dependencies) })
        const run = () => {
          if (!dependencies.every((name) => services[name] !== undefined)) return false
          callback(context(new Set([...declared, ...dependencies]), 'toggle scope'))
          return true
        }
        if (!run()) pending.push(run)
      },
    }
    function access(name) {
      reads.push({ name, label, allowed: declared.has(name) })
      if (!declared.has(name)) throw new Error(`cannot get property "${name}" without inject`)
      if (name === 'modelDirectories') {
        return new Proxy(resolver, {
          get(target, property, receiver) {
            if (property === 'ctx') return ctx
            return Reflect.get(target, property, receiver)
          },
        })
      }
      if (name === 'remote') {
        return new Proxy(services.remote, {
          get(target, property) {
            return property === 'session' ? access('remote.session') : target[property]
          },
        })
      }
      return services[name]
    }
    ctx = new Proxy(target, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
        return access(property)
      },
    })
    return ctx
  }

  owner = context(new Set(['sessions', 'remote', 'remote.session', 'modelDirectories']), 'native owner')
  resolver.ctx = owner
  if (!delayed) services.modelDirectories = resolver
  if (warmed) owner.modelDirectories.directoryFor('cold-session')
  reads.length = 0

  const loader = { load(spec) { registeredPlugin = spec } }
  const sandbox = {
    window: { __ModuleLoader__: loader },
    console: { warn(...args) { warnings.push(args) } },
  }
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, sandbox)
  vm.runInNewContext(CLIENT_HOST_COMPAT_PRELUDE, sandbox)
  loader.load({ id: 'dsh-vision-router', factory() { return { apply() {} } } })
  const plugin = registeredPlugin.factory((id) => {
    if (id === 'react' || id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })
  // Match the unchanged root client inject list. In particular remote.session
  // is NOT inherited here; the mode-toggle scope must declare it itself.
  plugin.apply(context(new Set(['settingsScope', 'slots', 'locale', 'sessions', 'remote']), 'plugin root'))
  return {
    directories, reads, injections, warnings, selections,
    get registration() { return registration },
    nativeDirectory(id) { return owner.modelDirectories.directoryFor(id) },
    startModelService() {
      services['remote.session'] = hostSession
      services.modelDirectories = resolver
      for (const run of pending.splice(0)) assert.equal(run(), true)
    },
  }
}

test('cold composer toggle resolves its first directory before the native model seat', async () => {
  const harness = createHarness()
  assert.equal(harness.directories.size, 0, 'native model seat has not initialized a directory')
  assert.ok(harness.registration, 'production prelude registers the toggle')
  const props = harness.registration.inject('cold-session')
  assert.equal(props.available, true)
  assert.equal(harness.directories.size, 1)
  assert.equal(props.directory, harness.nativeDirectory('cold-session'), 'share the native resident directory')
  assert.ok(harness.reads.some((read) => read.name === 'remote.session' && read.label === 'toggle scope' && read.allowed))
  assert.deepEqual(harness.warnings, [])
  assert.equal(await props.select({ provider: 'test-vision', model: 'test' }), true)
  assert.equal(harness.selections.length, 1)
})

test('warm native directory does not hide the cold caller dependency regression', () => {
  const harness = createHarness({ warmed: true })
  const props = harness.registration.inject('cold-session')
  assert.equal(props.directory, harness.nativeDirectory('cold-session'))
  assert.equal(harness.reads.some((read) => read.name === 'remote.session'), false, 'cache hit skips namespace access')
})

test('legacy Host without remote.session still installs and resolves the toggle', async () => {
  const harness = createHarness({ legacy: true })
  assert.ok(harness.registration, 'missing optional namespace must not gate the slot')
  const props = harness.registration.inject('cold-session')
  assert.equal(props.available, true)
  assert.equal(await props.select({ provider: 'legacy-vision', model: 'test' }), true)
  assert.equal(harness.injections.some(({ dependencies }) => dependencies.includes('remote.session')), false)
  assert.deepEqual(harness.warnings, [])
  const childProps = harness.registration.inject('child')
  assert.equal(childProps.available, false)
  assert.equal(await childProps.select({ provider: 'test', model: 'test' }), false)
  assert.equal(harness.selections.length, 1, 'subagent cannot select a model')
})

test('namespace detection waits for the model service rather than sampling plugin startup', () => {
  const harness = createHarness({ delayed: true })
  assert.equal(harness.registration, undefined)
  harness.startModelService()
  assert.ok(harness.registration)
  assert.equal(harness.directories.size, 0)
  const props = harness.registration.inject('cold-session')
  assert.equal(props.available, true)
  assert.ok(harness.reads.some((read) => read.name === 'remote.session' && read.label === 'toggle scope' && read.allowed))
  assert.deepEqual(harness.warnings, [])
})

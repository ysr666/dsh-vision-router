/**
 * ui-model-selection browser half on a real cordis Context with fake command/slots/
 * connection faces and real session scopes: the plugin mounts ModelDirectoryResolver
 * as `models`, the /model contribution and the conversation.input.model
 * seat both register, and BOTH entries resolve the SAME per-session
 * directory through the service — a selection submitted through the seat's
 * inject face is the current the popup's next options pass marks active
 * (and the reverse), the one-shared-state contract of the dual entry.
 * Scope disposal drops the directory (HMR safety).
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelSelection } from '@deepseek-ai/dsh-agent/types'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-agent/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/types'
import type { CommandContribution, PopupSelectSpec, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ModelSelectInjected } from '../src/client/slots.ts'
import { apply, inject, ModelDirectoryResolver } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

const sid = (k: string): SessionId => k as SessionId

const GROUPS = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
      description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    },
  ],
}, {
  id: 'external',
  name: 'External Provider',
  models: [{
    id: 'deepseek-v4-flash',
    name: 'External Flash',
    description: 'Provider-authored description.',
  }],
}]

/** Boot the plugin over fake faces + a stateful fake host (current moves on selectModel). */
async function bench(locale: 'zh' | 'en' = 'zh', decorate?: (plugin: any) => any) {
  const ctx = new Context()
  let defaultSelection: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  let selected = defaultSelection
  const calls = { models: 0, select: 0 }
  const projections = new Map<SessionId, SnapshotStore<ModelSelectionProjection | undefined>>()
  // Whether the Host advertises available models for the current route.
  let routable = true
  let catalogFailure = false
  let groups = GROUPS
  let selectionFailure: RemoteError<'session/writer-held'> | undefined
  const sessionRemote = {
    modelCatalog: () => {
      calls.models += 1
      if (catalogFailure) return Promise.reject(new Error('catalog offline'))
      return Promise.resolve({
        ok: true as const,
        value: {
          default: defaultSelection,
          routableProviders: routable ? ['deepseek-official'] : [],
          groups: routable ? groups : [],
          failures: [],
        },
      })
    },
    selectModel: (payload: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }) => {
      calls.select += 1
      if (selectionFailure !== undefined) return Promise.resolve({ ok: false as const, error: selectionFailure })
      selected = {
        provider: payload.provider,
        model: payload.model,
        ...payload.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: brandString<ReasoningEffortId>(payload.reasoningEffort) },
      }
      projections.get(payload.sessionId)?.set({ lastUsed: null, next: selected })
      return Promise.resolve({ ok: true as const, value: { selected } })
    },
  }
  const remote = Object.assign(new TestRemote(ctx), { session: sessionRemote })
  ctx.reflect.provide('remote.session', sessionRemote)
  const blocks = new Map<SessionId, { reason: string } | undefined>()
  ctx.provide('conversation', {
    blocks: {
      set: (id: SessionId, block: { reason: string } | undefined) => { blocks.set(id, block) },
    },
  })
  let contribution: CommandContribution | undefined
  ctx.provide('commandUi', {
    register(c: CommandContribution) {
      contribution = c
      return () => { contribution = undefined }
    },
  })
  const seats = new Map<string, {
    inject: ((sessionId: SessionId) => ModelSelectInjected) | undefined
    locale: string | undefined
  }>()
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(options: { name: string; locale?: string; inject?: (sessionId: SessionId) => ModelSelectInjected }) {
      seats.set(options.name, { inject: options.inject, locale: options.locale })
      return () => { seats.delete(options.name) }
    },
  })
  const localeRuntime = new LocaleRuntime(ctx)
  // There is no jsdom `window` in this lane, so browser-language detection
  // never runs. Each bench states the locale its assertions require.
  localeRuntime.setLocale(locale)
  ctx.provide('locale', localeRuntime)
  const scopes = new Map<SessionId, Context>()
  const bindings = new Map<SessionId, {
    sessionId: SessionId
    session: {
      sessionId: SessionId
      getSnapshot: () => { blank: boolean }
      projections: { faceOf: () => SnapshotStore<ModelSelectionProjection | undefined> }
    }
    ctx: Context
  }>()
  const addressed = new Set<SessionId>()
  ctx.provide('sessions', {
    scope: (id: SessionId) => scopes.get(id),
    binding: (id: SessionId) => bindings.get(id),
    subagentAddress: (id: SessionId) => addressed.has(id)
      ? { parentSessionId: sid('parent'), childSessionId: id, mode: 'continuable' as const }
      : undefined,
  })
  const track = vi.fn()
  ctx.provide('productAnalytics', { enabled: true, track } as never)
  ctx.provide('settingsScope', { bind: () => ({ getSnapshot: () => ({ value: { autoWrapProviders: false, wrappedProviders: [{provider:'dvr-real-source',models:['m1','m2']}] } }), subscribe: () => () => {} }) } as never)
  const fiber = ctx.plugin(decorate ? decorate({ inject: [...inject], apply, ModelDirectoryResolver }) : { inject: [...inject], apply })
  await fiber.await()
  await ctx.plugin(function probe() {}).await()
  const mint = (key: string, blank = false) => {
    const id = sid(key)
    const handle = createScope(ctx, id)
    scopes.set(id, handle.ctx)
    const projection = createSnapshotStore<ModelSelectionProjection | undefined>({
      lastUsed: null,
      next: null,
    })
    projections.set(id, projection)
    const binding = {
      sessionId: id,
      session: { sessionId: id, getSnapshot: () => ({ blank }), projections: { faceOf: () => projection } },
      ctx: handle.ctx,
    }
    bindings.set(id, binding)
    handle.ctx.effect(() => () => {
      if (bindings.get(id) === binding) bindings.delete(id)
    })
    return { ...handle, projection }
  }
  return {
    ctx, fiber, mint, calls, remote, track,
    contribution: () => contribution!,
    popup: (): PopupSelectSpec => {
      const ui = contribution!.ui
      if (ui.kind !== 'popupSelect') throw new Error('expected the popupSelect kind')
      return ui
    },
    seat: () => seats.get('conversation.input.model')!,
    hostCurrent: () => selected,
    rejectSelection: () => {
      selectionFailure = new RemoteError('session/writer-held', 'writer held', { sessionId: sid('owned') })
    },
    setHostCurrent: (selection: ModelSelection) => { defaultSelection = selection },
    setProjected: (id: SessionId, value: ModelSelectionProjection) => { projections.get(id)?.set(value) },
    address: (id: SessionId) => { addressed.add(id) },
    setGroups: (next: typeof GROUPS) => { groups = next },
    setCatalogFailure: (next: boolean) => { catalogFailure = next },
    setRoutable: (next: boolean) => { routable = next },
    blockOf: (key: string) => blocks.get(sid(key)),
  }
}

const projection = (id: string) => ({ sessionId: sid(id) })


describe('DVR-only narrow shared resolver over original Host directory', () => {
  it('stock picker and actual independent Claude catalog agree while raw route authority and original registry remain intact', async () => {
    const mod = await import(pathToFileURL(process.env.DVR_864_PRELUDE!).href)
    const evidence = JSON.parse(readFileSync(process.env.DVR_864_CATALOG!, 'utf8'))
    let spec: any
    const loader = { load(input: any) { spec = input; return input } }
    const hardening = await import(pathToFileURL(process.env.DVR_864_HARDENING!).href)
    let ownership = { revision: 1, routes: new Map([[evidence.twin, evidence.source]]) }
    const listeners = new Set<() => void>()
    const authority = {
      sourceFor: (route:string) => ownership.routes.get(route),
      getSnapshot: () => ownership,
      subscribe: (fn:()=>void) => { listeners.add(fn); return () => listeners.delete(fn) },
      recoveryFor: () => undefined,
    }
    const window = { __ModuleLoader__: loader, __dshVisionRouterRootHardening: authority }
    runInNewContext(hardening.hardenVisionClientSource(mod.VISION_MODEL_VISIBILITY_PRELUDE), { window, Object, Reflect, Proxy, Promise, Array, String, Map, Set, WeakMap, JSON })
    const decorate = (id: string, plugin: any) => {
      loader.load({id, factory: () => plugin})
      return spec.factory(() => ({}))
    }
    const b = await bench('zh', plugin => decorate('@deepseek-ai/dsh-client-ui-model-selection', plugin))
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url:'http://localhost/', pretendToBeVisual:true })
    try {
      for (const key of ['window','document','navigator','MutationObserver','HTMLElement','Element','Node','DOMParser','localStorage','requestAnimationFrame','cancelAnimationFrame']) {
        const value = key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]
        vi.stubGlobal(key, typeof value === 'function' && (key === 'requestAnimationFrame' || key === 'cancelAnimationFrame') ? value.bind(dom.window) : value)
      }
      const { createModelCatalog } = await import('./dvr-claude-catalog.mjs')
      const { groups, source, twin, foreign } = evidence
      b.setGroups(groups)
      b.setHostCurrent({provider: source, model:'m1'})
      b.remote.emit('llm/adapters-updated', [])
      b.mint('alias')
      const id = sid('alias')
      b.ctx.provide('uiSession', { current: { value: { key:id } } } as never)
      const shared = b.ctx.modelDirectories as any
      const raw = shared.rawDirectoryFor(id)
      const projected = shared.directoryFor(id)
      await raw.load()
      await raw.select({provider:twin,model:'m1',reasoningEffort:'high'})
      const official = b.seat().inject!(id)
      let claude: any
      let independent: any
      const consumer = { inject: ['uiSession','modelDirectories'], apply(ctx: any) {
        claude = createModelCatalog({ctx})
        independent = ctx.get('modelDirectories').directoryFor(id)
      }}
      expect(decorate('arbitrary-independent-consumer', consumer)).toBe(consumer)
      const cf = b.ctx.plugin(consumer)
      await cf.await()
      expect(cf.state).not.toBeUndefined()
      expect(claude.providers().map((p:any)=>p.id)).toEqual([source,foreign])
      expect(official.directory.getSnapshot().groups.map((g:any)=>g.id)).toEqual([source,foreign])
      expect(raw.store.getSnapshot().groups.map((g:any)=>g.id)).toContain(twin)
      expect(raw.store.getSnapshot().current?.provider).toBe(twin)
      expect(claude.snapshot().current.provider).toBe(source)
      expect(claude.current(claude.snapshot()).group.id).toBe(source)
      expect(claude.effort(claude.snapshot()).effective).toBe('high')
      expect(independent.store.getSnapshot().current.provider).toBe(source)
      expect(independent).toBe(projected)
      expect(official.directory).toBe(projected.store)
      expect(projected.store.getSnapshot()).toBe(projected.store.getSnapshot())
      const notify = vi.fn()
      const stop = projected.store.subscribe(notify)
      ownership = { revision: 2, routes: new Map() }
      listeners.forEach(fn=>fn())
      expect(notify).toHaveBeenCalled()
      expect(projected.store.getSnapshot().groups.map((g:any)=>g.id)).toContain(twin)
      expect(projected.store.getSnapshot().current.provider).toBe(twin)
      ownership = { revision: 3, routes: new Map([[twin, source]]) }
      listeners.forEach(fn=>fn())
      expect(projected.store.getSnapshot().groups.map((g:any)=>g.id)).not.toContain(twin)
      stop()
      await independent.select({provider:source,model:'m2',reasoningEffort:'max'})
      expect(b.hostCurrent()).toEqual({provider:twin,model:'m2',reasoningEffort:'max'})
      await independent.select({provider:foreign,model:'m1'})
      expect(b.hostCurrent().provider).toBe(foreign)
      // DVR's own toggle factory never receives the projection.
      const own = { apply() {} }
      expect(decorate('dsh-vision-router',own)).toBe(own)
      claude.reset()
      await cf.dispose()
    } finally {
      await b.ctx.fiber.dispose()
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })
})

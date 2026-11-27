// Diagnostic-only upstream prototype. Apply to a disposable checkout at 4b399c39a6d1479cd84ca591b4d7c88e24d38a96.
// No upstream ref is modified, no package is published.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(process.argv[2])
const patches = [
  [
    "packages/llm/llm/src/types.ts",
    "export interface LlmProviderInfo {\n",
    "export interface LlmProviderInfo {\n  /** Explicit adapter-owned presentation alias; real route identity is unchanged. */\n  presentationAliasOf?: string\n"
  ],
  [
    "packages/llm/llm/src/index.ts",
    "provider: { id: info.id, name: info.name },",
    "provider: { id: info.id, name: info.name,\n          ...(typeof info.presentationAliasOf === 'string' && info.presentationAliasOf.length > 0 && info.presentationAliasOf !== info.id ? { presentationAliasOf: info.presentationAliasOf } : {}),\n        },"
  ],
  [
    "packages/api/session-controller/src/types.ts",
    "export interface ModelProviderGroup {\n",
    "export interface ModelProviderGroup {\n  readonly presentationAliasOf?: string\n"
  ],
  [
    "packages/api/session-controller/src/catalog.ts",
    "group: { id: provider.id, name: provider.name, models: entries },",
    "group: { id: provider.id, name: provider.name, models: entries,\n          ...(provider.presentationAliasOf === undefined ? {} : { presentationAliasOf: provider.presentationAliasOf }),\n        },"
  ],
  [
    "packages/client/ui-model-selection/src/client/directory.ts",
    "/** One session's shared directory controller; disposed with the session scope. */",
    "/** Only explicitly declared direct aliases with equivalent model/effort metadata\n * can disappear from presentation. The real catalog and admission stay intact. */\nfunction presentationAliases(state: ModelDirectoryState): Map<string, string> {\n  const aliases = new Map<string, string>()\n  for (const alias of state.groups) {\n    const source = state.groups.find(g => g.id === alias.presentationAliasOf)\n    if (!source || source.id === alias.id || source.presentationAliasOf !== undefined || alias.models.length === 0) continue\n    const equivalent = (model: ModelProviderGroup['models'][number]) => {\n      const match = source.models.find(m => m.id === model.id)\n      if (!match) return false\n      const effortKey = (m: typeof model) => JSON.stringify([m.reasoning?.defaultEffort ?? null, (m.reasoning?.efforts ?? []).map(e => e.id).sort()])\n      return effortKey(model) === effortKey(match)\n    }\n    if (!alias.models.every(equivalent)) continue\n    if ([state.current, state.pending].some(s => s?.provider === alias.id && !alias.models.some(m => m.id === s.model))) continue\n    aliases.set(alias.id, source.id)\n  }\n  return aliases\n}\n\nfunction presentationState(state: ModelDirectoryState): ModelDirectoryState {\n  const aliases = presentationAliases(state)\n  if (aliases.size === 0) return state\n  const visible = (s: ModelSelection | null): ModelSelection | null => s && aliases.has(s.provider) ? { ...s, provider: aliases.get(s.provider)! } : s\n  return { ...state, groups: state.groups.filter(g => !aliases.has(g.id)), current: visible(state.current), pending: visible(state.pending) }\n}\n\nfunction rawSelection(state: ModelDirectoryState, selection: ModelSelection): ModelSelection {\n  const current = state.current\n  if (!current || presentationAliases(state).get(current.provider) !== selection.provider) return selection\n  const group = state.groups.find(g => g.id === current.provider)\n  if (!group?.models.some(m => m.id === selection.model)) return selection\n  return { ...selection, provider: current.provider }\n}\n\n/** One session's shared directory controller; disposed with the session scope. */"
  ],
  [
    "packages/client/ui-model-selection/src/client/directory.ts",
    "  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({",
    "  private readonly rawStore: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({"
  ],
  [
    "packages/client/ui-model-selection/src/client/directory.ts",
    "  /** Latest selection operation wins; an older response never overwrites a newer one. */",
    "  /** Shared selector view, derived synchronously from the same raw directory. */\n  readonly store = createSnapshotStore<ModelDirectoryState>(this.rawStore.getSnapshot())\n  readonly rawView = {\n    store: this.rawStore,\n    load: () => this.loadRaw(),\n    select: (selection: ModelSelection) => this.selectRaw(selection),\n  }\n  private readonly unsubscribeRaw = this.rawStore.subscribe(() => this.store.set(presentationState(this.rawStore.getSnapshot())))\n\n  /** Latest selection operation wins; an older response never overwrites a newer one. */"
  ],
  [
    "packages/client/ui-model-selection/src/client/directory.ts",
    "  async load(): Promise<ModelDirectoryState> {\n",
    "  async load(): Promise<ModelDirectoryState> {\n    await this.loadRaw()\n    return this.store.getSnapshot()\n  }\n\n  private async loadRaw(): Promise<ModelDirectoryState> {\n"
  ],
  [
    "packages/client/ui-model-selection/src/client/directory.ts",
    "  async select(selection: ModelSelection): Promise<RemoteResult<void>> {\n",
    "  async select(selection: ModelSelection): Promise<RemoteResult<void>> {\n    return this.selectRaw(rawSelection(this.rawStore.getSnapshot(), selection))\n  }\n\n  private async selectRaw(selection: ModelSelection): Promise<RemoteResult<void>> {\n"
  ],
  [
    "packages/client/ui-model-selection/src/client/directory.ts",
    "    this.unsubscribeSelection()\n    this.unsubscribeCatalog()",
    "    this.unsubscribeSelection()\n    this.unsubscribeCatalog()\n    this.unsubscribeRaw()"
  ],
  [
    "packages/client/ui-model-selection/src/client/service.ts",
    "  directoryFor(sessionId: SessionId): ModelDirectory {",
    "  /** Exact route authority for routing controls, not ordinary selectors. */\n  rawDirectoryFor(sessionId: SessionId): ModelDirectory['rawView'] {\n    return this.directoryFor(sessionId).rawView\n  }\n\n  directoryFor(sessionId: SessionId): ModelDirectory {"
  ]
]
// Convert the original controller's internal accesses before inserting the two-view facade.
const directory = "packages/client/ui-model-selection/src/client/directory.ts"
const rawPath = join(root, directory)
const raw = readFileSync(rawPath, 'utf8').replace(/\r\n/g, '\n')
assert.ok(raw.includes('this.store.getSnapshot()'))
writeFileSync(rawPath, raw.replaceAll('this.store.', 'this.rawStore.'))
for (const [path, original, replacement] of patches) {
  const file = join(root, path)
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(text.split(original).length, 2, 'unexpected immutable host anchor: ' + path + ' ' + original.slice(0,80))
  writeFileSync(file, text.replace(original, () => replacement))
}
const suite = join(root, "packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts")
writeFileSync(suite, readFileSync(suite, 'utf8') + "\n\ndescribe('explicit route presentation aliases (DVR #864 prototype)', () => {\n  it('stock and independent consumers share the presentation, while raw controls retain route identity', async () => {\n    const b = await bench()\n    try {\n      const source = GROUPS[0]!\n      const alias = { ...source, id: 'arbitrary-wrapper', name: 'Internal route', presentationAliasOf: source.id }\n      const foreign = { ...source, id: 'foreign-vision', name: 'Foreign vision' }\n      b.setGroups([source, alias, foreign, GROUPS[1]!])\n      b.remote.emit('llm/adapters-updated', [])\n      b.mint('alias')\n      const id = sid('alias')\n      const raw = b.ctx.modelDirectories.rawDirectoryFor(id)\n      const shared = b.ctx.get('modelDirectories')!.directoryFor(id)\n      const official = b.seat().inject!(id)\n      await shared.load()\n      expect(shared.store).toBe(official.directory)\n      expect(b.ctx.modelDirectories.rawDirectoryFor(id)).toBe(raw)\n      expect(shared.store.getSnapshot().groups.map(g => g.id)).toEqual([source.id, foreign.id, 'external'])\n      expect(raw.store.getSnapshot().groups.map(g => g.id)).toContain(alias.id)\n      await raw.select({ provider: alias.id, model: source.models[0]!.id, reasoningEffort: 'high' })\n      expect(raw.store.getSnapshot().current?.provider).toBe(alias.id)\n      expect(shared.store.getSnapshot().current?.provider).toBe(source.id)\n      expect((await b.popup().options(projection('alias'), new AbortController().signal)).map(o => o.group?.name)).not.toContain(alias.id)\n      const pending = shared.select({ provider: source.id, model: source.models[1]!.id, reasoningEffort: 'max' })\n      expect(shared.store.getSnapshot().pending?.provider).toBe(source.id)\n      expect(raw.store.getSnapshot().pending?.provider).toBe(alias.id)\n      await pending\n      expect(b.hostCurrent()).toEqual({ provider: alias.id, model: source.models[1]!.id, reasoningEffort: 'max' })\n      await shared.select({ provider: foreign.id, model: source.models[0]!.id })\n      expect(b.hostCurrent().provider).toBe(foreign.id)\n      b.mint('other')\n      expect(b.ctx.modelDirectories.directoryFor(sid('other')).store).not.toBe(shared.store)\n      b.setGroups([source, foreign, GROUPS[1]!])\n      b.remote.emit('llm/adapters-updated', [])\n      await vi.waitFor(() => expect(raw.store.getSnapshot().groups.some(g => g.id === alias.id)).toBe(false))\n    } finally { await b.ctx.fiber.dispose() }\n  })\n\n  it('fails open for unmirrored, chained or different-effort alias declarations', async () => {\n    const b = await bench()\n    try {\n      const source = GROUPS[0]!\n      const bad = { ...source, id: 'unmirrored', presentationAliasOf: source.id,\n        models: [{ ...source.models[0]!, id: 'exclusive' }] }\n      const different = { ...source, id: 'different-effort', presentationAliasOf: source.id,\n        models: [{ ...source.models[0]!, reasoning: { efforts: [{ id: 'other', name: 'Other' }], defaultEffort: 'other' } }] }\n      const chained = { ...source, id: 'chained', presentationAliasOf: bad.id }\n      b.setGroups([source, bad, different, chained])\n      b.remote.emit('llm/adapters-updated', [])\n      b.mint('fail-open')\n      const shared = b.ctx.modelDirectories.directoryFor(sid('fail-open'))\n      await shared.load()\n      expect(shared.store.getSnapshot().groups.map(g => g.id)).toEqual([source.id, bad.id, different.id, chained.id])\n    } finally { await b.ctx.fiber.dispose() }\n  })\n})\n")
console.log('Issue 864 disposable shared-directory prototype applied')

// Actual DVR public apply -> patched exact Host registry/catalog. Offline fixture only.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
const root = resolve(process.env.DSH_SOURCE_ROOT)
const host = p => import(pathToFileURL(join(root,p)).href)
const req = createRequire(join(root,'packages/llm/llm/package.json'))
const [{ Context }, llm, {default: Sessions}, {default: Projection}, {default: AttachmentLocal},
  {default: SystemPrompt}, {default: Tools}, {default: AgentRegistry}, {default: AgentLoop}, plugin,
  {buildModelCatalog,modelAvailable}] = await Promise.all([
  import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href),
  host('packages/llm/llm/src/index.ts'),host('packages/core/session/src/index.ts'),
  host('packages/session/session-projection/src/index.ts'),host('packages/attachment/attachment-local/src/index.ts'),
  host('packages/core/system-prompt/src/index.ts'),host('packages/core/tools/src/index.ts'),
  host('packages/core/agent/src/index.ts'),host('packages/core/agent-loop/src/index.ts'),
  import('../lib/public-entry.js'),host('packages/api/session-controller/src/catalog.ts')
])
const home = mkdtempSync(join(tmpdir(),'dvr-864-'))
const ctx = new Context()
try {
  await ctx.plugin(llm.default)
  await ctx.plugin(Sessions)
  await ctx.plugin(Projection)
  await ctx.plugin(AttachmentLocal,{dshHome: home})
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop,{agents: []})
  class Source extends llm.LlmAdapter {
    providerInfo(id) { return {id,name:id} }
    async listModels(provider) { return Promise.all(['m1','m2','plain'].map(id=>this.resolveModel(provider,id))) }
    async resolveModel(provider,id) { return {provider,id,name:id,inputModalities:['text'],
      reasoning:{efforts:[{id:'high',name:'High'},{id:'max',name:'Max'}],defaultEffort:'high'}} }
    async *stream() { throw Error('Catalog test must not call LLM') }
  }
  const source = 'dvr-real-source'
  const twin = source + '-vision'
  const foreign = 'foreign-vision'
  ctx.llm.registerAdapter([source,foreign],new Source())
  await ctx.plugin({inject:plugin.inject,apply(scope) {
    return plugin.apply(scope,plugin.Config({routing:false,tool:true,progressiveTools:false,
      autoWrapProviders:false,wrappedProviders:[{provider:source,models:['m1','m2']}],
      providers:[],freeFallback:false,downscale:false,cache:false}))
  }})
  const deadline = Date.now()+10000
  while (!ctx.llm.listProviders().some(p=>p.id===twin) && Date.now()<deadline) await new Promise(r=>setTimeout(r,25))
  const catalog = await buildModelCatalog(ctx,{provider:source,model:'m1'})
  const groups = catalog.groups.filter(g=>[source,twin,foreign].includes(g.id))
  assert.equal(groups.length,3,JSON.stringify(catalog))
  assert.equal(groups.find(g=>g.id===twin).presentationAliasOf,source)
  assert.deepEqual(groups.find(g=>g.id===twin).models.map(m=>m.id).sort(),['m1','m2'])
  assert.equal(groups.find(g=>g.id===foreign).presentationAliasOf,undefined)
  assert.ok(catalog.routableProviders.includes(twin))
  assert.equal(await modelAvailable(ctx,{provider:twin,model:'m1'}),true)
  assert.equal(await modelAvailable(ctx,{provider:twin,model:'plain'}),false)
  writeFileSync(process.env.DVR_864_CATALOG,JSON.stringify({groups,source,twin,foreign}))
  console.log(JSON.stringify({actualDvrApply:true,actualHostCatalog:true,source,twin,foreign,groups}))
} finally { await ctx.fiber.dispose(); rmSync(home,{recursive:true,force:true}) }

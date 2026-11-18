// A composition probe: real RC5 WebRuntime, native tool registry/executor and
// tool-web; real DVR pre-step coordinator with a synthetic Agent/Session boundary.
// The full Agent/Desktop/Chromium acceptance remains in the unchanged Host gate.
// No network, credentials, provider reimplementation or live profile.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installPreStepModelRouting } from '../lib/agent-prestep-model-routing.js'

const root = resolve(process.env.DSH_SOURCE_ROOT || '')
const expected = process.env.DSH_EXPECTED_COMMIT
assert.equal(expected, '9c2670d3bce5275e0d1610272958121af87787bb')
assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), expected)
assert.equal(process.env.DSH_WEB_SEARCH_PROVIDER, undefined, 'default selection fixture must not have an env override')
const hostImport = file => import(pathToFileURL(join(root,file)).href)
const [
  { Context }, { default: SystemPrompt }, { default: ToolRuntime }, NativeToolExecutor,
  { default: WebRuntime }, ToolWeb, { createScope }, { SessionId }, { ToolCallId },
  { executeToolFixture },
] = await Promise.all([
  hostImport('vendor/cordis/src/index.ts'),
  hostImport('packages/core/system-prompt/src/index.ts'),
  hostImport('packages/core/tools/src/index.ts'),
  hostImport('packages/core/tool-executor-native/src/index.ts'),
  hostImport('packages/web/web/src/index.ts'),
  hostImport('packages/web/tool-web/src/index.ts'),
  hostImport('packages/core/scope/src/index.ts'),
  hostImport('packages/core/session/src/index.ts'),
  hostImport('packages/llm/llm/src/index.ts'),
  hostImport('packages/test-support/tool-testkit/src/index.ts'),
])

let caseId = 0
async function exercise({ initial, routing, configured, steps, denyRoute }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(WebRuntime, configured ? {searchProvider:configured} : {})
  const ready = [], calls = [], warnings = []
  for (const id of ['deepseek-search-api','deepseek-official']) {
    ctx.web.registerSearchProvider({
      id, available: () => true,
      ready: async route => { ready.push([id,route]); return route !== denyRoute },
      search: async request => {
        calls.push([id, request.llmProvider])
        return {content:id,sources:[],truncated:false}
      },
    })
  }
  const fiber = await ctx.plugin(ToolWeb, {})
  const handlers = new Map()
  const inbox = {'next-turn':[], 'next-step':[]}
  let selection = {...initial}, request
  let activated = 0
  const emit = (event,...args) => {
    for (const cb of handlers.get(event) ?? []) cb(...args)
  }
  const session = {requestContext: () => request}
  const id = ++caseId
  const agent = {
    id:SessionId('dvr-rc5-search-'+id), session, status:'idle',
    model:{
      current:()=>({...selection}),
      select(next) { selection={...next}; emit('session/event',session,{type:'model/selection',data:next}) },
    },
  }
  const boundary = {
    get(name){ return name === 'sessionProjections' ? {stateOf:()=>inbox} : undefined },
    on(name,cb){ const list=handlers.get(name)??[]; list.push(cb); handlers.set(name,list) },
    logger:{warn(...args){warnings.push(args)},debug(){}},
  }
  installPreStepModelRouting(boundary,{
    routingEnabled:()=>routing, reverseRoutingEnabled:()=>true,
    routingPairs:()=>[{provider:'vision-http',model:'visual-model'}],
    chainRoute:()=> 'vision-chain', wrapperRoute:()=> 'deepseek-vision',
    wrapperRegistered:()=>true, textProvider:()=>initial,
    hasAdapter:()=>true, hasImage:blocks=>blocks.some(block=>block.type==='image'),
    toolEnabled:()=>true, autoActivateOnImageEnabled:()=>true,
    structuredBootstrapEnabled:()=>false, activateDeepTools:()=>{activated++},
  })
  await ctx.plugin(Object.assign(inner=>{createScope(inner,agent)},{inject:['tools']}))
  try {
    for (let n=0;n<steps.length;n++) {
      const step=steps[n]
      const msg={id:'message-'+n,role:'user',source:{kind:'user'},content:step.image
        ? [{type:'image',attachment:{attachmentId:'fixture'}}] : [{type:'text',text:'search'}]}
      agent.status='idle'
      inbox['next-turn'].push(msg)
      emit('agent/inbox/inserted',{agent,message:msg})
      agent.status='running'
      emit('agent/status',{agent,status:'running'})
      inbox['next-turn'].length=0
      emit('session/event',session,{type:'turn/start'})
      const effective=agent.model.current()
      assert.equal(effective.provider,step.route,'DVR selected the wrong actual step route')
      ready.length=0
      const signal=new AbortController().signal
      const toolSet=await ctx.tools.resolve({agent,modelSelection:effective,signal})
      try {
        assert.ok(ready.length>0,'no selected search provider readiness check')
        assert.ok(ready.every(([provider,route])=>provider===step.search && route===step.route),'readiness must use the effective step route and selected provider')
        const assembly=await ctx.systemPrompt.assemble({scope:agent,agent,modelSelection:effective,toolSet})
        assert.equal(assembly.tools.some(tool=>tool.name==='web_search'),!step.denied)
        const before=calls.length
        // Stand-in for the Host's requestContext publication after the actual model request.
        request=effective
        if (!step.denied) {
          const result=await executeToolFixture(ctx,{agent,toolSet,signal,callId:ToolCallId('call-'+id+'-'+n),name:'web_search',arguments:{queries:['fixture']}})
          assert.equal(result.isError,false,JSON.stringify(result.error))
          assert.deepEqual(calls.slice(before),[[step.search,step.route]])
        } else {
          const result=await executeToolFixture(ctx,{agent,toolSet,signal,callId:ToolCallId('denied-'+id+'-'+n),name:'web_search',arguments:{queries:['fixture']}})
          assert.equal(result.isError,true,'a withheld search must not be callable')
          assert.equal(calls.length,before,'a withheld search must not dispatch')
        }
      } finally {toolSet.dispose()}
      emit('agent/turn-stopping',{agent})
    }
    assert.equal(warnings.length,0)
    if(steps.some(step=>step.image)) assert.ok(activated>0,'image tool activation lost')
  } finally {await fiber.dispose()}
}
const official={provider:'deepseek-official',model:'deepseek-v4-pro'}
await exercise({initial:official,routing:false,steps:[{image:true,route:'deepseek-official',search:'deepseek-official'}]})
await exercise({initial:official,routing:true,steps:[
  {image:false,route:'deepseek-official',search:'deepseek-official'},
  {image:true,route:'vision-chain',search:'deepseek-search-api'},
  {image:false,route:'deepseek-official',search:'deepseek-official'},
]})
await exercise({initial:{provider:'deepseek-account',model:'deepseek-v4-pro'},routing:false,steps:[{image:true,route:'deepseek-account',search:'deepseek-official'}]})
await exercise({initial:official,routing:true,configured:'deepseek-official',steps:[{image:true,route:'vision-chain',search:'deepseek-official'}]})
await exercise({initial:official,routing:true,denyRoute:'vision-chain',steps:[{image:true,route:'vision-chain',search:'deepseek-search-api',denied:true}]})
console.log('DVR_RC5_SEARCH_ROUTING_CONTRACT_OK')

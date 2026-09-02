import { SETTINGS_IA_CLIENT_PRELUDE } from './settings-ia-client-prelude.js'

const CARD_MARK = 'data-vision-router-settings-native-cards'

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`settings native-card transform anchor missing: ${label}`)
  }
  return source.replace(from, to)
}

/**
 * Keep Settings 2.0's data/validation implementation intact while replacing
 * only its presentation shell with DSH's disclosure-card interaction model.
 *
 * The transform is deliberately exact-anchor based: if the IA implementation
 * changes, tests fail instead of silently shipping a half-applied UI patch.
 */
export function transformSettingsIaToNativeCards(source = SETTINGS_IA_CLIENT_PRELUDE) {
  let next = String(source)

  next = replaceRequired(
    next,
    "      var pagePair=React.useState('general'),page=pagePair[0],setPage=pagePair[1];",
    `      var cardsPair=React.useState({}),cardsOpen=cardsPair[0],setCardsOpen=cardsPair[1];
      var dataCardsOpen=!!(cardsOpen.general||cardsOpen.advanced||cardsOpen.diagnostics);
      React.useEffect(function(){
        try{
          if(typeof helpers.readVisionGuideStep==='function'&&helpers.readVisionGuideStep()==='step2'){
            setCardsOpen(function(previous){return previous&&previous.general===true?previous:Object.assign({},previous,{general:true});});
          }
        }catch(_){}
      },[]);`,
    'card-local disclosure state',
  )

  next = replaceRequired(
    next,
    "      React.useEffect(function(){var disposed=false,stops=[];function refresh(){if(!disposed)invalidateCatalog();}void loadCatalog();void loadCapabilities(false);try{if(typeof helpers.subscribeCatalogInvalidations==='function')stops.push(helpers.subscribeCatalogInvalidations(props&&props.remote,refresh));else if(props&&props.remote&&typeof props.remote.$on==='function'){stops.push(props.remote.$on('llm/adapters-updated',refresh));stops.push(props.remote.$on('settings/document-updated',refresh));stops.push(props.remote.$on('credentials/updated',refresh));}}catch(_){}try{if(props&&typeof props.subscribeConnectionReset==='function')stops.push(props.subscribeConnectionReset(refresh));}catch(_){}return function(){disposed=true;catalogGen.current+=1;capsGen.current+=1;stops.forEach(function(stop){try{if(typeof stop==='function')stop();}catch(_){}});};},[props&&props.getConnection,props&&props.remote,props&&props.subscribeConnectionReset]);",
    `      React.useEffect(function(){
        if(!dataCardsOpen)return function(){};
        var disposed=false,stops=[];
        function refresh(){if(!disposed)invalidateCatalog();}
        void loadCatalog();
        void loadCapabilities(false);
        try{
          if(typeof helpers.subscribeCatalogInvalidations==='function')stops.push(helpers.subscribeCatalogInvalidations(props&&props.remote,refresh));
          else if(props&&props.remote&&typeof props.remote.$on==='function'){
            stops.push(props.remote.$on('llm/adapters-updated',refresh));
            stops.push(props.remote.$on('settings/document-updated',refresh));
            stops.push(props.remote.$on('credentials/updated',refresh));
          }
        }catch(_){}
        try{if(props&&typeof props.subscribeConnectionReset==='function')stops.push(props.subscribeConnectionReset(refresh));}catch(_){}
        return function(){
          disposed=true;
          catalogGen.current+=1;
          capsGen.current+=1;
          stops.forEach(function(stop){try{if(typeof stop==='function')stop();}catch(_){}});
        };
      },[dataCardsOpen,props&&props.getConnection,props&&props.remote,props&&props.subscribeConnectionReset]);`,
    'lazy catalog lifecycle',
  )

  // The guide's final step is a completion callout inside the General card's
  // chain editor. The page-based prelude never rendered one, so the native
  // card composition must carry it: without it the walkthrough ends by
  // silently dropping its floating prompt, the guide state stays stuck at
  // step 2 (re-opening General on every Settings mount), and a first-run
  // install never records onboarding-seen through the guide.
  next = replaceRequired(
    next,
    "card([h('div',{className:'vr-field',id:'vr-vision-backend-chain','data-vr-guide-target':'vision-backend',key:'chain'},",
    `card([(typeof helpers.readVisionGuideStep==='function'&&helpers.readVisionGuideStep()==='step2')?h('div',{className:'vr-guide-callout',key:'guide-callout'},h('div',{className:'vr-guide-callout-title'},tx('最后 · 确认识图模型','Final · Confirm the vision model')),h('p',{className:'vr-guide-callout-body'},tx('这里的识图模型会从上到下依次尝试。备用模型完全可选；全部失败时仍可使用内置免费兜底。确认后保存即可。','Vision models are tried from top to bottom. Fallback models are optional, and the built-in free fallback remains available at the end. Save when ready.')),h('button',{type:'button',className:'vr-btn vr-btn-save',onClick:function(){try{if(typeof helpers.finishVisionSettingsGuide==='function')helpers.finishVisionSettingsGuide({complete:true});}catch(_){}setSaveState(function(previous){return Object.assign({},previous);});}},tx('完成','Done'))):null,h('div',{className:'vr-field',id:'vr-vision-backend-chain','data-vr-guide-target':'vision-backend',key:'chain'},`,
    'guide completion callout',
  )

  next = replaceRequired(
    next,
    "      var valid=validChain(chainRows())&&validWrapperRows(wrapperRows())&&validGuidance(guidanceRows())&&invalidKeys.length===0;",
    `      var valid=validChain(chainRows())&&validWrapperRows(wrapperRows())&&validGuidance(guidanceRows())&&invalidKeys.length===0;
      var pageKeys={
        general:new Set(['providers','freeFallback']),
        strategy:new Set(['tool','structuredVisionBootstrap','visionDepth','visionDepthMaxCalls','guidanceOverrides']),
        local:new Set(['localOllama','localLmStudio','desktopScreenshot']),
        advanced:new Set(['wrappedProviders','downscale','downscaleMaxPixels','cache','cacheTtlSeconds','cacheMaxEntries','timeoutMs','visionTaskTimeoutMs','ocrTimeoutMs','visionTurnBudgetMs','freeCloudFirst','autoWrapProviders','allowRemoteSettings','proxy','proxyHosts','rewriteImages','routing','reverseRouting','textProvider','progressiveTools','stealth','wrapperRoute','chainRoute','extraVisionModels']),
        diagnostics:new Set([])
      };
      var invalidChainDraft=chainDraft!==undefined&&!validChain(chainRows());
      var invalidGuidanceDraft=guidanceDraft!==undefined&&!validGuidance(guidanceRows());
      var invalidWrapperDraft=wrapperDraft!==undefined&&!validWrapperRows(wrapperRows());
      var cardDirty=dirty||invalidChainDraft||invalidGuidanceDraft||invalidWrapperDraft;
      function pageOwns(id,key){var keys=pageKeys[id];return !!keys&&keys.has(key);}
      function pagePlan(id){return plan.filter(function(item){return pageOwns(id,item.key);});}
      function pageDirty(id){
        if(id==='general'&&invalidChainDraft)return true;
        if(id==='strategy'&&invalidGuidanceDraft)return true;
        if(id==='advanced'&&invalidWrapperDraft)return true;
        return pagePlan(id).length>0||invalidKeys.some(function(key){return pageOwns(id,key);});
      }
      function pageValid(id){
        if(id==='general'&&!validChain(chainRows()))return false;
        if(id==='strategy'&&!validGuidance(guidanceRows()))return false;
        if(id==='advanced'&&!validWrapperRows(wrapperRows()))return false;
        return !invalidKeys.some(function(key){return pageOwns(id,key);});
      }
      function discardPage(id){
        var keys=pageKeys[id]||new Set();
        if(keys.has('providers'))setChainDraft(undefined);
        if(keys.has('wrappedProviders'))setWrapperDraft(undefined);
        if(keys.has('guidanceOverrides'))setGuidanceDraft(undefined);
        setDrafts(function(previous){var next=Object.assign({},previous);keys.forEach(function(key){delete next[key];});return next;});
        setSaveState({status:'idle',page:id});
      }
      async function savePage(id){
        var items=pagePlan(id);
        if(!scope||typeof scope.set!=='function'||!writable||saving||!pageDirty(id)||!pageValid(id)||items.length===0)return;
        setSaveState({status:'saving',page:id});
        try{
          var outcome=await applyPlan(items);
          clearLanded(outcome.landedFields||[]);
          afterLanded(items,outcome.landedFields||[]);
          if(outcome.failed){
            reportFailures(outcome.failures);
            setSaveState({status:'error',page:id,error:tx('部分配置没有写入，未写入的修改已保留。','Some settings were not written; unwritten changes were kept.'),failures:outcome.failures});
          }else{
            setSaveState({status:'saved',page:id});
            if(id==='general'&&typeof helpers.readVisionGuideStep==='function'&&helpers.readVisionGuideStep()==='step2'&&typeof helpers.finishVisionSettingsGuide==='function'){
              try{helpers.finishVisionSettingsGuide({complete:true});}catch(_){}
            }
            setCardsOpen(function(previous){
              if(!previous||previous[id]!==true)return previous;
              var next=Object.assign({},previous);delete next[id];return next;
            });
          }
        }catch(error){
          var failure={field:'settings-plan',operation:'set',reason:'write-error',detail:error&&error.message?error.message:String(error)};
          reportFailures([failure]);
          setSaveState({status:'error',page:id,error:failure.detail,failures:[failure]});
        }
      }`,
    'per-card save model',
  )

  next = replaceRequired(
    next,
    "async function resetField(key){if(!scope||typeof scope.unset!=='function'||!writable||saving)return;",
    "async function resetField(key){if(cardDirty||!scope||typeof scope.unset!=='function'||!writable||saving)return;",
    'reset transaction guard',
  )

  next = replaceRequired(
    next,
    "h('button',{type:'button',className:'vr-reset',disabled:!writable||saving,onClick:function(){void resetField(key);}},tx('恢复默认','Reset'))",
    "h('button',{type:'button',className:'vr-reset',disabled:cardDirty||!writable||saving,onClick:function(){void resetField(key);}},tx('恢复默认','Reset'))",
    'reset affordance guard',
  )

  next = replaceRequired(
    next,
    "function card(children){return h('div',{className:'vr-card vr-card-open vr-ia-card'},h('div',{className:'vr-body',style:{borderTop:0}},children));}",
    "function card(children){return h('div',{className:'vr-ia-subcard'},children);}",
    'inner card chrome',
  )

  const oldRender = `      var pages=[['general',tx('常规','General')],['strategy',tx('识图策略','Vision strategy')],['local',tx('本地与设备','Local & device')],['advanced',tx('高级','Advanced')],['diagnostics',tx('诊断','Diagnostics')]];
      var content=page==='strategy'?strategyPage():page==='local'?localPageContent():page==='advanced'?advancedPage():page==='diagnostics'?diagnosticsPage():generalPage();
      return h('div',{className:'vr-settings-ia-root','data-vr-settings-ia':'1'},snapshot.writable!==true?h('div',{className:'vr-ia-readonly'},tx('当前设置提供方只读。','The current settings provider is read-only.')):null,h('div',{className:'vr-ia-shell'},h('nav',{className:'vr-ia-nav','aria-label':tx('Vision Router 设置分类','Vision Router settings categories')},pages.map(function(item){return h('button',{type:'button',key:item[0],className:'vr-ia-nav-item'+(page===item[0]?' vr-ia-nav-active':''),onClick:function(){setPage(item[0]);}},item[1]);})),h('main',{className:'vr-ia-main'},content)),dirty?h('div',{className:'vr-ia-savebar'},h('span',{className:valid?'vr-hint':'vr-failed'},valid?tx('有未保存的修改','Unsaved changes'):tx('有设置值不完整或超出允许范围','Some settings are incomplete or outside the allowed range')),h('div',{className:'vr-ia-save-actions'},h('button',{type:'button',className:'vr-btn',disabled:saving,onClick:discard},tx('放弃','Discard')),h('button',{type:'button',className:'vr-btn vr-btn-save',disabled:!valid||!writable||saving,onClick:function(){void save();}},saving?tx('保存中…','Saving…'):tx('保存','Save')))):saveState.status==='saved'?h('div',{className:'vr-ia-toast'},tx('已保存','Saved')):saveState.status==='error'?h('div',{className:'vr-ia-toast vr-failed'},tx('保存失败：','Save failed: ')+String(saveState.error||'unknown')):actionState.status==='copied'?h('div',{className:'vr-ia-toast'},tx('诊断信息已复制','Diagnostics copied')):null);`

  const newRender = `      var pages=[
        ['general',tx('常规','General'),tx('识图模型、顺序和内置免费兜底','Vision models, ordering, and built-in free fallback')],
        ['strategy',tx('识图策略','Vision strategy'),tx('工具调用、结构化预识别与看图深度','Tool use, structured pre-scan, and vision depth')],
        ['local',tx('本地与设备','Local & device'),tx('Ollama、LM Studio 和桌面截图','Ollama, LM Studio, and desktop capture')],
        ['advanced',tx('高级','Advanced'),tx('性能、路由、网络与兼容设置','Performance, routing, network, and compatibility')],
        ['diagnostics',tx('诊断','Diagnostics'),tx('连接、模型目录、日志和版本检查','Connection, model catalog, logs, and updates')]
      ];
      function pageContent(id){return id==='strategy'?strategyPage():id==='local'?localPageContent():id==='advanced'?advancedPage():id==='diagnostics'?diagnosticsPage():generalPage();}
      function toggleCard(id){setCardsOpen(function(previous){var next=Object.assign({},previous);if(next[id]===true)delete next[id];else next[id]=true;return next;});}
      function chevron(opened){return h('svg',{className:'vr-ia-chevron'+(opened?' vr-ia-chevron-open':''),width:14,height:14,viewBox:'0 0 14 14',fill:'none','aria-hidden':'true'},h('path',{d:'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',fill:'currentColor'}));}
      function pageCard(item){
        var id=item[0],opened=!!(cardsOpen&&cardsOpen[id]===true),pending=pageDirty(id),cardValid=pageValid(id);
        var pageState=saveState&&((saveState.page===undefined)||saveState.page===id)?saveState:{status:'idle'};
        return h('li',{className:'vr-ia-plugin-card'+(opened?' vr-ia-plugin-card-open':''),key:id},
          h('button',{type:'button',className:'vr-ia-plugin-card-header','aria-expanded':opened,'aria-label':(opened?tx('收起：','Collapse: '):tx('展开：','Expand: '))+item[1],onClick:function(){toggleCard(id);}},
            h('span',{className:'vr-ia-plugin-card-headtext'},
              h('span',{className:'vr-ia-plugin-card-name'},item[1]),
              h('span',{className:'vr-ia-plugin-card-description'},item[2])
            ),
            pending?h('span',{className:'vr-ia-pending'},tx('未保存','Unsaved')):null,
            chevron(opened)
          ),
          opened?h('div',{className:'vr-ia-plugin-card-body'},
            snapshot.writable!==true?h('p',{className:'vr-ia-card-readonly',role:'status'},tx('当前设置提供方只读。','The current settings provider is read-only.')):null,
            pageContent(id),
            id==='diagnostics'?null:h('div',{className:'vr-ia-card-footer'},
              pageState.status==='error'?h('p',{className:'vr-failed',role:'status'},tx('保存失败：','Save failed: ')+String(pageState.error||'unknown'))
                :pending?h('span',{className:cardValid?'vr-hint':'vr-failed'},cardValid?tx('有未保存的修改','Unsaved changes'):tx('当前卡片有设置值不完整或超出允许范围','This card has incomplete or out-of-range settings'))
                :h('span',{className:'vr-hint'},pageState.status==='saved'?tx('已保存','Saved'):''),
              h('div',{className:'vr-ia-save-actions'},
                h('button',{type:'button',className:'vr-btn vr-ia-discard',disabled:!pending||saving,onClick:function(){discardPage(id);}},tx('放弃','Discard')),
                h('button',{type:'button',className:'vr-btn vr-btn-save vr-ia-save',disabled:!pending||!cardValid||!writable||saving,onClick:function(){void savePage(id);}},pageState.status==='saving'?tx('保存中…','Saving…'):tx('保存','Save'))
              )
            )
          ):null
        );
      }
      function replayGuide(){
        if(cardDirty||typeof helpers.startVisionSettingsGuide!=='function')return;
        setCardsOpen({});
        try{
          if(typeof document!=='undefined'&&document&&typeof document.dispatchEvent==='function'&&typeof KeyboardEvent==='function'){
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
          }
        }catch(_){}
        var start=function(){helpers.startVisionSettingsGuide();};
        if(typeof window!=='undefined'&&window&&typeof window.requestAnimationFrame==='function')window.requestAnimationFrame(start);
        else start();
      }
      return h('div',{className:'vr-settings-ia-root','data-vr-settings-ia':'1','data-vr-dirty':cardDirty?'1':'0','data-vr-invalid':valid?'0':'1'},
        h('div',{className:'vr-ia-page-head'},
          h('div',null,
            h('h2',{className:'vr-ia-page-title'},'Vision Router'),
            h('p',{className:'vr-hint'},tx('展开需要修改的设置卡片；多张卡可以同时保持展开。','Open the settings cards you need; multiple cards can stay expanded.'))
          ),
          h('button',{type:'button',className:'vr-btn vr-ia-guide-button',title:cardDirty?tx('请先保存或放弃当前修改','Save or discard current changes first'):'',disabled:cardDirty||typeof helpers.startVisionSettingsGuide!=='function',onClick:replayGuide},tx('重新查看新手引导','Show beginner guide again'))
        ),
        h('ul',{className:'vr-ia-card-list'},pages.map(pageCard)),
        actionState.status==='copied'?h('div',{className:'vr-ia-toast'},tx('诊断信息已复制','Diagnostics copied')):null
      );`

  next = replaceRequired(next, oldRender, newRender, 'settings card list')

  return next
}

export const SETTINGS_NATIVE_CARD_IA_PRELUDE = transformSettingsIaToNativeCards()

export const SETTINGS_NATIVE_CARD_STYLE = String.raw`
.vr-settings-ia-root{width:100%;min-width:0;color:var(--dsw-alias-label-primary)}
.vr-ia-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 14px}
.vr-ia-page-title{margin:0 0 4px;font-size:20px;color:var(--dsw-alias-label-primary)}
.vr-ia-guide-button{flex:0 0 auto}
.vr-ia-card-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.vr-ia-plugin-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}
.vr-ia-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.vr-ia-plugin-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.vr-ia-plugin-card-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
.vr-ia-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.vr-ia-plugin-card-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.vr-ia-plugin-card-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.vr-ia-plugin-card-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.vr-ia-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.vr-ia-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.vr-ia-chevron-open{transform:rotate(180deg)}
.vr-ia-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.vr-ia-card-readonly{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.vr-ia-section-head{display:none}
.vr-ia-subcard{padding:12px 0}
.vr-ia-subcard+.vr-ia-subcard{border-top:1px solid var(--dsw-alias-border-l2)}
.vr-ia-card-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.vr-ia-card-footer>.vr-hint,.vr-ia-card-footer>.vr-failed{flex:1;min-width:0;margin:0}
.vr-ia-card-footer .vr-btn{padding:5px 14px}
.vr-ia-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.vr-ia-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.vr-ia-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
.vr-guide-callout{margin:2px 0 12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-3)}
.vr-guide-callout-title{margin:0 0 6px;font-size:14px;font-weight:650;color:var(--dsw-alias-label-primary)}
.vr-guide-callout-body{margin:0 0 10px;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.vr-ia-toggle-row,.vr-ia-backend-head,.vr-ia-diag-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 0}
.vr-ia-diag-row+.vr-ia-diag-row,.vr-ia-toggle-row+.vr-ia-toggle-row{border-top:1px solid var(--dsw-alias-border-l2)}
.vr-ia-grow{min-width:0;flex:1}
.vr-ia-status strong{font-size:15px}
.vr-ia-chain-summary{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.vr-ia-subtitle{margin:12px 0 8px;font-size:14px;color:var(--dsw-alias-label-primary)}
.vr-ia-subgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.vr-ia-textarea{min-height:88px;resize:vertical}
.vr-ia-field-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px}
.vr-ia-badges{display:flex;align-items:center;gap:6px}
.vr-ia-badge{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.vr-ia-save-actions,.vr-ia-actions{display:flex;gap:8px;flex-wrap:wrap}
.vr-ia-toast{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.vr-ia-dev{margin-top:12px}
.vr-ia-manual{display:flex;flex-direction:column;gap:7px;margin-top:10px}
.vr-ia-code{display:block;overflow:auto;white-space:pre;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px}
.vr-settings-ia-root .vr-chain-row{align-items:center}
.vr-settings-ia-root .vr-field{margin-bottom:10px}
@media (max-width:760px){.vr-ia-page-head{align-items:stretch;flex-direction:column}.vr-ia-guide-button{align-self:flex-start}.vr-ia-subgrid{grid-template-columns:1fr}.vr-ia-card-footer{align-items:flex-start;flex-direction:column}.vr-ia-save-actions{width:100%;justify-content:flex-end}}
`

export function injectSettingsNativeCardStyle(html) {
  if (typeof html !== 'string' || html.includes(CARD_MARK)) return html
  const style = `<style ${CARD_MARK}>${SETTINGS_NATIVE_CARD_STYLE}</style>`
  const closeHead = html.indexOf('</head>')
  return closeHead === -1
    ? `${html}${style}`
    : `${html.slice(0, closeHead)}${style}${html.slice(closeHead)}`
}
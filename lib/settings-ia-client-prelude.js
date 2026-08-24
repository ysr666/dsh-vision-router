const CLIENT_MARK = 'data-vision-router-settings-ia'

export const SETTINGS_IA_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET='dsh-vision-router';
  var SECTION_ID='vision-router';
  var contexts=typeof WeakMap==='function'?new WeakMap():undefined;

  function zh(){
    try{return String(document.documentElement.lang||'').toLowerCase().startsWith('zh');}
    catch(_){return true;}
  }
  function tx(cn,en){return zh()?cn:en;}
  function rpcValue(body){
    if(body&&typeof body==='object'&&body.result&&typeof body.result==='object'){
      return body.result.ok===true?body.result.value:undefined;
    }
    return body;
  }
  function localPage(){
    try{
      var host=String(window.location.hostname||'').toLowerCase();
      if(host==='localhost'||host.endsWith('.localhost')||host==='::1'||host==='[::1]')return true;
      return /^127(?:\.\d{1,3}){3}$/.test(host);
    }catch(_){return false;}
  }
  function same(a,b){try{return JSON.stringify(a)===JSON.stringify(b);}catch(_){return false;}}
  function arr(value){return Array.isArray(value)?value:[];}
  function obj(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
  function builtinRow(row){return !!row&&row.provider==='vision-http'&&typeof row.model==='string'&&row.model.indexOf('ovh/')===0;}
  function cloneRow(row){return {provider:String(row&&row.provider||''),model:String(row&&row.model||''),fallbacks:arr(row&&row.fallbacks).slice()};}
  function splitChain(value){
    var builtins=[];var users=[];
    arr(value).forEach(function(row){if(!row||typeof row!=='object')return;(builtinRow(row)?builtins:users).push(cloneRow(row));});
    return {builtins:builtins,users:users};
  }
  function chainUiRows(value){var rows=splitChain(value).users;return rows.length?rows:[{provider:'',model:'',fallbacks:[]}];}
  function canonicalChain(saved,rows){
    var builtins=splitChain(saved).builtins;
    var users=[];
    arr(rows).forEach(function(row){
      var provider=String(row&&row.provider||'').trim();
      var model=String(row&&row.model||'').trim();
      if(!provider&&!model)return;
      users.push({provider:provider,model:model,fallbacks:arr(row&&row.fallbacks).filter(function(x){return typeof x==='string'&&x.trim();})});
    });
    if(users.length)return users.concat(builtins);
    if(builtins.length)return builtins;
    return [{provider:'vision-http',model:'ovh/Qwen3.5-397B-A17B',fallbacks:[]}];
  }
  function validChain(rows){
    return arr(rows).every(function(row){var p=String(row&&row.provider||'').trim();var m=String(row&&row.model||'').trim();return (!p&&!m)||(!!p&&!!m);});
  }
  function expandWrappers(value){
    var rows=[];
    arr(value).forEach(function(entry){
      if(!entry||typeof entry.provider!=='string'||!entry.provider)return;
      var models=arr(entry.models);
      if(models.length===0)rows.push({provider:entry.provider,model:''});
      else models.forEach(function(model){if(typeof model==='string'&&model)rows.push({provider:entry.provider,model:model});});
    });
    return rows.length?rows:[{provider:'',model:''}];
  }
  function collapseWrappers(rows){
    var merged=new Map();
    arr(rows).forEach(function(row){
      var provider=String(row&&row.provider||'').trim();
      var model=String(row&&row.model||'').trim();
      if(!provider)return;
      if(!merged.has(provider))merged.set(provider,new Set());
      var set=merged.get(provider);
      if(set===null)return;
      if(!model)merged.set(provider,null);else set.add(model);
    });
    return Array.from(merged.entries()).map(function(pair){return {provider:pair[0],models:pair[1]===null?[]:Array.from(pair[1])};});
  }
  function validWrapperRows(rows){return arr(rows).every(function(row){return !row||!row.model||!!row.provider;});}
  function canonicalGuidance(rows){
    return arr(rows).map(function(row){return {kind:String(row&&row.kind||'').trim(),text:String(row&&row.text||'').trim()};})
      .filter(function(row){return row.kind&&row.text;});
  }
  function validGuidance(rows){
    return arr(rows).every(function(row){var k=String(row&&row.kind||'').trim();var t=String(row&&row.text||'').trim();return (!k&&!t)||(!!k&&!!t);});
  }
  function availableGroups(groups,snapshot){
    var value=snapshot&&snapshot.value&&typeof snapshot.value==='object'?snapshot.value:{};
    var wrapper=typeof value.wrapperRoute==='string'&&value.wrapperRoute?value.wrapperRoute:'deepseek-vision';
    var chain=typeof value.chainRoute==='string'&&value.chainRoute?value.chainRoute:'vision-chain';
    return arr(groups).filter(function(group){
      if(!group||typeof group.id!=='string'||!group.id)return false;
      if(group.id==='vision-http'||group.id===wrapper||group.id===chain||group.id==='deepseek-official-native')return false;
      if(group.id.endsWith('-vision'))return false;
      return true;
    });
  }
  function modelName(group,model){
    if(!model)return '';
    var hit=arr(group&&group.models).find(function(item){return item&&item.id===model;});
    return hit&&hit.name&&hit.name!==model?hit.name+' ('+model+')':model;
  }

  function makeComponent(React){
    return function VisionRouterSettingsIA(props){
      var scope=props&&props.scope;
      var subscribe=React.useMemo(function(){return scope&&typeof scope.subscribe==='function'?scope.subscribe.bind(scope):function(){return function(){};};},[scope]);
      var getSnapshot=React.useMemo(function(){return scope&&typeof scope.getSnapshot==='function'?scope.getSnapshot.bind(scope):function(){return undefined;};},[scope]);
      var snapshot=React.useSyncExternalStore(subscribe,getSnapshot);
      var pageState=React.useState('general');var page=pageState[0];var setPage=pageState[1];
      var draftState=React.useState({});var drafts=draftState[0];var setDrafts=draftState[1];
      var chainState=React.useState(undefined);var chainDraft=chainState[0];var setChainDraft=chainState[1];
      var wrapperState=React.useState(undefined);var wrapperRowsDraft=wrapperState[0];var setWrapperRowsDraft=wrapperState[1];
      var guidanceState=React.useState(undefined);var guidanceRowsDraft=guidanceState[0];var setGuidanceRowsDraft=guidanceState[1];
      var savePair=React.useState({status:'idle',error:undefined});var saveState=savePair[0];var setSaveState=savePair[1];
      var catalogPair=React.useState({status:'idle',groups:[]});var catalog=catalogPair[0];var setCatalog=catalogPair[1];
      var localOpenPair=React.useState({ollama:false,lmstudio:false,developer:false});var open=localOpenPair[0];var setOpen=localOpenPair[1];
      var rootRef=React.useRef?React.useRef(null):{current:null};

      React.useEffect(function(){
        var root=rootRef&&rootRef.current;if(!root)return;
        var hidden=[];
        function hide(node){if(!node||node.nodeType!==1)return;if(String(node.tagName||'').toLowerCase()!=='ul')return;hidden.push([node,node.style.display]);node.style.display='none';}
        hide(root.previousElementSibling);hide(root.nextElementSibling);
        return function(){hidden.forEach(function(pair){try{pair[0].style.display=pair[1];}catch(_){}});};
      },[]);

      React.useEffect(function(){
        var disposed=false;var generation=0;var stops=[];
        function load(){
          var current=++generation;
          setCatalog(function(previous){return previous.status==='ready'?previous:{status:'loading',groups:previous.groups||[]};});
          try{
            var connection=props&&typeof props.getConnection==='function'?props.getConnection():undefined;
            var models=connection&&connection.api&&connection.api.llm&&connection.api.llm.models;
            if(typeof models!=='function'){if(!disposed&&current===generation)setCatalog({status:'error',groups:[]});return;}
            Promise.resolve(models.call(connection.api.llm,{})).then(function(body){
              if(disposed||current!==generation)return;var value=rpcValue(body);
              setCatalog({status:value&&Array.isArray(value.groups)?'ready':'error',groups:value&&Array.isArray(value.groups)?value.groups:[]});
            },function(){if(!disposed&&current===generation)setCatalog({status:'error',groups:[]});});
          }catch(_){if(!disposed&&current===generation)setCatalog({status:'error',groups:[]});}
        }
        load();
        try{if(props&&props.remote&&typeof props.remote.$on==='function'){
          stops.push(props.remote.$on('llm/adapters-updated',load));stops.push(props.remote.$on('settings/document-updated',load));
        }}catch(_){}
        try{if(props&&typeof props.subscribeConnectionReset==='function')stops.push(props.subscribeConnectionReset(load));}catch(_){}
        return function(){disposed=true;generation+=1;stops.forEach(function(stop){try{if(typeof stop==='function')stop();}catch(_){}});};
      },[props&&props.getConnection,props&&props.remote,props&&props.subscribeConnectionReset]);

      if(!snapshot||snapshot.status!=='ready')return null;
      var saved=obj(snapshot.value);var writable=snapshot.writable===true;var saving=saveState.status==='saving';var local=localPage();
      var groups=availableGroups(catalog.groups,snapshot);var groupById=new Map(groups.map(function(group){return [group.id,group];}));
      var h=React.createElement;
      function hasDraft(key){return Object.prototype.hasOwnProperty.call(drafts,key);}
      function value(key,fallback){var out=hasDraft(key)?drafts[key]:saved[key];return out===undefined?fallback:out;}
      function setValue(key,next){setDrafts(function(previous){var copy=Object.assign({},previous);copy[key]=next;return copy;});setSaveState({status:'idle'});}
      function chainRows(){return chainDraft===undefined?chainUiRows(saved.providers):chainDraft;}
      function wrapperRows(){return wrapperRowsDraft===undefined?expandWrappers(saved.wrappedProviders):wrapperRowsDraft;}
      function guidanceRows(){var base=arr(saved.guidanceOverrides);return guidanceRowsDraft===undefined?(base.length?base:[{kind:'',text:''}]):guidanceRowsDraft;}
      function topDirtyKeys(){return Object.keys(drafts).filter(function(key){return !same(drafts[key],saved[key]);});}
      var chainCanonical=canonicalChain(saved.providers,chainRows());
      var chainDirty=chainDraft!==undefined&&!same(chainCanonical,arr(saved.providers));
      var wrapperCanonical=collapseWrappers(wrapperRows());
      var wrapperDirty=wrapperRowsDraft!==undefined&&!same(wrapperCanonical,arr(saved.wrappedProviders));
      var guidanceCanonical=canonicalGuidance(guidanceRows());
      var guidanceDirty=guidanceRowsDraft!==undefined&&!same(guidanceCanonical,arr(saved.guidanceOverrides));
      var dirtyKeys=topDirtyKeys();
      var dirty=dirtyKeys.length>0||chainDirty||wrapperDirty||guidanceDirty;
      var valid=validChain(chainRows())&&validWrapperRows(wrapperRows())&&validGuidance(guidanceRows());

      async function save(){
        if(!scope||typeof scope.set!=='function'||!writable||saving||!dirty||!valid)return;
        setSaveState({status:'saving'});
        try{
          var writes=[];
          if(chainDirty)writes.push(['providers',chainCanonical]);
          if(wrapperDirty)writes.push(['wrappedProviders',wrapperCanonical]);
          if(guidanceDirty)writes.push(['guidanceOverrides',guidanceCanonical]);
          dirtyKeys.forEach(function(key){writes.push([key,drafts[key]]);});
          for(var i=0;i<writes.length;i+=1){await scope.set(writes[i][0],writes[i][1]);if(typeof scope.load==='function')await scope.load();}
          setDrafts({});setChainDraft(undefined);setWrapperRowsDraft(undefined);setGuidanceRowsDraft(undefined);setSaveState({status:'saved'});
        }catch(error){setSaveState({status:'error',error:error&&error.message?error.message:String(error)});}
      }
      function discard(){setDrafts({});setChainDraft(undefined);setWrapperRowsDraft(undefined);setGuidanceRowsDraft(undefined);setSaveState({status:'idle'});}

      function title(text,help){return h('div',{className:'vr-ia-section-head'},h('div',null,h('h3',{className:'vr-ia-title'},text),help?h('p',{className:'vr-hint'},help):null));}
      function card(children,extra){return h('div',{className:'vr-card vr-card-open vr-ia-card'+(extra?' '+extra:'')},h('div',{className:'vr-body',style:{borderTop:0}},children));}
      function toggle(key,label,hint,disabled){
        var checked=value(key,false)===true;
        return h('label',{className:'vr-ia-toggle-row'},h('div',{className:'vr-ia-grow'},h('span',{className:'vr-label'},label),hint?h('p',{className:'vr-hint'},hint):null),h('input',{type:'checkbox',checked:checked,disabled:disabled||!writable||saving,onChange:function(event){setValue(key,event.target.checked);}}));
      }
      function numberField(key,label,hint,min,max,disabled){
        var current=value(key,'');
        return h('div',{className:'vr-field'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},label)),h('input',{className:'vr-input',type:'number',min:min,max:max,value:current,disabled:disabled||!writable||saving,onChange:function(event){var text=event.target.value;setValue(key,text===''?'':Number(text));}}),hint?h('p',{className:'vr-hint'},hint):null);
      }
      function textField(key,label,hint,disabled){
        return h('div',{className:'vr-field'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},label)),h('input',{className:'vr-input',value:String(value(key,'')||''),disabled:disabled||!writable||saving,onChange:function(event){setValue(key,event.target.value);}}),hint?h('p',{className:'vr-hint'},hint):null);
      }
      function textareaArray(key,label,hint,disabled){
        return h('div',{className:'vr-field'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},label)),h('textarea',{className:'vr-input vr-ia-textarea',value:arr(value(key,[])).join('\n'),disabled:disabled||!writable||saving,onChange:function(event){setValue(key,event.target.value.split(/\r?\n/).map(function(x){return x.trim();}).filter(Boolean));}}),hint?h('p',{className:'vr-hint'},hint):null);
      }
      function providerOptions(current){
        var nodes=[h('option',{value:'',key:'__empty'},tx('选择供应商…','Choose provider…'))];
        if(current&&!groupById.has(current))nodes.push(h('option',{value:current,key:'__stale-'+current},current+' '+tx('（已保存）','(saved)')));
        groups.forEach(function(group){nodes.push(h('option',{value:group.id,key:group.id},group.name&&group.name!==group.id?group.name+' ('+group.id+')':group.id));});return nodes;
      }
      function modelOptions(provider,current,allowAll){
        var group=groupById.get(provider);var models=arr(group&&group.models);var listed=new Set(models.map(function(model){return model&&model.id;}).filter(Boolean));
        var nodes=[h('option',{value:'',key:'__empty'},allowAll?tx('全部模型','All models'):(provider?tx('选择模型…','Choose model…'):tx('先选供应商','Choose provider first')))];
        if(current&&!listed.has(current))nodes.push(h('option',{value:current,key:'__stale-'+current},current+' '+tx('（已保存）','(saved)')));
        models.forEach(function(model){if(!model||typeof model.id!=='string'||!model.id)return;nodes.push(h('option',{value:model.id,key:model.id},modelName(group,model.id));});return nodes;
      }
      function modelRow(row,index,rows,setRows,allowAll){
        var catalogReady=groups.length>0;
        function update(next){var copy=rows.map(function(item){return Object.assign({},item);});copy[index]=next;setRows(copy);setSaveState({status:'idle'});}
        function remove(){var copy=rows.filter(function(_,i){return i!==index;});setRows(copy.length?copy:[{provider:'',model:'',fallbacks:[]}]);setSaveState({status:'idle'});}
        return h('div',{className:'vr-chain-row',key:index},catalogReady?h('select',{className:'vr-input vr-select',value:row.provider||'',disabled:!writable||saving,onChange:function(event){update(Object.assign({},row,{provider:event.target.value,model:''}));}},providerOptions(row.provider||'')):h('input',{className:'vr-input',placeholder:tx('provider','provider'),value:row.provider||'',disabled:!writable||saving,onChange:function(event){update(Object.assign({},row,{provider:event.target.value}));}}),catalogReady?h('select',{className:'vr-input vr-select',value:row.model||'',disabled:!writable||saving||!row.provider,onChange:function(event){update(Object.assign({},row,{model:event.target.value}));}},modelOptions(row.provider||'',row.model||'',allowAll)):h('input',{className:'vr-input',placeholder:allowAll?tx('model（留空=全部）','model (empty = all)'):tx('model','model'),value:row.model||'',disabled:!writable||saving,onChange:function(event){update(Object.assign({},row,{model:event.target.value}));}}),h('button',{type:'button',className:'vr-reset',disabled:!writable||saving,onClick:remove},tx('移除','Remove')));
      }
      function statusSummary(){
        var rows=chainRows().filter(function(row){return row&&row.provider&&row.model;});
        if(rows.length)return {tone:'ok',title:tx('识图已就绪','Vision ready'),body:tx('需要看图时，在聊天框旁点击「👁 识图」。','Use the “👁 Vision” control beside the chat box when an image needs inspection.')};
        if(value('freeFallback',true)!==false)return {tone:'ok',title:tx('已可使用内置免费识图','Built-in free vision is ready'),body:tx('你还没有选择自己的识图模型；当前会使用内置免费兜底。','No custom vision model is selected; the built-in free fallback will be used.')};
        return {tone:'warn',title:tx('暂无可用识图模型','No vision model configured'),body:tx('添加一个识图模型，或重新开启内置免费兜底。','Add a vision model or re-enable the built-in free fallback.')};
      }
      function generalPage(){
        var rows=chainRows();var status=statusSummary();var ordered=rows.filter(function(row){return row&&row.provider&&row.model;}).map(function(row){return row.model;});if(value('freeFallback',true)!==false)ordered.push(tx('内置免费兜底','Built-in free fallback'));
        return h(React.Fragment,null,title(tx('常规','General'),tx('这里只设置“谁负责看图”。聊天模型仍在聊天页选择。','This page only decides who reads images; the chat model is still chosen in chat.')),card([h('div',{className:'vr-ia-status '+(status.tone==='warn'?'vr-ia-status-warn':'vr-ia-status-ok'),key:'status'},h('strong',null,(status.tone==='warn'?'⚠ ':'● ')+status.title),h('p',{className:'vr-hint'},status.body),ordered.length?h('p',{className:'vr-ia-chain-summary'},ordered.join(' → ')):null)]),card([h('div',{className:'vr-field',id:'vr-vision-backend-chain','data-vr-guide-target':'vision-backend',key:'chain'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},tx('识图模型','Vision models'))),h('p',{className:'vr-hint'},tx('从上到下依次尝试；前一个失败时自动切换到下一个。','Models are tried from top to bottom and fall through automatically on failure.')),rows.map(function(row,index){return modelRow(row,index,rows,setChainDraft,false);}),h('button',{type:'button',className:'vr-btn',disabled:!writable||saving,onClick:function(){setChainDraft(rows.concat([{provider:'',model:'',fallbacks:[]}]))}},tx('+ 添加备用识图模型','+ Add fallback vision model'))),toggle('freeFallback',tx('内置免费兜底','Built-in free fallback'),tx('前面的模型都失败后自动尝试，无需 API Key。','Tried after your models fail; no API key required.'))]));
      }
      function strategyPage(){
        var structured=value('structuredVisionBootstrap',false)===true;var depth=String(value('visionDepth','standard')||'standard');var rows=guidanceRows();
        return h(React.Fragment,null,title(tx('识图策略','Vision strategy'),tx('只有想改变识图方式或质量时才需要来这里。','Change these only when you want different vision behavior or quality.')),card([toggle('tool',tx('Agent 按需使用识图工具','Let the agent use vision tools on demand'),tx('允许聊天模型根据任务继续细看、OCR、定位、裁剪和比较图片。建议开启。','Lets the chat model inspect, OCR, locate, crop, and compare images as needed. Recommended on.')),toggle('structuredVisionBootstrap',tx('结构化预识别（1+x）','Structured pre-scan (1+x)'),tx('先获取一次全局视觉基线，再针对当前任务继续取证；会增加至少一次视觉调用。','Gets a global visual baseline first, then gathers task-specific evidence; adds at least one vision call.'))]),structured?card([h('div',{className:'vr-field',key:'depth'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},tx('看图深度','Vision depth'))),h('select',{className:'vr-input vr-select',value:depth,disabled:!writable||saving,onChange:function(event){setValue('visionDepth',event.target.value);}},h('option',{value:'fast'},tx('快速','Fast')),h('option',{value:'standard'},tx('标准','Standard')),h('option',{value:'deep'},tx('深度','Deep')),h('option',{value:'custom'},tx('自定义','Custom')))),depth==='custom'?numberField('visionDepthMaxCalls',tx('最多追加识图调用','Maximum additional vision calls'),tx('0 表示不额外设置上限。','0 leaves the custom cap unset.'),0,100):null,h('div',{className:'vr-field',key:'guidance'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},tx('自定义识图引导','Custom vision guidance'))),h('p',{className:'vr-hint'},tx('通常无需设置；仅在你希望某类图片按特定重点阅读时添加。','Usually unnecessary; add only when a visual kind needs special reading guidance.')),rows.map(function(row,index){return h('div',{className:'vr-chain-row',key:index},h('input',{className:'vr-input',placeholder:tx('类型，如 document','Kind, e.g. document'),value:row.kind||'',disabled:!writable||saving,onChange:function(event){var copy=rows.map(function(item){return Object.assign({},item);});copy[index]={kind:event.target.value,text:row.text||''};setGuidanceRowsDraft(copy);}}),h('input',{className:'vr-input',placeholder:tx('重点关注合同条款和签名','Focus on clauses and signatures'),value:row.text||'',disabled:!writable||saving,onChange:function(event){var copy=rows.map(function(item){return Object.assign({},item);});copy[index]={kind:row.kind||'',text:event.target.value};setGuidanceRowsDraft(copy);}}),h('button',{type:'button',className:'vr-reset',disabled:!writable||saving,onClick:function(){var copy=rows.filter(function(_,i){return i!==index;});setGuidanceRowsDraft(copy.length?copy:[{kind:'',text:''}]);}},tx('移除','Remove')));}),h('button',{type:'button',className:'vr-btn',disabled:!writable||saving,onClick:function(){setGuidanceRowsDraft(rows.concat([{kind:'',text:''}]))}},tx('+ 添加自定义引导','+ Add custom guidance')))]) : null);
      }
      function localProviderCard(key,label,defaults,which){
        var current=Object.assign({},defaults,obj(value(key,{})));var opened=which==='ollama'?open.ollama:open.lmstudio;
        function update(patch){setValue(key,Object.assign({},current,patch));}
        return card([h('div',{className:'vr-ia-backend-head',key:'head'},h('div',null,h('strong',null,label),h('p',{className:'vr-hint'},current.enabled?tx('已启用','Enabled'):tx('未启用','Disabled'))),h('label',{className:'vr-ia-inline-toggle'},h('input',{type:'checkbox',checked:current.enabled===true,disabled:!writable||saving,onChange:function(event){update({enabled:event.target.checked});}}))),h('div',{className:'vr-field',key:'model'},h('span',{className:'vr-label'},tx('模型','Model')),h('input',{className:'vr-input',value:String(current.model||''),disabled:!writable||saving,onChange:function(event){update({model:event.target.value});}})),h('div',{className:'vr-field',key:'url'},h('span',{className:'vr-label'},tx('服务地址','Service URL')),h('input',{className:'vr-input',value:String(current.baseURL||''),disabled:!writable||saving,onChange:function(event){update({baseURL:event.target.value});}})),h('button',{type:'button',className:'vr-btn vr-ia-link-btn',onClick:function(){setOpen(Object.assign({},open,which==='ollama'?{ollama:!opened}:{lmstudio:!opened}));}},opened?tx('收起高级连接设置','Hide advanced connection settings'):tx('高级连接设置','Advanced connection settings')),opened?h('div',{className:'vr-ia-subgrid',key:'advanced'},h('div',{className:'vr-field'},h('span',{className:'vr-label'},tx('请求协议','Request protocol')),h('select',{className:'vr-input vr-select',value:current.format==='anthropic'?'anthropic':'openai',disabled:!writable||saving,onChange:function(event){update({format:event.target.value});}},h('option',{value:'openai'},'OpenAI'),h('option',{value:'anthropic'},'Anthropic'))),h('div',{className:'vr-field'},h('span',{className:'vr-label'},'temperature'),h('input',{className:'vr-input',type:'number',step:'0.1',min:0,max:2,value:current.temperature===undefined?'':current.temperature,disabled:!writable||saving,onChange:function(event){update({temperature:event.target.value===''?undefined:Number(event.target.value)});}})),h('div',{className:'vr-field'},h('span',{className:'vr-label'},'top_p'),h('input',{className:'vr-input',type:'number',step:'0.1',min:0,max:1,value:current.top_p===undefined?'':current.top_p,disabled:!writable||saving,onChange:function(event){update({top_p:event.target.value===''?undefined:Number(event.target.value)});}}))):null]);
      }
      function localPageContent(){
        if(!local)return h(React.Fragment,null,title(tx('本地与设备','Local & device')),card([h('p',{className:'vr-hint',key:'remote'},tx('本地视觉后端和桌面截图只能在运行 DSH 的机器上配置。','Local vision backends and desktop capture can only be configured on the DSH machine.'))]));
        return h(React.Fragment,null,title(tx('本地与设备','Local & device'),tx('本地运行视觉模型可减少 API 费用和图片上传。','Run vision locally to reduce API cost and image uploads.')),localProviderCard('localOllama','Ollama',{enabled:false,baseURL:'http://127.0.0.1:11434/v1',model:'qwen2.5vl',format:'openai'},'ollama'),localProviderCard('localLmStudio','LM Studio',{enabled:false,baseURL:'http://localhost:1234/v1',model:'',format:'openai'},'lmstudio'),card([toggle('desktopScreenshot',tx('允许 Agent 读取桌面截图','Allow the agent to capture the desktop'),tx('这是独立的隐私权限；只有需要主动查看桌面时才开启。','This is a separate privacy permission; enable only when desktop inspection is needed.'))]));
      }
      function wrappersEditor(){
        var rows=wrapperRows();
        return h('div',{className:'vr-field'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},tx('哪些聊天模型可以开启识图','Which chat models can use Vision mode'))),h('p',{className:'vr-hint'},value('autoWrapProviders',true)!==false?tx('自动模式开启；下面只用于限制特定 Provider。','Automatic mode is on; rows below only restrict specific providers.'):tx('仅自定义模式；只有下面列出的 Provider / Model 可以开启识图。','Custom-only mode; only the rows below can use Vision mode.')),rows.map(function(row,index){return modelRow(row,index,rows,setWrapperRowsDraft,true);}),h('button',{type:'button',className:'vr-btn',disabled:!writable||saving,onClick:function(){setWrapperRowsDraft(rows.concat([{provider:'',model:''}]))}},tx('+ 添加范围','+ Add scope')));
      }
      function textProviderEditor(){
        var current=Object.assign({provider:'',model:''},obj(value('textProvider',{})));var catalogReady=groups.length>0;
        return h('div',{className:'vr-field'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},tx('文字回退模型','Text fallback model'))),h('div',{className:'vr-chain-row'},catalogReady?h('select',{className:'vr-input vr-select',value:current.provider||'',disabled:!writable||saving,onChange:function(event){setValue('textProvider',{provider:event.target.value,model:''});}},providerOptions(current.provider||'')):h('input',{className:'vr-input',value:current.provider||'',disabled:!writable||saving,onChange:function(event){setValue('textProvider',{provider:event.target.value,model:current.model||''});}}),catalogReady?h('select',{className:'vr-input vr-select',value:current.model||'',disabled:!writable||saving||!current.provider,onChange:function(event){setValue('textProvider',{provider:current.provider||'',model:event.target.value});}},modelOptions(current.provider||'',current.model||'',false)):h('input',{className:'vr-input',value:current.model||'',disabled:!writable||saving,onChange:function(event){setValue('textProvider',{provider:current.provider||'',model:event.target.value});}})),h('p',{className:'vr-hint'},tx('只有开启“整轮视觉路由”时才使用。','Used only when whole-turn vision routing is enabled.')));
      }
      function advancedPage(){
        var routing=value('routing',false)===true;var turnBudget=Number(value('visionTurnBudgetMs',0))||0;var customBudget=turnBudget>0;var rows=wrapperRows();
        return h(React.Fragment,null,title(tx('高级','Advanced'),tx('这些默认值对大多数用户已经合适；遇到特殊兼容、性能或网络需求时再修改。','Defaults are suitable for most users; change these only for special performance, compatibility, or network needs.')),card([h('h4',{className:'vr-ia-subtitle',key:'p-title'},tx('性能与稳定性','Performance & stability')),toggle('downscale',tx('自动缩放','Auto downscale'),tx('超过像素预算的图片会先缩小，以降低延迟和成本。','Large images are resized before vision calls to reduce latency and cost.')),numberField('downscaleMaxPixels',tx('图片像素上限','Image pixel limit'),null,1000,100000000),toggle('cache',tx('识图缓存','Vision answer cache'),tx('按图片内容和问题缓存识图结果。','Caches vision answers by image content and question.')),numberField('cacheTtlSeconds',tx('缓存有效期（秒）','Cache TTL (seconds)'),null,0,31536000),numberField('cacheMaxEntries',tx('最大缓存数量','Maximum cached answers'),null,1,100000),h('div',{className:'vr-ia-divider',key:'timeouts'}),h('h4',{className:'vr-ia-subtitle'},tx('超时','Timeouts')),numberField('timeoutMs',tx('单次模型请求','Single model request'),tx('毫秒。','Milliseconds.'),1000,600000),numberField('visionTaskTimeoutMs',tx('单个视觉任务','Single visual task'),tx('包含该任务内部的重试和备用模型。','Includes retries and fallbacks inside that task.'),1000,180000),numberField('ocrTimeoutMs',tx('OCR 任务','OCR task'),null,1000,120000),h('div',{className:'vr-field'},h('div',{className:'vr-field-head'},h('span',{className:'vr-label'},tx('整轮视觉工具上限','Whole-turn vision-tool limit'))),h('select',{className:'vr-input vr-select',value:customBudget?'custom':'unlimited',disabled:!writable||saving,onChange:function(event){setValue('visionTurnBudgetMs',event.target.value==='unlimited'?0:(turnBudget>0?turnBudget:180000));}},h('option',{value:'unlimited'},tx('不限制（推荐）','Unlimited (recommended)')),h('option',{value:'custom'},tx('自定义','Custom'))),customBudget?numberField('visionTurnBudgetMs',tx('上限（毫秒）','Limit (ms)'),tx('只限制本轮 Vision Router 视觉工具累计时间；单个视觉任务仍有独立超时。','Limits aggregate Vision Router visual-tool time in the turn; individual tasks keep separate timeouts.'),10000,600000):null)]),card([h('h4',{className:'vr-ia-subtitle',key:'cost'},tx('模型顺序与成本','Model order & cost')),toggle('freeCloudFirst',tx('免费云模型优先','Try free cloud models first'),tx('先尝试内置免费模型，再使用你配置的付费模型。','Try built-in free models before your configured paid models.'))]),card([h('h4',{className:'vr-ia-subtitle',key:'scope'},tx('识图模式范围','Vision mode scope')),toggle('autoWrapProviders',tx('自动允许已启用模型使用识图','Automatically allow enabled models to use Vision mode'),tx('推荐开启。只有想限制某些 Provider / Model 时才编辑下面的范围。','Recommended on. Edit the scope below only when some providers/models should be restricted.')),wrappersEditor()]),local?card([h('h4',{className:'vr-ia-subtitle',key:'network'},tx('网络与远程','Network & remote')),toggle('allowRemoteSettings',tx('允许可信 Host 远程修改设置','Allow trusted-host remote settings'),tx('默认关闭；trustedHosts 不是身份认证，只在你信任可访问该 DSH 实例的客户端时开启。','Off by default; trustedHosts is not authentication. Enable only for clients you trust.')),textField('proxy',tx('代理地址','Proxy URL'),tx('留空关闭代理。','Leave empty to disable.')),textareaArray('proxyHosts',tx('走代理的域名','Proxied hosts'),tx('每行一个。','One per line.'))]):null,card([h('h4',{className:'vr-ia-subtitle',key:'compat'},tx('兼容模式','Compatibility')),toggle('rewriteImages',tx('保护纯文本模型','Protect text-only models'),tx('避免把原始图片直接发送给无法读取图片的模型。建议开启。','Prevents raw images from being sent to models that cannot read them. Recommended on.')),toggle('routing',tx('整轮视觉路由（旧工作流）','Whole-turn vision routing (legacy workflow)'),tx('一般无需开启；开启后整个图片轮交由视觉模型处理。','Usually unnecessary; hands the entire image turn to the vision model.')),routing?toggle('reverseRouting',tx('纯文字消息继续使用聊天模型','Keep text-only messages on the chat model'),null):null,routing?textProviderEditor():null]),card([h('button',{type:'button',className:'vr-btn vr-ia-link-btn',key:'dev-toggle',onClick:function(){setOpen(Object.assign({},open,{developer:!open.developer}));}},open.developer?tx('隐藏开发者设置','Hide developer settings'):tx('显示开发者设置','Show developer settings')),open.developer?h('div',{className:'vr-ia-dev',key:'dev'},h('h4',{className:'vr-ia-subtitle'},tx('开发者设置','Developer settings')),toggle('progressiveTools',tx('渐进式工具暴露','Progressive tool exposure'),tx('会改变工具 schema 的暴露方式；通常保持关闭。','Changes tool-schema exposure; normally keep off.')),local?toggle('stealth','Stealth',tx('路由接管兼容开关；一般不要修改。','Route-takeover compatibility switch; usually do not change.')):null,local?textField('wrapperRoute',tx('包装路由名','Wrapper route name'),null):null,local?textField('chainRoute',tx('视觉链路由名','Vision chain route name'),null):null,textareaArray('extraVisionModels',tx('额外视觉能力标记','Extra vision capability labels'),tx('只有诊断发现模型未声明图片能力时才需要。','Needed only when diagnostics show missing image-capability metadata.'))):null]));
      }
      function diagnosticsPlaceholder(){return h(React.Fragment,null,title(tx('诊断','Diagnostics')),card([h('p',{className:'vr-hint',key:'body'},tx('诊断页将在下一阶段接入版本、模型目录、后端状态和 Doctor；本轮先完成设置页信息架构重构。','Diagnostics will be wired to versions, model catalog, backend health, and Doctor in the next phase; this phase focuses on settings information architecture.'))]));}
      var pages=[['general',tx('常规','General')],['strategy',tx('识图策略','Vision strategy')],['local',tx('本地与设备','Local & device')],['advanced',tx('高级','Advanced')],['diagnostics',tx('诊断','Diagnostics')]];
      var content=page==='strategy'?strategyPage():page==='local'?localPageContent():page==='advanced'?advancedPage():page==='diagnostics'?diagnosticsPlaceholder():generalPage();
      return h('div',{className:'vr-settings-ia-root',ref:rootRef,'data-vr-settings-ia':'1'},h('div',{className:'vr-ia-shell'},h('nav',{className:'vr-ia-nav','aria-label':tx('Vision Router 设置分类','Vision Router settings categories')},pages.map(function(item){return h('button',{type:'button',key:item[0],className:'vr-ia-nav-item'+(page===item[0]?' vr-ia-nav-active':''),onClick:function(){setPage(item[0]);}},item[1]);})),h('main',{className:'vr-ia-main'},content)),dirty?h('div',{className:'vr-ia-savebar'},h('span',{className:valid?'vr-hint':'vr-failed'},valid?tx('有未保存的修改','Unsaved changes'):tx('请先补全未填写的配置行','Complete unfinished configuration rows first')),h('div',{className:'vr-ia-save-actions'},h('button',{type:'button',className:'vr-btn',disabled:saving,onClick:discard},tx('放弃','Discard')),h('button',{type:'button',className:'vr-btn vr-btn-save',disabled:!valid||!writable||saving,onClick:function(){void save();}},saving?tx('保存中…','Saving…'):tx('保存','Save')))):saveState.status==='saved'?h('div',{className:'vr-ia-toast'},tx('已保存','Saved')):saveState.status==='error'?h('div',{className:'vr-ia-toast vr-failed'},tx('保存失败：','Save failed: ')+String(saveState.error||'unknown')):null);
    };
  }

  function wrapSlots(slots,React){
    if(!slots||(typeof slots!=='object'&&typeof slots!=='function'))return slots;
    var IA=makeComponent(React);
    return new Proxy(slots,{get:function(target,property){
      if(property==='register'){
        var register=Reflect.get(target,property,target);if(typeof register!=='function')return register;
        return function(options,component){var args=Array.prototype.slice.call(arguments);if(options&&options.name==='settings.section'&&options.id===SECTION_ID&&component){args[1]=IA;}return register.apply(target,args);};
      }
      var value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
  }
  function wrapContext(ctx,React){
    if(!ctx||typeof ctx!=='object')return ctx;if(contexts&&contexts.has(ctx))return contexts.get(ctx);
    var slots=wrapSlots(ctx.slots,React);var wrapped=new Proxy(ctx,{get:function(target,property){if(property==='slots')return slots;var value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});if(contexts)contexts.set(ctx,wrapped);return wrapped;
  }
  function patchLoader(loader){
    if(!loader||(typeof loader!=='object'&&typeof loader!=='function'))return;
    if(typeof loader.load==='function'&&!loader.load.__visionRouterSettingsIA){var original=loader.load;function load(spec){if(spec&&spec.id===TARGET&&typeof spec.factory==='function'){var factory=spec.factory;spec=Object.assign({},spec,{factory:function(require){var exports=factory(require);var React;try{React=require('react');}catch(_){React=undefined;}if(React&&exports&&typeof exports.apply==='function'&&!exports.apply.__visionRouterSettingsIA){var apply=exports.apply;var wrappedApply=function(ctx){var rest=Array.prototype.slice.call(arguments,1);return apply.apply(exports,[wrapContext(ctx,React)].concat(rest));};Object.defineProperty(wrappedApply,'__visionRouterSettingsIA',{value:true});exports.apply=wrappedApply;}return exports;}});}return original.call(loader,spec);}Object.defineProperty(load,'__visionRouterSettingsIA',{value:true});loader.load=load;}
    if(typeof loader.create==='function'&&!loader.create.__visionRouterSettingsIA){var originalCreate=loader.create;function create(){var result=originalCreate.apply(this,arguments);patchLoader(loader);return result;}Object.defineProperty(create,'__visionRouterSettingsIA',{value:true});loader.create=create;}
  }
  function install(){
    if(window.__ModuleLoader__){patchLoader(window.__ModuleLoader__);return;}
    var descriptor=Object.getOwnPropertyDescriptor(window,'__ModuleLoader__');if(descriptor&&descriptor.configurable===false)return;var stored;
    Object.defineProperty(window,'__ModuleLoader__',{configurable:true,enumerable:true,get:function(){return stored;},set:function(value){stored=value;patchLoader(value);Object.defineProperty(window,'__ModuleLoader__',{configurable:true,enumerable:true,writable:true,value:stored});}});
  }
  try{install();}catch(_){}
})();`

const SETTINGS_IA_STYLE = String.raw`
.vr-settings-ia-root{width:100%;min-width:0}.vr-ia-shell{display:grid;grid-template-columns:158px minmax(0,1fr);gap:18px;align-items:start}.vr-ia-nav{position:sticky;top:12px;display:flex;flex-direction:column;gap:4px;padding:4px}.vr-ia-nav-item{border:0;background:transparent;color:inherit;text-align:left;padding:9px 11px;border-radius:9px;font:inherit;cursor:pointer;opacity:.72}.vr-ia-nav-item:hover{background:color-mix(in srgb,currentColor 7%,transparent);opacity:1}.vr-ia-nav-active{background:color-mix(in srgb,currentColor 10%,transparent);font-weight:650;opacity:1}.vr-ia-main{min-width:0}.vr-ia-section-head{margin:0 0 12px}.vr-ia-title{margin:0 0 4px;font-size:18px}.vr-ia-card{margin-bottom:12px}.vr-ia-toggle-row,.vr-ia-backend-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 0}.vr-ia-toggle-row+ .vr-ia-toggle-row{border-top:1px solid color-mix(in srgb,currentColor 10%,transparent)}.vr-ia-grow{min-width:0;flex:1}.vr-ia-status{padding:2px 0}.vr-ia-status strong{font-size:15px}.vr-ia-status-ok strong{color:inherit}.vr-ia-status-warn strong{color:#d97706}.vr-ia-chain-summary{margin:8px 0 0;font-size:12px;opacity:.74}.vr-ia-subtitle{margin:5px 0 8px;font-size:14px}.vr-ia-divider{height:1px;background:color-mix(in srgb,currentColor 10%,transparent);margin:12px 0}.vr-ia-subgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.vr-ia-subgrid>.vr-field:first-child{grid-column:1/-1}.vr-ia-link-btn{margin-top:4px}.vr-ia-textarea{min-height:88px;resize:vertical}.vr-ia-inline-toggle{display:flex;align-items:center;padding-top:2px}.vr-ia-savebar{position:sticky;bottom:10px;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding:10px 12px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:11px;background:color-mix(in srgb,Canvas 94%,transparent);backdrop-filter:blur(10px)}.vr-ia-save-actions{display:flex;gap:8px}.vr-ia-toast{margin-top:10px;font-size:12px;opacity:.75}.vr-ia-dev{margin-top:12px}.vr-settings-ia-root .vr-chain-row{align-items:center}.vr-settings-ia-root .vr-field{margin-bottom:10px}
@media (max-width:760px){.vr-ia-shell{grid-template-columns:1fr;gap:10px}.vr-ia-nav{position:static;flex-direction:row;overflow:auto;padding:0 0 4px}.vr-ia-nav-item{white-space:nowrap}.vr-ia-subgrid{grid-template-columns:1fr}.vr-ia-savebar{bottom:6px}}
`

export function injectSettingsIaClientPrelude(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_MARK)) return html
  const script = `<style ${CLIENT_MARK}>${SETTINGS_IA_STYLE}</style><script ${CLIENT_MARK}>${SETTINGS_IA_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installSettingsIaClientPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectSettingsIaClientPrelude),
      'vision-router: settings information architecture client prelude',
    )
  })
}

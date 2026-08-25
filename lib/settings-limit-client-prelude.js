import { SETTINGS_NUMBER_META } from './settings-number-contract.js'

const CLIENT_MARK = 'data-vision-router-settings-limit-hardening'
const META = JSON.stringify(SETTINGS_NUMBER_META)

export const SETTINGS_LIMIT_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET='dsh-vision-router';
  var SECTION_ID='vision-router';
  var META=${META};

  function obj(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
  function own(value,key){return !!value&&typeof value==='object'&&Object.prototype.hasOwnProperty.call(value,key);}
  function validNumber(key,raw){var meta=META[key];if(!meta)return true;var n=Number(raw);if(!Number.isFinite(n)||!Number.isInteger(n)||n<meta.min||n>meta.max)return false;return (n-meta.min)%meta.step===0;}
  function source(snapshot,key){var user=obj(snapshot&&snapshot.user),base=obj(snapshot&&snapshot.base);if(own(user,key))return ['用户设置','User override'];if(own(base,key))return ['Profile / Composition','Profile / Composition'];return ['默认','Default'];}
  function seconds(value,unlimited){var n=Number(value);if(unlimited&&n===0)return ['不限制','Unlimited'];if(!Number.isFinite(n))return ['未知','Unknown'];return [String(n/1000)+' 秒',String(n/1000)+'s'];}
  function zh(){try{return String(document.documentElement.lang||'').toLowerCase().startsWith('zh');}catch(_){return true;}}
  function tx(pair){return zh()?pair[0]:pair[1];}

  function wrapScope(scope){
    if(!scope||typeof scope!=='object')return scope;
    return new Proxy(scope,{get:function(target,property){
      if(property==='set'){
        var set=Reflect.get(target,property,target);if(typeof set!=='function')return set;
        return function(key,value){
          if(META[key]&&!validNumber(key,value)){
            var meta=META[key],error=new Error('value must be an integer between '+meta.min+' and '+meta.max+' in steps of '+meta.step);
            error.code='settings-client-validation';
            return Promise.reject(error);
          }
          return set.call(target,key,value);
        };
      }
      var value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
  }

  function textOf(React,node){
    if(node===null||node===undefined||node===false)return '';
    if(typeof node==='string'||typeof node==='number')return String(node);
    if(!React.isValidElement||!React.isValidElement(node))return '';
    var out='';React.Children.forEach(node.props&&node.props.children,function(child){out+=textOf(React,child)+' ';});return out;
  }

  function replacement(text){
    var map={
      '单个视觉任务':'单次识图任务超时',
      'Single visual task':'Single vision-task timeout',
      '包含该任务内部的重试和备用模型；不是每个后端各自一份。':'包含本次识图内部的重试和备用模型；最长 180 秒。它不会增加本轮视觉时间上限。',
      'Includes retries and fallbacks inside the task; it is not a fresh budget per backend.':'Includes retries and fallbacks for this vision task; maximum 180s. It does not extend the whole-turn vision deadline.',
      '整轮视觉工具上限':'首次识图后的整轮时间上限',
      'Whole-turn vision-tool limit':'Whole-turn limit after first vision call',
      '部分配置没有写入，未写入的修改已保留。':'Host 未接受或未持久化这项设置，修改已保留。请检查允许范围/步进，或确认 DSH 与 Vision Router 版本匹配。',
      'Some settings were not written; unwritten changes were kept.':'The Host did not accept or persist this setting. The edit was kept; check the allowed range/step and DSH/Vision Router version compatibility.'
    };
    return Object.prototype.hasOwnProperty.call(map,text)?map[text]:text;
  }

  function transformTree(React,node){
    if(typeof node==='string')return replacement(node);
    if(node===null||node===undefined||node===false||!React.isValidElement||!React.isValidElement(node))return node;
    var originalText=textOf(React,node),props={};
    if(node.props&&node.props.children!==undefined){props.children=React.Children.map(node.props.children,function(child){return transformTree(React,child);});}
    if(node.type==='input'&&node.props&&node.props.type==='number'){
      var min=Number(node.props.min),max=Number(node.props.max),match;
      Object.keys(META).some(function(key){var meta=META[key];if(meta.min===min&&meta.max===max){match=meta;return true;}return false;});
      if(match)props.step=match.step;
    }
    var next=React.cloneElement(node,props);
    if(node.type==='div'&&node.props&&String(node.props.className||'').includes('vr-field')&&originalText.includes('整轮视觉工具上限')){
      var hint=React.createElement('p',{className:'vr-hint',key:'issue307-budget-hint'},zh()
        ?'从本轮第一次实际 Vision Router 识图调用开始按墙钟计时；模型思考和两次识图之间的等待也计入。长任务建议保持“不限制”。'
        :'Wall-clock time starts at the first actual Vision Router vision call; model reasoning and waits between calls also count. Keep Unlimited for long tasks.');
      var children=React.Children.toArray(next.props.children);return React.cloneElement(next,{children:children.concat([hint])});
    }
    return next;
  }

  function diagnosticsCard(React,snapshot){
    var value=obj(snapshot&&snapshot.value),task=seconds(value.visionTaskTimeoutMs===undefined?120000:value.visionTaskTimeoutMs,false),budget=seconds(value.visionTurnBudgetMs===undefined?0:value.visionTurnBudgetMs,true),taskSource=source(snapshot,'visionTaskTimeoutMs'),budgetSource=source(snapshot,'visionTurnBudgetMs');
    function row(label,valueText){return React.createElement('div',{className:'vr-ia-diag-row'},React.createElement('span',null,label),React.createElement('strong',null,valueText));}
    return React.createElement('div',{className:'vr-card vr-card-open vr-ia-card','data-vr-limit-diagnostics':'1'},React.createElement('div',{className:'vr-body',style:{borderTop:0}},[
      row(zh()?'单次识图任务超时':'Single vision-task timeout',tx(task)+' · '+tx(taskSource)),
      row(zh()?'首次识图后的整轮时间上限':'Whole-turn limit after first vision call',tx(budget)+' · '+tx(budgetSource)),
      Number(value.visionTurnBudgetMs)>0?React.createElement('p',{className:'vr-hint',key:'warning'},zh()?'当前启用了显式整轮视觉时间上限；v2 默认是不限制，长任务可能在该时间后停止继续识图。':'An explicit whole-turn vision limit is active. v2 defaults to Unlimited; long tasks may stop making vision calls after this time.'):null
    ]));
  }

  function wrapSlots(slots,React){if(!slots||(typeof slots!=='object'&&typeof slots!=='function'))return slots;return new Proxy(slots,{get:function(target,property){if(property==='register'){var register=Reflect.get(target,property,target);if(typeof register!=='function')return register;return function(options,component){var args=Array.prototype.slice.call(arguments);if(options&&options.name==='settings.section'&&options.id===SECTION_ID&&typeof component==='function'){var Original=component;args[1]=function VisionRouterIssue307SettingsBoundary(props){var scope=wrapScope(props&&props.scope),nextProps=Object.assign({},props,{scope:scope}),tree=transformTree(React,Original(nextProps)),text=textOf(React,tree),snapshot;try{snapshot=scope&&scope.getSnapshot?scope.getSnapshot():undefined;}catch(_){snapshot=undefined;}if(text.includes('设置协议')||text.includes('Settings contract'))return React.createElement(React.Fragment,null,tree,diagnosticsCard(React,snapshot));return tree;};}return register.apply(target,args);};}var value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});}
  function wrapContext(ctx,React){if(!ctx||typeof ctx!=='object')return ctx;var slots=wrapSlots(ctx.slots,React);return new Proxy(ctx,{get:function(target,property){if(property==='slots')return slots;var value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});}
  function patchLoader(loader){if(!loader||(typeof loader!=='object'&&typeof loader!=='function'))return;if(typeof loader.load==='function'&&!loader.load.__visionRouterLimitHardening){var original=loader.load;function load(spec){if(spec&&spec.id===TARGET&&typeof spec.factory==='function'){var factory=spec.factory;spec=Object.assign({},spec,{factory:function(require){var exports=factory(require),React;try{React=require('react');}catch(_){React=undefined;}if(React&&exports&&typeof exports.apply==='function'&&!exports.apply.__visionRouterLimitHardening){var apply=exports.apply;var wrappedApply=function(ctx){var rest=Array.prototype.slice.call(arguments,1);return apply.apply(exports,[wrapContext(ctx,React)].concat(rest));};Object.defineProperty(wrappedApply,'__visionRouterLimitHardening',{value:true});exports.apply=wrappedApply;}return exports;}});}return original.call(loader,spec);}Object.defineProperty(load,'__visionRouterLimitHardening',{value:true});loader.load=load;}}
  function install(){if(window.__ModuleLoader__){patchLoader(window.__ModuleLoader__);return;}var descriptor=Object.getOwnPropertyDescriptor(window,'__ModuleLoader__');if(descriptor&&descriptor.configurable===false)return;var stored;Object.defineProperty(window,'__ModuleLoader__',{configurable:true,enumerable:true,get:function(){return stored;},set:function(value){stored=value;patchLoader(value);Object.defineProperty(window,'__ModuleLoader__',{configurable:true,enumerable:true,writable:true,value:stored});}});}
  try{install();}catch(_){}
})();`

export function injectSettingsLimitClientPrelude(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_MARK)) return html
  const script = `<script ${CLIENT_MARK}>${SETTINGS_LIMIT_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  return closeHead === -1 ? `${html}${script}` : `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
}

export function installSettingsLimitClientPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectSettingsLimitClientPrelude),
      'vision-router: settings numeric contract and limit diagnostics prelude',
    )
  })
}

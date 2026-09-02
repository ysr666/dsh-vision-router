import { htmlHasScriptMarker } from './html-script-marker.js'

const V2_SETTINGS_IA_MARK = 'data-vision-router-v2-settings-ia'

export const V2_SETTINGS_IA_STYLE = String.raw`
/*
 * v2 routing already mounts inside #vr-vision-backend-chain, which belongs to
 * Settings → Vision Router → General. Keep the existing v2 state machine, but
 * make that panel read as part of the new IA rather than a second settings app.
 */
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel].vr-routing-panel{
  margin:0 0 14px;
  padding:0 0 14px;
  border:0;
  border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);
  border-radius:0;
  background:transparent;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-head{
  margin:0 0 8px;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-title{
  font-size:14px;
  font-weight:650;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-sub{
  max-width:760px;
  margin-top:4px;
  color:inherit;
  opacity:.68;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-badge{
  border-color:color-mix(in srgb,currentColor 16%,transparent);
  color:inherit;
  opacity:.72;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-label{
  margin-top:9px;
  color:inherit;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-choice{
  border-color:color-mix(in srgb,currentColor 16%,transparent);
  color:inherit;
  opacity:.78;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-choice[data-active="1"]{
  background:color-mix(in srgb,currentColor 9%,transparent);
  border-color:color-mix(in srgb,currentColor 28%,transparent);
  color:inherit;
  opacity:1;
}
/* The IA selector is more specific than the legacy :disabled rule, so restate
 * disabled affordance here instead of leaving Ordered-only controls looking live. */
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-choice:disabled{
  opacity:.45;
  cursor:not-allowed;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-segment[data-vr-ia-disabled="1"]{
  opacity:.72;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-note{
  color:inherit;
  opacity:.64;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-error{
  opacity:1;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] [data-vr-ia-routing-warning]{
  margin-top:8px;
}
@media (max-width:760px){
  .vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-head{
    display:block;
  }
  .vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-badge{
    display:inline-block;
    margin-top:7px;
  }
}
`

export const V2_SETTINGS_IA_CLIENT = String.raw`(function(){
  'use strict';
  var ROOT='.vr-settings-ia-root';
  var CHAIN='#vr-vision-backend-chain';
  var PANEL='[data-vr-routing-settings-panel]';
  var WARNING_ATTR='data-vr-ia-routing-warning';
  var timer;

  function zh(){
    try{return String(document.documentElement.lang||'').toLowerCase().startsWith('zh');}
    catch(_){return true;}
  }
  function tx(cn,en){return zh()?cn:en;}
  function setText(node,value){if(node&&node.textContent!==value)node.textContent=value;}
  function rootDirty(root){
    if(!root)return false;
    if(root.dataset&&root.dataset.vrDirty==='1')return true;
    return !!(root.querySelector&&root.querySelector('.vr-ia-savebar'));
  }
  function modeOf(chain,panel){
    var mode=chain&&chain.dataset&&chain.dataset.vrRoutingMode;
    if(mode==='auto'||mode==='ordered')return mode;
    var auto=panel&&panel.querySelector('.vr-routing-choice[data-value="auto"][data-active="1"]');
    return auto?'auto':'ordered';
  }
  function backgroundOf(panel){
    if(!panel)return'off';
    var active=panel.querySelector('.vr-routing-choice[data-active="1"][data-value="off"],.vr-routing-choice[data-active="1"][data-value="local-free"],.vr-routing-choice[data-active="1"][data-value="all"]');
    return active&&active.dataset?active.dataset.value||'off':'off';
  }
  function directHint(chain){
    if(!chain||!chain.children)return undefined;
    for(var i=0;i<chain.children.length;i+=1){
      var child=chain.children[i];
      if(child&&child.tagName==='P'&&child.classList&&child.classList.contains('vr-hint'))return child;
    }
    return undefined;
  }
  function warningNode(panel){
    if(!panel)return undefined;
    var node=panel.querySelector('['+WARNING_ATTR+']');
    if(node)return node;
    node=document.createElement('p');
    node.className='vr-routing-error';
    node.setAttribute(WARNING_ATTR,'1');
    panel.appendChild(node);
    return node;
  }
  function setWarning(panel,message){
    var node=warningNode(panel);if(!node)return;
    setText(node,message||'');
    node.style.display=message?'block':'none';
  }
  function rawSummary(node){
    if(!node)return'';
    if(node.dataset&&node.dataset.vrIaRouteSummaryRaw)return node.dataset.vrIaRouteSummaryRaw;
    var value=String(node.textContent||'').replace(/^(?:配置顺序：|执行顺序：|Baseline order: |Execution order: )/,'');
    if(node.dataset)node.dataset.vrIaRouteSummaryRaw=value;
    return value;
  }
  function syncAccessibility(panel){
    if(!panel)return;
    var segments=panel.querySelectorAll('.vr-routing-segment');
    Array.prototype.forEach.call(segments,function(segment){
      segment.setAttribute('role','group');
      var previous=segment.previousElementSibling;
      if(previous&&previous.classList&&previous.classList.contains('vr-routing-label'))segment.setAttribute('aria-label',String(previous.textContent||''));
      var choices=segment.querySelectorAll('.vr-routing-choice');
      var disabled=choices.length>0;
      Array.prototype.forEach.call(choices,function(choice){
        choice.setAttribute('aria-pressed',choice.dataset&&choice.dataset.active==='1'?'true':'false');
        if(choice.disabled!==true)disabled=false;
      });
      if(segment.dataset)segment.dataset.vrIaDisabled=disabled?'1':'0';
    });
  }
  function sync(){
    timer=undefined;
    if(typeof document==='undefined'||!document.querySelector)return;
    var root=document.querySelector(ROOT),chain=root&&root.querySelector(CHAIN),panel=chain&&chain.querySelector(PANEL);
    if(!root||!chain||!panel)return;
    var mode=modeOf(chain,panel),background=backgroundOf(panel),dirty=rootDirty(root);

    var sectionHelp=root.querySelector('.vr-ia-section-head .vr-hint');
    setText(sectionHelp,tx(
      '这里设置负责看图的模型，以及多个模型之间如何选择。聊天模型仍在聊天页选择。',
      'Choose the models that read images and how multiple vision models are selected. The chat model is still chosen in chat.'
    ));

    var hint=directHint(chain);
    setText(hint,mode==='auto'
      ?tx('配置基线顺序；Auto会根据已有实测能力临时调整优先级，没有可靠测评依据时仍保持此顺序。','Baseline order. Auto may temporarily reprioritize models using measured capability evidence; without reliable evidence it keeps this order.')
      :tx('从上到下依次尝试；前一个失败时自动切换到下一个。','Models are tried from top to bottom and fall through automatically on failure.'));

    var summary=root.querySelector('.vr-ia-chain-summary');
    if(summary){
      var raw=rawSummary(summary);
      setText(summary,(mode==='auto'?tx('配置顺序：','Baseline order: '):tx('执行顺序：','Execution order: '))+raw);
    }

    var badge=panel.querySelector('.vr-routing-badge');
    setText(badge,mode==='auto'?tx('Auto 已开启','Auto enabled'):tx('固定顺序','Fixed order'));

    var notes=panel.querySelectorAll('.vr-routing-note');
    var backgroundNote=notes&&notes[0];
    if(background==='off'){
      setText(backgroundNote,tx(
        '后台测评是独立授权，不会因开启Auto自动开启；当前为关闭。未测模型仍按配置顺序执行，你仍可随时手动测评。',
        'Background profiling is separately authorized and never turns on just because Auto is enabled. It is currently off; unmeasured models keep the configured order and manual benchmarks remain available.'
      ));
    }else if(mode!=='auto'){
      setText(backgroundNote,tx(
        '后台测评已单独授权，但只在Auto模式下运行；当前固定顺序不会产生后台测评请求。',
        'Background profiling is separately authorized, but runs only in Auto mode. Fixed order will not create background benchmark requests.'
      ));
    }else if(background==='all'){
      setText(backgroundNote,tx(
        '后台测评已单独授权；Auto空闲时会补测所有已配置模型，云端API可能产生费用。真实识图任务开始时会立即让路。',
        'Background profiling is separately authorized. While Auto is idle it may benchmark all configured models, which can incur cloud API charges; real vision work always takes priority.'
      ));
    }else{
      setText(backgroundNote,tx(
        '后台测评已单独授权；Auto空闲时仅补测本地或免费后端，不会自动消耗收费云API额度。真实识图任务开始时会立即让路。',
        'Background profiling is separately authorized. While Auto is idle only local/free backends are profiled, so paid cloud API credits are not spent automatically; real vision work always takes priority.'
      ));
    }

    setWarning(panel,dirty?tx(
      '页面还有未保存的修改。请先保存或放弃这些修改，再调整模型选择方式，避免出现部分设置已生效、部分仍未保存。',
      'This page still has unsaved changes. Save or discard them before changing model selection so settings cannot be applied only partially.'
    ):'');
    syncAccessibility(panel);
  }
  function schedule(){if(timer!==undefined)return;timer=setTimeout(sync,30);}
  function install(){
    if(typeof document==='undefined')return;
    document.addEventListener('click',function(event){
      var target=event&&event.target&&event.target.closest?event.target.closest(ROOT+' '+CHAIN+' '+PANEL+' .vr-routing-choice'):undefined;
      if(!target)return;
      var root=target.closest(ROOT),panel=target.closest(PANEL);
      if(rootDirty(root)){
        event.preventDefault();
        event.stopPropagation();
        if(typeof event.stopImmediatePropagation==='function')event.stopImmediatePropagation();
        setWarning(panel,tx(
          '请先保存或放弃当前修改，再调整模型选择方式。',
          'Save or discard the current changes before changing model selection.'
        ));
        return;
      }
      schedule();
    },true);
    if(typeof MutationObserver==='function'&&document.documentElement){
      var observer=new MutationObserver(schedule);
      observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-vr-dirty','data-vr-routing-mode','data-active','disabled']});
    }
    schedule();
  }
  try{install();}catch(_){}
})();`

export function injectV2SettingsIaIntegration(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, V2_SETTINGS_IA_MARK)) return html
  const client = V2_SETTINGS_IA_CLIENT.replace(/<\/script/gi, '<\\/script')
  const nodes = `<style>${V2_SETTINGS_IA_STYLE}</style><script ${V2_SETTINGS_IA_MARK}>${client}</script>`
  const closeHead = html.indexOf('</head>')
  return closeHead === -1 ? `${html}${nodes}` : `${html.slice(0, closeHead)}${nodes}${html.slice(closeHead)}`
}

export function installV2SettingsIaIntegration(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectV2SettingsIaIntegration),
      'vision-router: integrate v2 routing controls into settings IA',
    )
  })
}
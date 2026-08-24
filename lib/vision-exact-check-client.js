import { htmlHasScriptMarker } from './html-script-marker.js'

const CLIENT_MARK = 'data-vision-router-exact-check'

export const VISION_EXACT_CHECK_CLIENT = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/capability-runtime';
  var CHAIN_ROOT = '#vr-vision-backend-chain';
  var ROW_SELECTOR = CHAIN_ROOT + ' .vr-chain-row';
  var CONTROL_ATTR = 'data-vr-exact-check-control';
  var MANUAL_MODEL_ID = '__vision_router_manual_model__';
  var scanTimer;
  var activeRuns = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function zh(){
    try { return String(document.documentElement.lang || '').toLowerCase().startsWith('zh'); }
    catch (_) { return true; }
  }
  function text(cn,en){ return zh() ? cn : en; }
  function localPage(){
    try {
      var host=String(window.location.hostname||'').toLowerCase();
      return host==='localhost'||host.endsWith('.localhost')||host==='::1'||host==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(host);
    } catch (_) { return false; }
  }
  function rowSelection(row){
    var selects=row&&row.querySelectorAll?row.querySelectorAll('select'):[];
    return {
      provider: selects[0]&&typeof selects[0].value==='string'?selects[0].value.trim():'',
      model: selects[1]&&typeof selects[1].value==='string'?selects[1].value.trim():''
    };
  }
  function complete(value){ return !!value&&!!value.provider&&!!value.model&&value.model!==MANUAL_MODEL_ID; }
  function selectionKey(value){ return value&&value.provider&&value.model?value.provider+'\\u0000'+value.model:''; }
  function seconds(ms){
    var value=Number(ms); if(!Number.isFinite(value)||value<0)return '';
    return value<1000?Math.round(value)+'ms':(value/1000).toFixed(value<10000?1:0)+'s';
  }
  function short(value,max){
    var clean=String(value||'').replace(/\s+/g,' ').trim();
    return clean.length>max?clean.slice(0,max-1)+'…':clean;
  }
  function transport(value){
    var names={adapter:'Adapter','adapter-bridge':text('Adapter→直连','Adapter→direct'),'http-direct':text('HTTP直连','HTTP direct')};
    return names[String(value||'')]||String(value||'');
  }
  function notifyChanged(){
    try { window.dispatchEvent(new Event('vision-router:capability-updated')); } catch (_) {}
  }
  function statusNode(control){return control&&control.querySelector('[data-vr-exact-check-status]');}
  function buttonNode(control){return control&&control.querySelector('[data-vr-exact-check-button]');}
  function setStatus(control,message,detail){
    var node=statusNode(control);if(!node)return;
    var next=message||'',title=detail||message||'';
    if(node.textContent!==next)node.textContent=next;
    if(node.title!==title)node.title=title;
  }
  function setButton(control,label,disabled){
    var button=buttonNode(control);if(!button)return;
    if(button.textContent!==label)button.textContent=label;
    if(button.disabled!==(disabled===true))button.disabled=disabled===true;
  }
  function abortActive(control){
    if(!activeRuns||!control)return;
    var active=activeRuns.get(control);if(!active)return;
    activeRuns.delete(control);
    try{active.controller&&active.controller.abort&&active.controller.abort();}catch(_){}
    if(active.timer!==undefined)clearTimeout(active.timer);
    if(active.ticker!==undefined)clearInterval(active.ticker);
  }
  function currentRun(control,token,key){
    if(!control||control.isConnected===false||control.dataset.selection!==key)return false;
    if(!activeRuns)return true;
    var active=activeRuns.get(control);return !!active&&active.token===token&&active.key===key;
  }
  function failureMessage(body,status){
    var code=String(body&&body.code||'');
    var map={
      VISION_CHECK_BACKEND_REQUIRED:[text('请先选择供应商和模型','Select a provider and model first')],
      VISION_CHECK_BACKEND_STALE:[text('当前模型暂时无法直接调用，请确认供应商/模型仍可用后重试','This model is not currently callable; verify the provider/model and retry')],
      VISION_CHECK_TIMEOUT:[text('测试超时，已自动结束','Test timed out and was stopped')],
      VISION_CHECK_UNSUPPORTED_IMAGE:[text('实测仅文本 · 图片请求被模型拒绝','Measured text-only · the model rejected image input')],
      VISION_CHECK_INFRASTRUCTURE:[text('识图测试组件暂不可用','Vision check infrastructure is unavailable')],
      CAPABILITY_BENCHMARK_INFRASTRUCTURE:[text('识图测试组件暂不可用','Vision check infrastructure is unavailable')],
      CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED:[text('模型没有正确读出测试图','The model did not correctly inspect the test image')]
    };
    if(map[code])return map[code][0];
    if(status===401||status===403)return text('测试请求被拒绝','Vision check request was rejected');
    if(status===429)return text('请求过于频繁，请稍后重试','Rate limited; try again later');
    return text('测试失败','Vision check failed');
  }
  function reset(control){
    if(!control)return;
    setStatus(control,text('快速自检 · 1次请求 · 只验证当前模型能否识图 · 不写入Auto能力分数','Quick check · 1 request · verifies image input only · does not write Auto capability scores'));
    setButton(control,text('测试识图','Test vision'),false);
  }
  function makeControl(row){
    if(!row||!row.style)return undefined;
    row.style.flexWrap='wrap';
    var control=document.createElement('div');
    control.setAttribute(CONTROL_ATTR,'1');
    Object.assign(control.style,{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'10px',flex:'1 0 100%',width:'100%',minWidth:'0',marginTop:'1px',paddingTop:'2px',order:'2'});
    var status=document.createElement('span');
    status.setAttribute('data-vr-exact-check-status','1');
    Object.assign(status.style,{fontSize:'12px',opacity:'0.68',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:'0',flex:'1 1 auto'});
    var button=document.createElement('button');
    button.type='button'; button.setAttribute('data-vr-exact-check-button','1');
    Object.assign(button.style,{font:'inherit',padding:'4px 12px',border:'1px solid currentColor',borderRadius:'8px',background:'transparent',color:'inherit',cursor:'pointer',flex:'0 0 auto'});
    control.appendChild(status);control.appendChild(button);row.appendChild(control);reset(control);
    button.addEventListener('click',function(event){event.preventDefault();event.stopPropagation();void run(row,control);});
    return control;
  }
  async function run(row,control){
    var selection=rowSelection(row);if(!complete(selection)){setStatus(control,text('请先选择供应商和模型','Select a provider and model first'));return;}
    abortActive(control);
    var key=selectionKey(selection),token=String(Date.now())+'-'+Math.random().toString(36).slice(2);
    control.dataset.selection=key;
    setButton(control,text('测试中…','Testing…'),true);
    var started=Date.now();
    var controller=typeof AbortController==='function'?new AbortController():undefined;
    var timer=controller?setTimeout(function(){controller.abort();},50000):undefined;
    var ticker=setInterval(function(){
      if(!currentRun(control,token,key))return;
      setStatus(control,text('正在测试当前模型 · ','Testing exact model · ')+seconds(Date.now()-started)+text(' · 1张内置测试图 · 不走备用',' · 1 built-in image · no fallback'));
    },1000);
    if(activeRuns)activeRuns.set(control,{token:token,key:key,controller:controller,timer:timer,ticker:ticker});
    setStatus(control,text('正在测试当前模型 · 0ms · 1张内置测试图 · 不走备用','Testing exact model · 0ms · 1 built-in image · no fallback'));
    try{
      var response=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},cache:'no-store',credentials:'same-origin',body:JSON.stringify(selection),signal:controller&&controller.signal});
      var body=await response.json().catch(function(){return {};});
      if(!currentRun(control,token,key))return;
      if(!response.ok||!body||body.ok!==true){
        var raw=String(body&&(body.error||body.code)||('HTTP '+response.status));
        setStatus(control,'✗ '+selection.provider+'/'+selection.model+' · '+failureMessage(body,response.status),raw);notifyChanged();return;
      }
      var via=transport(body.transport),latency=seconds(body.latencyMs),output=short(body.output,72);
      var suffix=(via?' · '+via:'')+(latency?' · '+latency:'')+(output?' · '+output:'');
      setStatus(control,'✓ '+selection.provider+'/'+selection.model+text(' · 图片识别正常',' · image verified')+suffix);notifyChanged();
    }catch(error){
      if(!currentRun(control,token,key))return;
      var message=error&&error.name==='AbortError'?text('测试超时，已自动结束','Test timed out and was stopped'):text('测试失败','Vision check failed');
      setStatus(control,'✗ '+selection.provider+'/'+selection.model+' · '+message,String(error&&error.message||error));
    }finally{
      if(timer!==undefined)clearTimeout(timer);
      if(ticker!==undefined)clearInterval(ticker);
      if(activeRuns){var active=activeRuns.get(control);if(active&&active.token===token)activeRuns.delete(control);}
      if(control&&control.isConnected!==false&&control.dataset.selection===key)setButton(control,text('重新测试','Retest'),false);
    }
  }
  function scan(){
    if(!localPage())return;
    var rows=[];try{rows=Array.prototype.slice.call(document.querySelectorAll(ROW_SELECTOR));}catch(_){rows=[];}
    rows.forEach(function(row){
      var selection=rowSelection(row),control=row.querySelector('['+CONTROL_ATTR+']');
      if(!complete(selection)){if(control){abortActive(control);if(control.remove)control.remove();}return;}
      if(!control)control=makeControl(row);
      var key=selectionKey(selection);
      if(control&&control.dataset.selection!==key){abortActive(control);control.dataset.selection=key;reset(control);}
    });
  }
  function schedule(){if(scanTimer!==undefined)return;scanTimer=setTimeout(function(){scanTimer=undefined;scan();},30);}
  function nodeAddsChain(node){
    if(!node||node.nodeType!==1)return false;
    try{
      if(node.matches&&(node.matches(CHAIN_ROOT)||node.matches(ROW_SELECTOR)))return true;
      if(node.querySelector&&node.querySelector(CHAIN_ROOT+', '+ROW_SELECTOR))return true;
    }catch(_){}
    return false;
  }
  function start(){
    if(!localPage())return;
    document.addEventListener('change',function(event){var row=event&&event.target&&event.target.closest?event.target.closest(ROW_SELECTOR):undefined;if(row)schedule();},true);
    if(typeof MutationObserver==='function'&&document.documentElement){
      var observer=new MutationObserver(function(records){
        for(var i=0;i<records.length;i+=1){
          var added=records[i]&&records[i].addedNodes;
          for(var j=0;added&&j<added.length;j+=1){if(nodeAddsChain(added[j])){schedule();return;}}
        }
      });
      observer.observe(document.documentElement,{childList:true,subtree:true});
    }
    schedule();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();`

export function injectVisionExactCheckClient(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, CLIENT_MARK)) return html
  const script = `<script ${CLIENT_MARK}>${VISION_EXACT_CHECK_CLIENT.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

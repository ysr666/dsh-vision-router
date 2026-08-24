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
  function statusNode(control){return control&&control.querySelector('[data-vr-exact-check-status]');}
  function buttonNode(control){return control&&control.querySelector('[data-vr-exact-check-button]');}
  function setStatus(control,message,detail){var node=statusNode(control);if(node){node.textContent=message||'';node.title=detail||message||'';}}
  function setButton(control,label,disabled){var button=buttonNode(control);if(button){button.textContent=label;button.disabled=disabled===true;}}
  function reset(control){
    if(!control)return;
    setStatus(control,text('快速自检 · 1次请求 · 只验证当前模型能否识图 · 不写入Auto能力数据','Quick check · 1 request · verifies image input only · does not write Auto capability data'));
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
    setButton(control,text('测试中…','Testing…'),true);
    setStatus(control,text('正在发送1张内置测试图；只测试当前模型，不走备用，也不生成Auto评分','Sending one built-in test image to this exact model only; no fallback and no Auto score'));
    var controller=typeof AbortController==='function'?new AbortController():undefined;
    var timer=controller?setTimeout(function(){controller.abort();},68000):undefined;
    try{
      var response=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},cache:'no-store',credentials:'same-origin',body:JSON.stringify(selection),signal:controller&&controller.signal});
      var body=await response.json().catch(function(){return {};});
      if(!response.ok||!body||body.ok!==true){
        var detail=String(body&&(body.error||body.code)||('HTTP '+response.status));
        setStatus(control,'✗ '+selection.provider+'/'+selection.model+' · '+detail,detail);return;
      }
      var via=transport(body.transport),latency=seconds(body.latencyMs),output=short(body.output,72);
      var suffix=(via?' · '+via:'')+(latency?' · '+latency:'')+(output?' · '+output:'');
      setStatus(control,'✓ '+selection.provider+'/'+selection.model+text(' · 图片识别正常',' · image verified')+suffix);
    }catch(error){
      var message=error&&error.name==='AbortError'?text('测试超时','Test timed out'):String(error&&error.message||error);
      setStatus(control,'✗ '+selection.provider+'/'+selection.model+' · '+message,message);
    }finally{
      if(timer!==undefined)clearTimeout(timer);
      setButton(control,text('重新测试','Retest'),false);
    }
  }
  function scan(){
    if(!localPage())return;
    var rows=[];try{rows=Array.prototype.slice.call(document.querySelectorAll(ROW_SELECTOR));}catch(_){rows=[];}
    rows.forEach(function(row){
      var selection=rowSelection(row),control=row.querySelector('['+CONTROL_ATTR+']');
      if(!complete(selection)){if(control&&control.remove)control.remove();return;}
      if(!control)control=makeControl(row);
      if(control&&control.dataset.selection!==selection.provider+'\\u0000'+selection.model){control.dataset.selection=selection.provider+'\\u0000'+selection.model;reset(control);}
    });
  }
  function schedule(){if(scanTimer!==undefined)return;scanTimer=setTimeout(function(){scanTimer=undefined;scan();},30);}
  function start(){
    if(!localPage())return;
    document.addEventListener('change',function(event){var row=event&&event.target&&event.target.closest?event.target.closest(ROW_SELECTOR):undefined;if(row)schedule();},true);
    if(typeof MutationObserver==='function'&&document.documentElement){var observer=new MutationObserver(schedule);observer.observe(document.documentElement,{childList:true,subtree:true});}
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

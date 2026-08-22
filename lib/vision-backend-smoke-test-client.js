const CLIENT_MARK = 'data-vision-router-exact-vision-test'

export const EXACT_VISION_TEST_CLIENT = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/test-vision-backend';
  var CHAIN_ROOT = '#vr-vision-backend-chain';
  var ROW_SELECTOR = CHAIN_ROOT + ' .vr-chain-row';
  var CONTROL_ATTR = 'data-vr-exact-vision-test';
  var V2_MARK = 'script[data-vision-router-capability-benchmark]';
  var V2_CONTROL = '[data-vr-capability-control]';
  var scanTimer;

  function zh(){
    try { return String(document.documentElement.lang || '').toLowerCase().startsWith('zh'); }
    catch (_) { return true; }
  }
  function text(cn,en){ return zh() ? cn : en; }
  function localPage(){
    try {
      var host = String(window.location.hostname || '').toLowerCase();
      if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]') return true;
      return /^127(?:\.\d{1,3}){3}$/.test(host);
    } catch (_) { return false; }
  }
  function v2OwnsCapabilityTesting(){
    try { return !!document.querySelector(V2_MARK + ',' + V2_CONTROL); }
    catch (_) { return false; }
  }
  function rowSelection(row){
    var selects = row && row.querySelectorAll ? row.querySelectorAll('select') : [];
    return {
      provider: selects[0] && typeof selects[0].value === 'string' ? selects[0].value.trim() : '',
      model: selects[1] && typeof selects[1].value === 'string' ? selects[1].value.trim() : ''
    };
  }
  function complete(selection){
    return !!selection && !!selection.provider && !!selection.model && selection.model !== '__vision_router_manual_model__';
  }
  function seconds(ms){
    var value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '';
    return value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(value < 10000 ? 1 : 0) + 's';
  }
  function short(value,max){
    var clean=String(value || '').replace(/\s+/g,' ').trim();
    return clean.length > max ? clean.slice(0,max-1)+'…' : clean;
  }
  function transport(value){
    var names={
      adapter:text('Adapter','Adapter'),
      'adapter-bridge':text('Adapter→直连','Adapter→direct'),
      'preflight-bridge':text('预检直连','Preflight direct'),
      'local-direct':text('本地直连','Local direct'),
      'http-direct':text('HTTP直连','HTTP direct')
    };
    return names[String(value || '')] || String(value || '');
  }
  function failureLabel(kind,detail){
    var labels = {
      auth: ['鉴权失败','Authentication failed'],
      'rate-limit': ['触发限流','Rate limited'],
      timeout: ['请求超时','Timed out'],
      'unsupported-image': ['模型拒绝图片','Model rejected images'],
      network: ['网络失败','Network failed'],
      server: ['服务端异常','Provider server error'],
      quota: ['额度不足','Quota exhausted'],
      region: ['地区不可用','Region unavailable'],
      tos: ['服务条款限制','Service policy restriction'],
      'no-adapter': ['供应商未加载','Provider adapter unavailable'],
      provider: ['模型调用失败','Provider call failed'],
      invalid_request: ['请求格式不兼容','Request format incompatible'],
      invalid_request_permanent: ['请求格式不兼容','Request format incompatible']
    };
    var message = String(detail || '').toLowerCase();
    var normalized = String(kind || '');
    if (/does not support image|unsupported[_ -]?content|image input.*not support|text[- ]only/.test(message)) {
      normalized = 'unsupported-image';
    } else {
      var map = {
        AUTH:'auth', RATE_LIMIT:'rate-limit', TIMEOUT:'timeout', NETWORK:'network',
        INVALID_REQUEST:'invalid_request', SERVER:'server', QUOTA:'quota', REGION:'region',
        TOS:'tos', NO_ADAPTER:'no-adapter', OTHER:'provider'
      };
      normalized = map[String(kind || '').toUpperCase()] || normalized;
    }
    var pair = labels[normalized] || labels.provider;
    return zh() ? pair[0] : pair[1];
  }
  function statusNode(control){ return control && control.querySelector('[data-vr-exact-vision-status]'); }
  function buttonNode(control){ return control && control.querySelector('[data-vr-exact-vision-button]'); }
  function setStatus(control,message,detail){
    var node = statusNode(control);
    if (!node) return;
    node.textContent = message || '';
    node.title = detail || message || '';
  }
  function setButton(control,label,disabled){
    var button = buttonNode(control);
    if (!button) return;
    button.textContent = label;
    button.disabled = disabled === true;
  }
  function makeControl(row){
    var control = document.createElement('div');
    control.setAttribute(CONTROL_ATTR,'1');
    control.style.display='flex';
    control.style.alignItems='center';
    control.style.justifyContent='space-between';
    control.style.gap='10px';
    control.style.flex='1 0 100%';
    control.style.width='100%';
    control.style.minWidth='0';
    control.style.marginTop='1px';
    control.style.paddingTop='2px';

    var status=document.createElement('span');
    status.setAttribute('data-vr-exact-vision-status','1');
    status.style.fontSize='12px';
    status.style.opacity='0.68';
    status.style.overflow='hidden';
    status.style.textOverflow='ellipsis';
    status.style.whiteSpace='nowrap';
    status.style.minWidth='0';
    status.style.flex='1 1 auto';
    status.textContent=text('发送内置测试图 · 只测当前模型 · 不走备用','Built-in test image · exact model only · no fallback');

    var button=document.createElement('button');
    button.type='button';
    button.setAttribute('data-vr-exact-vision-button','1');
    button.textContent=text('测试识图','Test vision');
    button.style.font='inherit';
    button.style.padding='4px 12px';
    button.style.border='1px solid currentColor';
    button.style.borderRadius='8px';
    button.style.background='transparent';
    button.style.color='inherit';
    button.style.cursor='pointer';
    button.style.flex='0 0 auto';

    control.appendChild(status);
    control.appendChild(button);
    row.style.flexWrap='wrap';
    row.appendChild(control);

    button.addEventListener('click',function(event){
      event.preventDefault();
      event.stopPropagation();
      void run(row,control);
    });
    return control;
  }
  async function run(row,control){
    var selection=rowSelection(row);
    if (!complete(selection)) {
      setStatus(control,text('请先选择供应商和模型','Select a provider and model first'));
      return;
    }
    setButton(control,text('测试中…','Testing…'),true);
    setStatus(control,text('正在发送内置测试图；不会调用备用模型','Sending built-in test image; fallback is disabled'));
    var controller=typeof AbortController==='function' ? new AbortController() : undefined;
    var timer=controller ? setTimeout(function(){ controller.abort(); },65000) : undefined;
    try {
      var response=await fetch(ENDPOINT,{
        method:'POST',
        headers:{'content-type':'application/json','accept':'application/json'},
        cache:'no-store',
        credentials:'same-origin',
        body:JSON.stringify(selection),
        signal:controller && controller.signal
      });
      var body=await response.json().catch(function(){ return undefined; });
      if (!body || body.ok !== true) {
        var kind=body && body.failureClass;
        var detail=body && body.error ? String(body.error) : 'HTTP '+response.status;
        var label=failureLabel(kind,detail);
        setStatus(control,'✗ '+selection.provider+'/'+selection.model+' · '+label,detail);
        return;
      }
      var latency=seconds(body.latencyMs);
      var via=transport(body.transport);
      var output=short(body.output,80);
      var diagnostics=[body.transport ? 'transport='+body.transport : '', body.latencyMs != null ? 'latencyMs='+body.latencyMs : '', body.output ? 'output='+body.output : ''].filter(Boolean).join(' · ');
      if (body.verified === true) {
        setStatus(
          control,
          '✓ '+selection.provider+'/'+selection.model+text(' · 图片识别正常',' · image verified')+(via?' · '+via:'')+(latency?' · '+latency:'')+(output?' · '+output:''),
          diagnostics
        );
      } else {
        setStatus(
          control,
          '⚠ '+selection.provider+'/'+selection.model+text(' · 请求成功，但测试图识别不一致',' · request succeeded, image check mismatched')+(via?' · '+via:'')+(latency?' · '+latency:'')+(output?text(' · 返回：',' · output: ')+output:''),
          diagnostics + text('；可能未真正处理图片','; the endpoint may not actually process image input')
        );
      }
    } catch (error) {
      var message=error && error.name==='AbortError'
        ? text('测试超时','Test timed out')
        : (error && error.message ? error.message : String(error));
      setStatus(control,'✗ '+selection.provider+'/'+selection.model+' · '+message,message);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      setButton(control,text('重新测试','Retest'),false);
    }
  }
  function scan(){
    if (!localPage() || v2OwnsCapabilityTesting()) return;
    var rows=[];
    try { rows=Array.prototype.slice.call(document.querySelectorAll(ROW_SELECTOR)); }
    catch (_) { rows=[]; }
    rows.forEach(function(row){
      if (!row || row.querySelector('['+CONTROL_ATTR+']')) return;
      makeControl(row);
    });
  }
  function schedule(){
    if (scanTimer !== undefined) return;
    scanTimer=setTimeout(function(){ scanTimer=undefined; scan(); },0);
  }
  function start(){
    if (!localPage()) return;
    schedule();
    if (typeof MutationObserver==='function') {
      var observer=new MutationObserver(schedule);
      observer.observe(document.documentElement || document.body,{childList:true,subtree:true});
    } else {
      setInterval(scan,1000);
    }
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();`

export function injectExactVisionTestClient(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_MARK)) return html
  const script = `<script ${CLIENT_MARK}>${EXACT_VISION_TEST_CLIENT.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installExactVisionTestClient(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectExactVisionTestClient),
      'vision-router: exact vision test client',
    )
  })
}

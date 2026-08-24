import { htmlHasScriptMarker } from './html-script-marker.js'

const CLIENT_MARK = 'data-vision-router-capability-benchmark'

export const CAPABILITY_BENCHMARK_CLIENT = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/capability-benchmark';
  var CHAIN_ROOT = '#vr-vision-backend-chain';
  var ROW_SELECTOR = CHAIN_ROOT + ' .vr-chain-row';
  var CONTROL_ATTR = 'data-vr-capability-control';
  var MODAL_ATTR = 'data-vr-capability-modal';
  var MANUAL_MODEL_ID = '__vision_router_manual_model__';
  var SCORE_ORDER = ['structured', 'ocr', 'document', 'grounding', 'general'];
  var LABELS = {
    structured: ['结构化', 'Structured'], ocr: ['OCR', 'OCR'], document: ['文档', 'Document'],
    grounding: ['定位', 'Grounding'], general: ['通用', 'General']
  };
  var snapshot, snapshotPromise, scanTimer, pollTimer;
  var snapshotAt = 0;
  var rowControls = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function zh(){
    try { return String(document.documentElement.lang || '').toLowerCase().startsWith('zh'); }
    catch (_) { return true; }
  }
  function text(cn, en){ return zh() ? cn : en; }
  function css(node, styles){ Object.keys(styles || {}).forEach(function(k){ node.style[k] = styles[k]; }); return node; }
  function controllerTimeout(ms){
    if (typeof AbortController !== 'function') return { signal: undefined, clear: function(){} };
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, ms);
    return { signal: controller.signal, clear: function(){ clearTimeout(timer); } };
  }
  function invalidateSnapshot(){ snapshot = undefined; snapshotAt = 0; }
  async function fetchSnapshot(force){
    var now = Date.now();
    if (!force && snapshot && now - snapshotAt < 700) return snapshot;
    if (snapshotPromise) return snapshotPromise;
    snapshotPromise = (async function(){
      var timeout = controllerTimeout(3000);
      try {
        var response = await fetch(ENDPOINT, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal: timeout.signal });
        if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
        var body = await response.json();
        if (!body || body.ok !== true || !Array.isArray(body.candidates) || !Array.isArray(body.jobs)) throw new Error('invalid benchmark snapshot');
        snapshot = body; snapshotAt = Date.now(); return body;
      } finally { timeout.clear(); snapshotPromise = undefined; }
    })();
    return snapshotPromise;
  }

  function rowSelection(row){
    var selects = row && row.querySelectorAll ? row.querySelectorAll('select') : [];
    return {
      provider: selects[0] && typeof selects[0].value === 'string' ? selects[0].value.trim() : '',
      model: selects[1] && typeof selects[1].value === 'string' ? selects[1].value.trim() : ''
    };
  }
  function completeSelection(v){ return !!v && !!v.provider && !!v.model && v.model !== MANUAL_MODEL_ID; }
  function findCandidate(body, row){
    var selected = rowSelection(row);
    if (!completeSelection(selected) || !body || !Array.isArray(body.candidates)) return undefined;
    return body.candidates.find(function(c){ return c && c.provider === selected.provider && c.model === selected.model; });
  }
  function latestJob(body, key){
    if (!body || !Array.isArray(body.jobs) || !key) return undefined;
    var jobs = body.jobs.filter(function(j){ return j && j.key === key; });
    jobs.sort(function(a,b){
      var rank = function(j){ return j.state === 'running' ? 0 : j.state === 'queued' ? 1 : 2; };
      return rank(a) - rank(b) || Number(b.enqueuedAt || 0) - Number(a.enqueuedAt || 0);
    });
    return jobs[0];
  }
  function modeText(mode){
    if (mode === 'full') return text('完整测评', 'Full benchmark');
    return text('快速测评', 'Quick benchmark');
  }
  function seconds(ms){
    var n = Number(ms); if (!Number.isFinite(n) || n < 0) return '';
    return n < 1000 ? Math.round(n) + 'ms' : (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  }
  function ageText(at){
    var n = Number(at); if (!Number.isFinite(n) || n <= 0) return '';
    var days = Math.max(0, Math.floor((Date.now() - n) / 86400000));
    return days === 0 ? text('刚刚', 'just now') : text(days + '天前', days + 'd ago');
  }
  function axisLabel(axis){ var pair = LABELS[axis] || [axis, axis]; return zh() ? pair[0] : pair[1]; }
  function coverageOf(measured){
    if (!measured) return [];
    if (Array.isArray(measured.measuredAxes)) return SCORE_ORDER.filter(function(a){ return measured.measuredAxes.indexOf(a) >= 0; });
    if (Array.isArray(measured.coverage)) return SCORE_ORDER.filter(function(a){ return measured.coverage.indexOf(a) >= 0; });
    var scores = measured.scores || {};
    return SCORE_ORDER.filter(function(a){ return Number.isFinite(Number(scores[a])); });
  }
  function coverageText(measured){
    var items = coverageOf(measured); return items.length ? items.map(axisLabel).join(' / ') : text('无已测能力', 'No measured axes');
  }
  function coverageKindText(measured){
    var axes = coverageOf(measured);
    var full = measured && (measured.coverageKind === 'full' || axes.length === SCORE_ORDER.length);
    if (full) return text('完整能力', 'Full capability profile');
    var basic = axes.indexOf('ocr') >= 0 && axes.indexOf('general') >= 0;
    return basic ? text('基本能力', 'Basic capability profile') : text('部分能力', 'Partial capability profile');
  }
  function axisMeasuredAt(measured, axis){
    var map = measured && measured.measuredAtByAxis;
    var value = Number(map && map[axis]);
    if (Number.isFinite(value) && value > 0) return value;
    value = Number(measured && measured.measuredAt);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  function axisStateText(measured,axis){
    var age=ageText(axisMeasuredAt(measured,axis));
    return age || text('已测','Measured');
  }
  function measuredMetaText(measured){
    if (!measured) return '';
    return coverageKindText(measured) + ' · ' + coverageText(measured);
  }
  function compactMeasuredText(measured){
    return coverageKindText(measured) + ' · ' + coverageText(measured);
  }

  function errorLabel(job){
    var labels = {
      auth: ['鉴权失败','Authentication failed'], 'rate-limit': ['触发限流','Rate limited'], timeout: ['请求超时','Timed out'],
      'unsupported-image': ['模型拒绝图片','Model rejected images'], protocol: ['测评协议暂不支持','Benchmark protocol unsupported'],
      infrastructure: ['测评组件异常','Benchmark infrastructure failed'], network: ['网络失败','Network failed'],
      cancelled: ['已取消','Cancelled'], provider: ['模型调用失败','Provider call failed']
    };
    var pair = labels[job && job.errorClass] || labels.provider; return zh() ? pair[0] : pair[1];
  }
  function statusNode(control){ return control && control.querySelector('[data-vr-capability-status]'); }
  function buttonNode(control){ return control && control.querySelector('[data-vr-capability-primary]'); }
  function setStatus(control, message, detail){ var n = statusNode(control); if (n) { n.textContent = message || ''; n.title = detail || message || ''; } }
  function setPrimary(control, label, action, visible, disabled){
    var b = buttonNode(control); if (!b) return; b.textContent = label || ''; b.dataset.action = action || ''; b.hidden = visible === false; b.disabled = disabled === true;
  }
  function clearControlState(control){
    if (!control) return; delete control.dataset.jobId; delete control.dataset.candidateKey; delete control.dataset.cloudCostWarning;
  }

  function renderControl(row, control, body){
    var candidate = findCandidate(body, row); clearControlState(control);
    control.dataset.selection = rowSelection(row).provider + '\\u0000' + rowSelection(row).model;
    if (!candidate) { setStatus(control, text('当前模型暂不在可执行识图候选池','This model is not in the executable vision pool')); setPrimary(control, text('测评','Benchmark'), 'menu', false); return; }
    control.dataset.candidateKey = candidate.key || '';
    control.dataset.cloudCostWarning = candidate.cloudCostWarning === true ? '1' : '0';
    var job = latestJob(body, candidate.key);
    if (job && job.state === 'running') {
      var current = job.currentIntent ? axisLabel(job.currentIntent) : '';
      var msg = text('正在测评 ','Benchmarking ') + Number(job.completed || 0) + '/' + Number(job.total || 0);
      if (current) msg += ' · ' + current; if (Number(job.elapsedMs) > 0) msg += ' · ' + seconds(job.elapsedMs);
      setStatus(control, msg); control.dataset.jobId = job.id || ''; setPrimary(control, text('停止','Stop'), 'cancel', true); return;
    }
    if (job && job.state === 'queued') {
      setStatus(control, text('排队中 · 第','Queued · #') + Number(job.position || 1) + text('位 · ',' · ') + modeText(job.mode));
      control.dataset.jobId = job.id || ''; setPrimary(control, text('取消','Cancel'), 'cancel', true); return;
    }
    if (job && job.state === 'failed') {
      var failed = errorLabel(job);
      setStatus(control, candidate.measured ? compactMeasuredText(candidate.measured) + text(' · 最近：',' · Latest: ') + failed : failed, job.error || failed);
    } else if (candidate.measured) {
      setStatus(control, compactMeasuredText(candidate.measured), measuredMetaText(candidate.measured));
    } else if (candidate.imageCapability === 'text-only') setStatus(control, text('仅文本模型','Text-only model'));
    else if (candidate.benchmarkable !== true) setStatus(control, text('暂不可测评','Benchmark unavailable'));
    else setStatus(control, text('尚未测评 · Auto暂时保持设置顺序','Not benchmarked · Auto keeps configured order for now'));
    setPrimary(control, text('测评','Benchmark'), 'menu', candidate.benchmarkable === true);
  }

  function removeControl(row){
    if (!row) return; var control = rowControls && rowControls.get(row);
    if (!control && row.querySelector) control = row.querySelector('[' + CONTROL_ATTR + ']');
    if (control && control.remove) control.remove(); if (rowControls) rowControls.delete(row);
    if (row.dataset && Object.prototype.hasOwnProperty.call(row.dataset,'vrCapabilityOldFlexWrap')) { row.style.flexWrap = row.dataset.vrCapabilityOldFlexWrap; delete row.dataset.vrCapabilityOldFlexWrap; }
  }
  function makeControl(row){
    if (!row || !row.style) return undefined;
    if (row.dataset && !Object.prototype.hasOwnProperty.call(row.dataset,'vrCapabilityOldFlexWrap')) row.dataset.vrCapabilityOldFlexWrap = row.style.flexWrap || '';
    row.style.flexWrap = 'wrap';
    var control = css(document.createElement('div'), { display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px', flex:'1 0 100%', width:'100%', minWidth:'0', marginTop:'1px', paddingTop:'2px' });
    control.setAttribute(CONTROL_ATTR,'1');
    var status = css(document.createElement('span'), { fontSize:'12px', opacity:'0.72', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:'0', flex:'1 1 auto' });
    status.setAttribute('data-vr-capability-status','1');
    var button = css(document.createElement('button'), { font:'inherit', padding:'4px 12px', border:'1px solid currentColor', borderRadius:'8px', background:'transparent', color:'inherit', cursor:'pointer', flex:'0 0 auto' });
    button.type='button'; button.setAttribute('data-vr-capability-primary','1');
    control.appendChild(status); control.appendChild(button); row.appendChild(control); if (rowControls) rowControls.set(row,control);
    button.addEventListener('click',function(event){ event.preventDefault(); event.stopPropagation(); if (button.dataset.action === 'cancel') return void cancel(control); void openBenchmarkModal(row,control); });
    return control;
  }
  function controlFor(row){
    var control = rowControls && rowControls.get(row); if (control && control.isConnected !== false) return control;
    control = row && row.querySelector ? row.querySelector('[' + CONTROL_ATTR + ']') : undefined; if (control && rowControls) rowControls.set(row,control); return control;
  }
  function closeModal(){ var current = document.querySelector('[' + MODAL_ATTR + ']'); if (current && current.remove) current.remove(); }
  function modalButton(label, description, action, tone){
    var button = css(document.createElement('button'), { display:'block', width:'100%', textAlign:'left', padding:'12px 14px', border:'1px solid rgba(127,127,127,.22)', borderRadius:'10px', background:tone === 'primary' ? 'rgba(127,127,127,.10)' : 'transparent', color:'inherit', cursor:'pointer', font:'inherit' });
    button.type='button'; button.dataset.modalAction=action;
    var title=css(document.createElement('div'),{fontWeight:'600'}); title.textContent=label; button.appendChild(title);
    if (description) { var desc=css(document.createElement('div'),{fontSize:'12px',opacity:'0.66',marginTop:'3px'}); desc.textContent=description; button.appendChild(desc); }
    return button;
  }

  function appendMeasuredDetails(container, measured){
    if (!measured) return;
    var card=css(document.createElement('div'),{marginTop:'16px',padding:'12px 14px',border:'1px solid rgba(127,127,127,.22)',borderRadius:'10px'});
    var title=css(document.createElement('div'),{fontWeight:'650'}); title.textContent=coverageKindText(measured)+' · '+coverageText(measured); card.appendChild(title);
    var meta=css(document.createElement('div'),{fontSize:'12px',opacity:'0.66',marginTop:'4px'}); meta.textContent=text('测评时间只作记录；测评耗时是当次Benchmark观测，不代表当前速度，也不用于Speed/综合排序。','Measurement time is informational. Benchmark latency is a historical observation, not current speed, and is not used by Speed/Balanced routing.'); card.appendChild(meta);
    var grid=css(document.createElement('div'),{display:'grid',gridTemplateColumns:'minmax(72px,1fr) auto auto minmax(104px,1.2fr)',columnGap:'10px',rowGap:'7px',marginTop:'12px',fontSize:'12px',alignItems:'center'});
    var headers=[text('能力','Capability'),text('分数','Score'),text('测评耗时','Benchmark latency'),text('测评时间','Measured')];
    headers.forEach(function(label){var h=document.createElement('div');h.textContent=label;h.style.opacity='0.56';h.style.fontSize='11px';grid.appendChild(h);});
    var scores=measured.scores||{}, latencies=measured.benchmarkMedianLatencyMs||{};
    SCORE_ORDER.forEach(function(axis){
      var score=Number(scores[axis]), latency=Number(latencies[axis]), covered=Number.isFinite(score);
      var a=document.createElement('div'); a.textContent=axisLabel(axis); a.style.opacity=covered?'1':'0.56';
      var b=document.createElement('div'); b.textContent=covered?String(Math.round(score*100)):text('— 未测','— not tested'); b.style.fontVariantNumeric='tabular-nums';
      var c=document.createElement('div'); c.textContent=covered&&Number.isFinite(latency)?seconds(latency):'—'; c.style.fontVariantNumeric='tabular-nums'; c.style.opacity='0.72';
      var d=document.createElement('div'); d.textContent=covered?axisStateText(measured,axis):'—'; d.style.opacity=covered?'0.78':'0.56'; d.style.whiteSpace='nowrap';
      grid.appendChild(a); grid.appendChild(b); grid.appendChild(c); grid.appendChild(d);
    });
    card.appendChild(grid); container.appendChild(card);
  }
  function diagnosticSummary(diag){ var score=Math.round(Number(diag&&diag.score||0)*100), iou=Number(diag&&diag.iou||0); return text('定位 '+score+' · IoU '+iou.toFixed(3),'Grounding '+score+' · IoU '+iou.toFixed(3)); }
  function appendDiagnosticDetails(container,diag){
    if(!diag)return; var card=css(document.createElement('div'),{marginTop:'10px',padding:'12px 14px',border:'1px solid rgba(127,127,127,.22)',borderRadius:'10px'});
    var title=css(document.createElement('div'),{fontWeight:'600'}); title.textContent=text('定位能力','Grounding'); card.appendChild(title);
    var summary=css(document.createElement('div'),{marginTop:'5px'}); summary.textContent=diagnosticSummary(diag); card.appendChild(summary);
    var details=css(document.createElement('details'),{marginTop:'10px'}), s=document.createElement('summary'); s.textContent=text('开发者信息','Developer details'); s.style.cursor='pointer'; details.appendChild(s);
    var pre=css(document.createElement('pre'),{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:'11px',opacity:'0.72',margin:'8px 0 0'}), lines=[];
    lines.push('parse='+String(diag.parseSource||'none')+'  shape='+String(diag.responseShape||'none'));
    lines.push('space='+String(diag.coordinateSpace||'none')+'  formatValid='+String(diag.formatValid===true));
    if(Array.isArray(diag.parsed))lines.push('parsed='+JSON.stringify(diag.parsed)); if(diag.normalized)lines.push('normalized='+JSON.stringify(diag.normalized));
    if(Array.isArray(diag.candidateSpaces)&&diag.candidateSpaces.length)lines.push('candidateSpaces='+diag.candidateSpaces.join(',')); pre.textContent=lines.join('\\n'); details.appendChild(pre); card.appendChild(details); container.appendChild(card);
  }
  function costNote(candidate){
    if(!candidate||candidate.cloudCostWarning!==true)return '';
    return text('云端测评会发送生成的测试图片，快速约3次、完整约6次，可能产生API费用。','Cloud benchmarks send generated test images: about 3 requests for quick and 6 for full, which may incur API charges.');
  }

  async function openBenchmarkModal(row,control){
    var body; try{body=await fetchSnapshot(true);}catch(error){setStatus(control,text('能力测评服务暂不可用','Capability benchmark unavailable')+': '+String(error&&error.message||error));return;}
    var candidate=findCandidate(body,row); if(!candidate)return; closeModal();
    var overlay=css(document.createElement('div'),{position:'fixed',inset:'0',zIndex:'2147483646',background:'rgba(0,0,0,.28)',display:'flex',alignItems:'center',justifyContent:'center',padding:'20px'}); overlay.setAttribute(MODAL_ATTR,'1');
    var panel=css(document.createElement('div'),{width:'min(520px, calc(100vw - 32px))',maxHeight:'min(700px, calc(100vh - 40px))',overflow:'auto',background:'Canvas',color:'CanvasText',border:'1px solid rgba(127,127,127,.25)',borderRadius:'16px',boxShadow:'0 18px 60px rgba(0,0,0,.22)',padding:'18px'});
    var head=css(document.createElement('div'),{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:'12px'}), wrap=document.createElement('div');
    var heading=css(document.createElement('div'),{fontSize:'17px',fontWeight:'700'}); heading.textContent=text('模型测评','Model benchmark');
    var model=css(document.createElement('div'),{fontSize:'12px',opacity:'0.68',marginTop:'3px'}); model.textContent=candidate.provider+' / '+candidate.model;
    var close=css(document.createElement('button'),{border:'0',background:'transparent',color:'inherit',fontSize:'24px',cursor:'pointer',lineHeight:'1'}); close.type='button'; close.textContent='×'; close.addEventListener('click',closeModal);
    wrap.appendChild(heading);wrap.appendChild(model);head.appendChild(wrap);head.appendChild(close);panel.appendChild(head);
    if(candidate.measured)appendMeasuredDetails(panel,candidate.measured); else { var empty=css(document.createElement('div'),{marginTop:'16px',opacity:'0.72'}); empty.textContent=candidate.imageCapability==='text-only'?text('DSH当前将此模型标记为仅文本。','DSH currently marks this model as text-only.'):text('尚未测评。Auto不会根据模型名称推断能力，暂时保持你的设置顺序。','Not benchmarked. Auto will not infer capability from the model name and keeps your configured order for now.');panel.appendChild(empty); }
    var list=css(document.createElement('div'),{display:'grid',gap:'8px',marginTop:'16px'});
    if(candidate.imageCapability==='text-only'&&!candidate.measured){
      list.appendChild(modalButton(text('强制验证图片能力','Force-verify image support'),text('约3次请求；仅在你确认该模型实际可能支持图片时使用。','About 3 requests; use only if you believe the model may actually accept images.'),'force','primary'));
    }else{
      list.appendChild(modalButton(candidate.measured?text('快速重测','Quick retest'):text('快速测评','Quick benchmark'),text('约3次请求 · 覆盖 OCR 和通用 · 快速建立Auto依据','About 3 requests · covers OCR and general · quickly establishes Auto evidence'),'quick','primary'));
      list.appendChild(modalButton(candidate.measured?text('完整重测','Full retest'):text('完整测评','Full benchmark'),text('约6次请求 · 覆盖结构化、OCR、文档、定位、通用','About 6 requests · covers structured, OCR, document, grounding and general'),'full'));
    }
    panel.appendChild(list);
    var noteText=costNote(candidate); if(noteText){var note=css(document.createElement('div'),{fontSize:'11px',opacity:'0.58',marginTop:'12px'});note.textContent=noteText;panel.appendChild(note);}
    var diag=candidate.measured&&candidate.measured.groundingDiagnostic;
    if(diag)appendDiagnosticDetails(panel,diag);
    overlay.appendChild(panel);document.body.appendChild(overlay);
    overlay.addEventListener('click',function(event){if(event.target===overlay)closeModal();});
    panel.addEventListener('click',function(event){var target=event&&event.target, button=target&&target.closest?target.closest('[data-modal-action]'):undefined;if(!button||!panel.contains(button))return;var action=button.dataset.modalAction;closeModal();if(action==='force')return void enqueue(row,control,'quick',true);if(action==='full')return void enqueue(row,control,'full',false);return void enqueue(row,control,'quick',false);});
  }

  async function enqueue(row,control,mode,force){
    var body=await fetchSnapshot(true), candidate=findCandidate(body,row);if(!candidate||!candidate.key)return;setStatus(control,text('正在加入测评队列…','Adding to benchmark queue…'));var timeout=controllerTimeout(8000);
    try{var response=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},cache:'no-store',body:JSON.stringify({key:candidate.key,mode:mode,force:force===true}),signal:timeout.signal});var result=await response.json().catch(function(){return{};});if(!response.ok||!result||result.ok!==true)throw new Error(String(result&&(result.error||result.code)||('HTTP '+response.status)));invalidateSnapshot();await refreshAll(true);}catch(error){setStatus(control,text('加入队列失败：','Queue failed: ')+String(error&&error.message||error));}finally{timeout.clear();}
  }
  async function cancel(control){
    var jobId=control&&control.dataset.jobId;if(!jobId)return;var timeout=controllerTimeout(8000);
    try{var response=await fetch(ENDPOINT,{method:'DELETE',headers:{'content-type':'application/json',accept:'application/json'},cache:'no-store',body:JSON.stringify({jobId:jobId}),signal:timeout.signal});var result=await response.json().catch(function(){return{};});if(!response.ok||!result||result.ok!==true)throw new Error(String(result&&(result.error||result.code)||('HTTP '+response.status)));invalidateSnapshot();await refreshAll(true);}catch(error){setStatus(control,text('取消失败：','Cancel failed: ')+String(error&&error.message||error));}finally{timeout.clear();}
  }
  function hasActiveJobs(body){return !!(body&&Array.isArray(body.jobs)&&body.jobs.some(function(job){return job&&(job.state==='queued'||job.state==='running');}));}
  function schedulePoll(body){if(pollTimer!==undefined)clearTimeout(pollTimer);pollTimer=undefined;if(!hasActiveJobs(body))return;pollTimer=setTimeout(function(){pollTimer=undefined;invalidateSnapshot();void refreshAll(true);},1000);}
  async function refreshAll(force){
    if(typeof document==='undefined'||typeof document.querySelectorAll!=='function')return;var rows=document.querySelectorAll(ROW_SELECTOR);
    Array.prototype.forEach.call(rows,function(row){if(!completeSelection(rowSelection(row)))removeControl(row);else if(!controlFor(row))makeControl(row);});
    var body;try{body=await fetchSnapshot(force===true);}catch(error){Array.prototype.forEach.call(rows,function(row){var control=controlFor(row);if(control)setStatus(control,text('能力测评服务暂不可用','Capability benchmark unavailable')+': '+String(error&&error.message||error));});return;}
    Array.prototype.forEach.call(rows,function(row){if(!completeSelection(rowSelection(row)))return;var control=controlFor(row)||makeControl(row);if(control)renderControl(row,control,body);});schedulePoll(body);
  }
  function scheduleScan(force){if(scanTimer!==undefined)return;scanTimer=setTimeout(function(){scanTimer=undefined;void refreshAll(force===true);},50);}
  function nodeTouchesChain(node){if(!node||node.nodeType!==1)return false;try{if(node.matches&&(node.matches(CHAIN_ROOT)||node.matches(ROW_SELECTOR)))return true;if(node.querySelector&&node.querySelector(CHAIN_ROOT+', '+ROW_SELECTOR))return true;if(node.closest&&node.closest(CHAIN_ROOT))return true;}catch(_){}return false;}
  function install(){
    if(typeof document==='undefined')return;
    document.addEventListener('change',function(event){var target=event&&event.target,row=target&&target.closest?target.closest(ROW_SELECTOR):undefined;if(!row)return;invalidateSnapshot();scheduleScan(true);},true);
    document.addEventListener('keydown',function(event){if(event&&event.key==='Escape')closeModal();});
    if(typeof MutationObserver==='function'&&document.documentElement){var observer=new MutationObserver(function(records){for(var i=0;i<records.length;i+=1){var added=records[i]&&records[i].addedNodes;for(var j=0;added&&j<added.length;j+=1){if(nodeTouchesChain(added[j])){scheduleScan(false);return;}}}});observer.observe(document.documentElement,{childList:true,subtree:true});}
    scheduleScan(true);
  }
  try{install();}catch(_){}
})();`

export function injectCapabilityBenchmarkClient(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, CLIENT_MARK)) return html
  const script = `<script ${CLIENT_MARK}>${CAPABILITY_BENCHMARK_CLIENT.replace(/<\/script/gi, '<\\/script')}</script>`
  const head = html.indexOf('<head>')
  return head === -1 ? `${script}${html}` : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
}

export function installCapabilityBenchmarkClient(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectCapabilityBenchmarkClient),
      'vision-router: capability benchmark compact client controls',
    )
  })
}

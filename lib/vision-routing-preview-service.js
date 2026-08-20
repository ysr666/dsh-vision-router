import { collectCapabilityShadowCandidates } from './vision-capability-shadow.js'
import {
  AUTO_MEASURED_MAX_AGE_MS,
  AUTO_REORDER_MIN_ADVANTAGE,
  BENCHMARK_AXES,
  benchmarkAxisForVisionIntent,
  suggestVisionOrder,
} from './vision-capability-router.js'
import { DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS } from './vision-capability-probe.js'
import { resolveVisionRoutingProduct } from './vision-routing-product.js'

export const VISION_ROUTING_PREVIEW_PATH = '/_dsh/vision-router/routing-preview'
export const VISION_ROUTING_PREVIEW_INTENTS = Object.freeze([
  'structured',
  'ocr',
  'document',
  'grounding',
  'general',
])

const ROUTING_DIAGNOSTICS_MARK = 'data-vision-router-routing-diagnostics'

function activeSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function measuredMap(candidates) {
  return Object.fromEntries(
    candidates
      .filter((candidate) => candidate?.measured)
      .map((candidate) => [candidate.key, {
        scores: candidate.measured,
        measuredAt: candidate.measuredAt,
        medianLatencyMs: candidate.medianLatencyMs,
      }]),
  )
}

function safeNumber(value, digits = 4) {
  const number = Number(value)
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null
}

function safeDecision(decision) {
  if (!decision || typeof decision !== 'object') return undefined
  if (decision.type === 'reorder') {
    return {
      type: 'reorder',
      reason: decision.reason,
      before: decision.before,
      promoted: decision.promoted,
      axis: decision.axis,
      leftScore: safeNumber(decision.leftScore),
      rightScore: safeNumber(decision.rightScore),
      delta: safeNumber(decision.delta),
    }
  }
  if (decision.type === 'availability') {
    return {
      type: 'availability',
      reason: decision.reason,
      backend: decision.backend,
    }
  }
  return undefined
}

function previewReason({ changed, preference, decisions, incomparableBackends }) {
  if (changed && decisions.some((decision) => decision?.type === 'reorder')) return 'measured-advantage'
  if (changed && preference === 'local') return 'local-preference'
  if (incomparableBackends.length > 0) return 'insufficient-comparable-evidence'
  return 'configured-order'
}

function policyFormula(preference) {
  if (preference === 'quality') return 'capability'
  if (preference === 'speed') return '0.55*capability + 0.45*speed'
  if (preference === 'local') return 'local-first, then capability within locality groups'
  return '0.80*capability + 0.20*speed'
}

function recordFreshness(record, now) {
  const measuredAt = Number(record?.measuredAt)
  if (!Number.isFinite(measuredAt) || measuredAt <= 0) return 'none'
  const age = Math.max(0, Number(now) - measuredAt)
  if (age <= AUTO_MEASURED_MAX_AGE_MS) return 'fresh'
  if (age <= DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS) return 'stale'
  return 'expired'
}

async function rawProfileRecords(candidates, store) {
  const out = new Map()
  if (!store || typeof store.get !== 'function') return out
  for (const candidate of candidates) {
    const fingerprint = typeof candidate?.endpointFingerprint === 'string'
      ? candidate.endpointFingerprint
      : ''
    if (fingerprint === '') continue
    try {
      const record = await store.get(fingerprint)
      if (record && typeof record === 'object') out.set(candidate.key, record)
    } catch {
      // Diagnostics never turn a profile-store read failure into routing evidence.
    }
  }
  return out
}

function candidateEvidenceState(candidate, record, axis, now) {
  if (candidate?.benchmarkable !== true) return 'unbenchmarkable'
  if (!record) return 'unmeasured'
  const freshness = recordFreshness(record, now)
  if (freshness === 'stale') return 'stale'
  if (freshness === 'expired') return 'expired'
  const score = Number(record?.scores?.[axis])
  if (!Number.isFinite(score)) return 'axis-unmeasured'
  return 'fresh-measured'
}

function diagnosticCandidate(entry, currentOrder, rawRecords, axis, now) {
  const record = rawRecords.get(entry.key)
  const measuredAt = Number(record?.measuredAt)
  const coverage = BENCHMARK_AXES.filter((name) => Number.isFinite(Number(record?.scores?.[name])))
  const previewRank = Number.isInteger(entry.rank) ? entry.rank : undefined
  const configuredIndex = currentOrder.indexOf(entry.key)
  const measuredLatencyMs = Number(record?.medianLatencyMs?.[axis])
  return {
    backend: entry.key,
    configuredRank: configuredIndex >= 0 ? configuredIndex + 1 : null,
    previewRank: previewRank ?? null,
    routeRole: entry.routeRole ?? 'user',
    local: entry.profile?.traits?.local === true,
    benchmarkable: entry.benchmarkable === true,
    endpointFingerprint:
      typeof entry.endpointFingerprint === 'string' && /^ep2_[0-9a-f]{32}$/.test(entry.endpointFingerprint)
        ? entry.endpointFingerprint
        : null,
    evidenceState: candidateEvidenceState(entry, record, axis, now),
    coverage,
    measuredAt: Number.isFinite(measuredAt) && measuredAt > 0 ? measuredAt : null,
    ageMs: Number.isFinite(measuredAt) && measuredAt > 0 ? Math.max(0, Number(now) - measuredAt) : null,
    freshness: recordFreshness(record, now),
    measuredAxisScore: safeNumber(record?.scores?.[axis]),
    measuredLatencyMs: Number.isFinite(measuredLatencyMs) && measuredLatencyMs >= 0 ? measuredLatencyMs : null,
    effectiveCapability: safeNumber(entry.components?.capability),
    speedScore: safeNumber(entry.components?.speed),
    weightedScore: safeNumber(entry.score),
    autoComparable: entry.comparable === true,
  }
}

function configuredPairChecks(ranked, currentOrder, preference, threshold) {
  const byKey = new Map(ranked.map((entry) => [entry.key, entry]))
  const checks = []
  for (let index = 1; index < currentOrder.length; index += 1) {
    const leftKey = currentOrder[index - 1]
    const rightKey = currentOrder[index]
    const left = byKey.get(leftKey)
    const right = byKey.get(rightKey)
    if (!left || !right) continue
    const leftScore = Number(left.score)
    const rightScore = Number(right.score)
    const leftComparable = left.comparable === true && Number.isFinite(leftScore)
    const rightComparable = right.comparable === true && Number.isFinite(rightScore)
    const leftLocal = left.profile?.traits?.local === true
    const rightLocal = right.profile?.traits?.local === true

    if (right.routeRole === 'fallback-only') {
      checks.push({
        left: leftKey,
        right: rightKey,
        outcome: 'fallback-only-boundary',
        threshold,
      })
      continue
    }
    if (preference === 'local' && !leftLocal && rightLocal) {
      checks.push({
        left: leftKey,
        right: rightKey,
        outcome: 'local-policy-promotes-right',
        threshold,
      })
      continue
    }
    if (!leftComparable || !rightComparable) {
      checks.push({
        left: leftKey,
        right: rightKey,
        outcome: 'incomparable',
        threshold,
        missing: [
          ...(!leftComparable ? [leftKey] : []),
          ...(!rightComparable ? [rightKey] : []),
        ],
        leftScore: leftComparable ? safeNumber(leftScore) : null,
        rightScore: rightComparable ? safeNumber(rightScore) : null,
      })
      continue
    }
    const delta = rightScore - leftScore
    checks.push({
      left: leftKey,
      right: rightKey,
      outcome: delta >= threshold ? 'measured-promotable' : 'below-threshold',
      threshold,
      leftScore: safeNumber(leftScore),
      rightScore: safeNumber(rightScore),
      delta: safeNumber(delta),
    })
  }
  return checks
}

export async function buildVisionRoutingPreview({
  ctx,
  config,
  core,
  store,
  now = Date.now(),
} = {}) {
  const current = activeSettings(ctx, config)
  const product = resolveVisionRoutingProduct(current)
  const candidates = await collectCapabilityShadowCandidates(ctx, current, core, store)
  const currentOrder = candidates.map((candidate) => candidate.key)
  const measured = measuredMap(candidates)
  const freshMeasuredBackends = Object.keys(measured)
  const rawRecords = await rawProfileRecords(candidates, store)

  const previews = VISION_ROUTING_PREVIEW_INTENTS.map((intent) => {
    const suggestion = suggestVisionOrder({
      intent,
      strategy: product.strategy,
      candidates,
      measured,
      health: {},
      now,
    })
    const order = suggestion.ranked.map((candidate) => candidate.key)
    const decisions = suggestion.decisions.map(safeDecision).filter(Boolean)
    const incomparableBackends = Array.isArray(suggestion.incomparableBackends)
      ? suggestion.incomparableBackends.slice()
      : []
    const changed = order.join('\u0000') !== currentOrder.join('\u0000')
    const axis = benchmarkAxisForVisionIntent(intent)
    const rankedDiagnostics = suggestion.ranked.map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }))
    return {
      intent,
      axis,
      first: order[0],
      order,
      changed,
      reason: previewReason({
        changed,
        preference: product.preference,
        decisions,
        incomparableBackends,
      }),
      decisions,
      incomparableBackends,
      diagnostics: {
        candidates: rankedDiagnostics.map((entry) =>
          diagnosticCandidate(entry, currentOrder, rawRecords, axis, now)),
        configuredPairChecks: configuredPairChecks(
          rankedDiagnostics,
          currentOrder,
          product.preference,
          AUTO_REORDER_MIN_ADVANTAGE,
        ),
      },
    }
  })

  return {
    ok: true,
    diagnosticVersion: 1,
    generatedAt: Number(now),
    routingMode: product.mode,
    routingPreference: product.preference,
    strategy: product.strategy,
    policy: {
      preference: product.preference,
      formula: policyFormula(product.preference),
      minAdvantage: AUTO_REORDER_MIN_ADVANTAGE,
      freshMaxAgeMs: AUTO_MEASURED_MAX_AGE_MS,
      retainedProfileMaxAgeMs: DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS,
      configuredOrderIsBaseline: true,
    },
    currentOrder,
    freshMeasuredBackends,
    previews,
    autoPreviewOnly: true,
    executionActive: false,
    healthIncluded: false,
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export const VISION_ROUTING_DIAGNOSTICS_PRELUDE = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/routing-preview';
  var PANEL = '[data-vr-routing-settings-panel]';
  var ROOT = '#vr-vision-backend-chain';
  var DIAG = 'data-vr-routing-diagnostics';
  var STYLE = 'data-vr-routing-diagnostics-style';
  var CONTROL = '[data-vr-capability-control]';
  var state = { body: undefined, loading: false, error: '', node: undefined, timer: undefined, benchmarkSignature: '' };

  function zh(){
    try { return String(document.documentElement.lang || '').toLowerCase().startsWith('zh'); }
    catch (_) { return true; }
  }
  function text(cn,en){ return zh() ? cn : en; }
  function ms(value){
    var n = Number(value); if (!Number.isFinite(n) || n < 0) return '—';
    return n < 1000 ? Math.round(n) + 'ms' : (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  }
  function pct(value){ var n=Number(value); return Number.isFinite(n) ? Math.round(n*100) : '—'; }
  function score(value){ var n=Number(value); return Number.isFinite(n) ? n.toFixed(3) : '—'; }
  function age(value){
    var n=Number(value); if(!Number.isFinite(n)||n<0)return '—';
    var d=Math.floor(n/86400000); if(d>0)return d+text('天','d');
    var h=Math.floor(n/3600000); if(h>0)return h+text('小时','h');
    var m=Math.floor(n/60000); return m>0?m+text('分钟','m'):text('刚刚','just now');
  }
  function intentLabel(value){
    if(value==='structured')return text('结构化','Structured');
    if(value==='ocr')return 'OCR';
    if(value==='document')return text('文档','Document');
    if(value==='grounding')return text('定位','Grounding');
    return text('通用','General');
  }
  function reasonLabel(value){
    if(value==='measured-advantage')return text('实测领先','Measured lead');
    if(value==='local-preference')return text('本地优先','Local first');
    if(value==='insufficient-comparable-evidence')return text('证据不足，保持顺序','Insufficient evidence');
    return text('保持设置顺序','Keep configured order');
  }
  function evidenceLabel(value){
    if(value==='fresh-measured')return text('新鲜实测','Fresh measured');
    if(value==='stale')return text('已陈旧，不参与Auto','Stale; excluded from Auto');
    if(value==='axis-unmeasured')return text('本次测评未覆盖该轴','Axis not measured');
    if(value==='unbenchmarkable')return text('当前后端不可测','Benchmark unavailable');
    if(value==='expired')return text('已过期','Expired');
    return text('无当前测评','No current measurement');
  }
  function outcomeLabel(check){
    if(!check)return '';
    if(check.outcome==='local-policy-promotes-right')return text('本地偏好允许右侧本地后端前移','Local policy promotes the right local backend');
    if(check.outcome==='fallback-only-boundary')return text('右侧是fallback-only，不允许Benchmark前移','Right backend is fallback-only');
    if(check.outcome==='incomparable')return text('至少一侧没有该轴的新鲜可比证据，禁止跨越','At least one side lacks fresh comparable evidence');
    if(check.outcome==='measured-promotable')return text('差值达到阈值，可前移','Measured advantage reaches threshold');
    return text('差值不足阈值，保持顺序','Advantage is below threshold');
  }
  function installStyle(){
    if(document.querySelector('['+STYLE+']'))return;
    var s=document.createElement('style');s.setAttribute(STYLE,'1');
    s.textContent=
      '.vr-routing-diag{margin:0 0 12px;padding:12px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}'+
      '.vr-routing-diag-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}'+
      '.vr-routing-diag-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary)}'+
      '.vr-routing-diag-actions{display:flex;gap:6px;align-items:center}'+
      '.vr-routing-diag-btn{font:inherit;font-size:11px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:inherit;cursor:pointer}'+
      '.vr-routing-diag-note{margin:7px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}'+
      '.vr-routing-diag details{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}'+
      '.vr-routing-diag summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary)}'+
      '.vr-routing-diag-grid{display:grid;grid-template-columns:auto auto minmax(140px,1.6fr) auto auto auto;gap:5px 9px;margin-top:9px;font-size:11px;align-items:center}'+
      '.vr-routing-diag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'+
      '.vr-routing-diag-muted{color:var(--dsw-alias-label-tertiary)}'+
      '.vr-routing-diag-check{margin-top:5px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}'+
      '.vr-routing-diag-error{margin-top:7px;font-size:11px;color:var(--dsw-alias-label-error)}';
    document.head.appendChild(s);
  }
  function button(label,fn){var b=document.createElement('button');b.type='button';b.className='vr-routing-diag-btn';b.textContent=label;b.addEventListener('click',fn);return b;}
  function copyJson(){
    if(!state.body)return;
    var value=JSON.stringify(state.body,null,2);
    if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){
      void navigator.clipboard.writeText(value).then(function(){state.error=text('诊断JSON已复制','Diagnostic JSON copied');render();}).catch(function(){state.error=text('复制失败','Copy failed');render();});
    }
  }
  function candidateRow(grid,c){
    var values=[c.configuredRank==null?'—':'#'+c.configuredRank,c.previewRank==null?'—':'#'+c.previewRank,c.backend,evidenceLabel(c.evidenceState),pct(c.measuredAxisScore),c.measuredLatencyMs==null?'—':ms(c.measuredLatencyMs)];
    values.forEach(function(value,index){var n=document.createElement('div');n.textContent=String(value);if(index===2){n.className='vr-routing-diag-mono';n.title=c.backend||'';}if(index===3)n.title=[c.coverage&&c.coverage.join('/'),c.ageMs==null?'':age(c.ageMs),c.endpointFingerprint||''].filter(Boolean).join(' · ');grid.appendChild(n);});
  }
  function detailFor(item){
    var d=document.createElement('details');
    var s=document.createElement('summary');s.textContent=intentLabel(item.intent)+' → '+(item.first||'—')+' · '+reasonLabel(item.reason);d.appendChild(s);
    var order=document.createElement('div');order.className='vr-routing-diag-note';order.textContent=text('设置顺序：','Configured: ')+(state.body.currentOrder||[]).join(' → ')+'\n'+text('预览顺序：','Preview: ')+(item.order||[]).join(' → ');order.style.whiteSpace='pre-line';d.appendChild(order);
    var grid=document.createElement('div');grid.className='vr-routing-diag-grid';
    [text('设置#','Cfg#'),text('预览#','Auto#'),text('后端','Backend'),text('证据','Evidence'),text('该轴分','Axis'),text('延迟','Latency')].forEach(function(label){var h=document.createElement('div');h.textContent=label;h.className='vr-routing-diag-muted';grid.appendChild(h);});
    var candidates=item.diagnostics&&Array.isArray(item.diagnostics.candidates)?item.diagnostics.candidates:[];candidates.forEach(function(c){candidateRow(grid,c);});d.appendChild(grid);
    var checks=item.diagnostics&&Array.isArray(item.diagnostics.configuredPairChecks)?item.diagnostics.configuredPairChecks:[];
    checks.forEach(function(check){var n=document.createElement('div');n.className='vr-routing-diag-check';var numbers='';if(check.leftScore!=null||check.rightScore!=null){numbers=' · '+score(check.leftScore)+' vs '+score(check.rightScore);if(check.delta!=null)numbers+=' · Δ '+score(check.delta)+' / '+score(check.threshold);}n.textContent=check.left+' ↔ '+check.right+numbers+' → '+outcomeLabel(check);d.appendChild(n);});
    return d;
  }
  function render(){
    var node=state.node;if(!node||node.isConnected===false)return;node.replaceChildren();node.className='vr-routing-diag';
    var head=document.createElement('div');head.className='vr-routing-diag-head';var title=document.createElement('div');title.className='vr-routing-diag-title';title.textContent=text('Auto验收诊断','Auto acceptance diagnostics');head.appendChild(title);
    var actions=document.createElement('div');actions.className='vr-routing-diag-actions';actions.appendChild(button(state.loading?text('刷新中…','Refreshing…'):text('刷新诊断','Refresh'),function(){void refresh(true);}));actions.appendChild(button(text('复制JSON','Copy JSON'),copyJson));head.appendChild(actions);node.appendChild(head);
    if(state.body){var p=state.body.policy||{};var note=document.createElement('div');note.className='vr-routing-diag-note';note.textContent=text('公式：','Formula: ')+(p.formula||'—')+' · '+text('换序阈值：','Reorder threshold: ')+score(p.minAdvantage)+' · '+text('新鲜窗口：','Fresh window: ')+Math.round(Number(p.freshMaxAgeMs||0)/86400000)+text('天','d')+' · diag v'+String(state.body.diagnosticVersion||'?');node.appendChild(note);(state.body.previews||[]).forEach(function(item){node.appendChild(detailFor(item));});}
    else{var empty=document.createElement('div');empty.className='vr-routing-diag-note';empty.textContent=state.loading?text('正在读取诊断…','Loading diagnostics…'):text('暂无诊断数据','No diagnostic data');node.appendChild(empty);}
    if(state.error){var e=document.createElement('div');e.className=state.error.indexOf('已复制')>=0||state.error.indexOf('copied')>=0?'vr-routing-diag-note':'vr-routing-diag-error';e.textContent=state.error;node.appendChild(e);}
  }
  async function refresh(force){
    if(state.loading&&!force)return;state.loading=true;state.error='';render();
    try{var response=await fetch(ENDPOINT,{method:'GET',headers:{accept:'application/json'},cache:'no-store'});var body=await response.json().catch(function(){return undefined;});if(!response.ok||!body||body.ok!==true||body.diagnosticVersion!==1)throw new Error(body&&body.error?String(body.error):'HTTP '+response.status);state.body=body;}catch(error){state.error=text('诊断读取失败：','Diagnostic fetch failed: ')+String(error&&error.message||error);}finally{state.loading=false;render();}
  }
  function ensure(){
    var panel=document.querySelector(PANEL);if(!panel||!panel.parentNode)return;var node=panel.parentNode.querySelector('['+DIAG+']');if(!node){node=document.createElement('div');node.setAttribute(DIAG,'1');panel.parentNode.insertBefore(node,panel.nextSibling);}state.node=node;render();if(!state.body&&!state.loading)void refresh(false);
  }
  function benchmarkSignature(){
    var controls=document.querySelectorAll(CONTROL);var rows=[];Array.prototype.forEach.call(controls,function(c){var status=c.querySelector('[data-vr-capability-status]');rows.push([c.dataset.candidateKey||'',c.dataset.jobId||'',status&&status.textContent||''].join('|'));});return rows.join('||');
  }
  function scheduleBenchmarkRefresh(){
    if(state.timer!==undefined)clearTimeout(state.timer);state.timer=setTimeout(function(){state.timer=undefined;var sig=benchmarkSignature();if(sig===state.benchmarkSignature)return;var previous=state.benchmarkSignature;state.benchmarkSignature=sig;var active=document.querySelectorAll(CONTROL+'[data-job-id]').length;if(active===0&&previous!=='')void refresh(true);},250);
  }
  function touchesBenchmark(record){
    var target=record&&record.target;if(target&&target.nodeType===1&&((target.matches&&target.matches(CONTROL))||(target.closest&&target.closest(CONTROL))))return true;var added=record&&record.addedNodes;for(var i=0;added&&i<added.length;i+=1){var n=added[i];if(n&&n.nodeType===1&&((n.matches&&n.matches(CONTROL))||(n.querySelector&&n.querySelector(CONTROL))))return true;}return false;
  }
  function install(){
    if(typeof document==='undefined')return;installStyle();ensure();state.benchmarkSignature=benchmarkSignature();
    if(typeof MutationObserver==='function'&&document.documentElement){var observer=new MutationObserver(function(records){if(!state.node||state.node.isConnected===false)ensure();for(var i=0;i<records.length;i+=1){if(touchesBenchmark(records[i])){scheduleBenchmarkRefresh();break;}}});observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});}
  }
  try{install();}catch(_){}
})();`

export function injectVisionRoutingDiagnosticsPrelude(html) {
  if (typeof html !== 'string' || html.includes(ROUTING_DIAGNOSTICS_MARK)) return html
  const script = `<script ${ROUTING_DIAGNOSTICS_MARK}>${VISION_ROUTING_DIAGNOSTICS_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installVisionRoutingPreviewService(ctx, config, core, options = {}) {
  const logger = options.logger ?? ctx?.logger
  const store = options.store
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: VISION_ROUTING_PREVIEW_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            sendJson(res, 200, await buildVisionRoutingPreview({
              ctx,
              config,
              core,
              store,
            }))
          } catch (error) {
            logger?.warn?.(
              'vision-router: routing preview failed: %s',
              error?.message ?? String(error),
            )
            sendJson(res, 500, {
              ok: false,
              error: 'routing preview unavailable',
            })
          }
        },
      }),
      'vision-router: read-only routing preview service',
    )
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectVisionRoutingDiagnosticsPrelude),
      'vision-router: auto routing acceptance diagnostics client',
    )
  })
}

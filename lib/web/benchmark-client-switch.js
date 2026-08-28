import { CAPABILITY_BENCHMARK_CLIENT } from '../vision-capability-benchmark-client.js'
import { htmlHasScriptMarker } from '../html-script-marker.js'

const CLIENT_MARK = 'data-vision-router-capability-benchmark'
const SWITCH_SENTINEL = '/* vision-router-presentation-switch-v2 */'

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`capability benchmark presentation switch missing ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`capability benchmark presentation switch duplicate ${label}`)
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}

const HOST_RENDERER = String.raw`  function presentationBackground(candidate){
    var presentation=candidate&&candidate.presentation;
    var background=presentation&&presentation.background;
    return background&&typeof background==='object'?background:undefined;
  }
  function renderControl(row, control, body){
    var candidate=findCandidate(body,row), selection=rowSelection(row);
    setData(control,'selection',selection.provider+'\\u0000'+selection.model);
    setData(control,'jobId',undefined);
    if(!candidate){
      setData(control,'candidateKey',undefined);setData(control,'cloudCostWarning',undefined);
      setStatus(control,text('当前选择尚未进入Auto测评候选池；测试识图仍可直接验证当前模型','This selection is not in the Auto benchmark pool yet; Test vision can still verify the exact model'));
      setPrimary(control,text('测评','Benchmark'),'menu',false);return;
    }
    setData(control,'candidateKey',candidate.key||'');
    setData(control,'cloudCostWarning',candidate.cloudCostWarning===true?'1':'0');
    var job=latestJob(body,candidate.key);
    if(job&&job.state==='running'){
      var current=job.currentIntent?axisLabel(job.currentIntent):'';
      var msg=text('正在测评 ','Benchmarking ')+Number(job.completed||0)+'/'+Number(job.total||0);
      if(current)msg+=' · '+current;if(Number(job.elapsedMs)>0)msg+=' · '+seconds(job.elapsedMs);
      setStatus(control,msg);setData(control,'jobId',job.id||'');setPrimary(control,text('停止','Stop'),'cancel',true);return;
    }
    if(job&&job.state==='queued'){
      setStatus(control,text('排队中 · 第','Queued · #')+Number(job.position||1)+text('位 · ',' · ')+modeText(job.mode));
      setData(control,'jobId',job.id||'');setPrimary(control,text('取消','Cancel'),'cancel',true);return;
    }
    var background=presentationBackground(candidate);
    if(!background)return legacyRenderControl(row,control,body);
    if(background.state==='running'){
      var run=background.running||{};
      var backgroundAxis=run.axis?axisLabel(run.axis):'';
      var backgroundCompleted=Math.max(0,Number(run.completed||0));
      var backgroundTotal=Math.max(0,Number(run.total||0));
      var backgroundMsg=backgroundTotal>0
        ? text('正在测评 ','Benchmarking ')+backgroundCompleted+'/'+backgroundTotal
        : text('正在测评','Benchmarking');
      if(backgroundAxis)backgroundMsg+=' · '+backgroundAxis;
      if(Number(run.elapsedMs)>=0&&Number.isFinite(Number(run.elapsedMs)))backgroundMsg+=' · '+seconds(run.elapsedMs);
      backgroundMsg+=text(' · 后台自动',' · background');
      setStatus(control,backgroundMsg);
      setPrimary(control,text('测评中','Benchmarking'),'menu',candidate.benchmarkable===true,true);return;
    }
    if(background.state==='measured-text-only'){
      setStatus(control,text('实测仅文本 · 图片请求被模型拒绝 · 后台不再自动测','Measured text-only · image input rejected · background profiling stopped'));
      setPrimary(control,text('测评','Benchmark'),'menu',candidate.benchmarkable===true);return;
    }
    if(background.state==='deferred'||background.state==='stopped'){
      var deferred=background.deferred||{errorClass:background.reason||'provider',retryable:background.state==='deferred'};
      var deferredAxis=deferred.axis?axisLabel(deferred.axis):'';
      var deferredReason=errorLabel(deferred);
      var deferredMsg=background.state==='deferred'
        ? text('后台测评暂缓','Background benchmark deferred')+(deferredAxis?' · '+deferredAxis:'')+' · '+deferredReason+text(' · 稍后自动重试',' · will retry later')
        : text('后台测评停止','Background benchmark stopped')+(deferredAxis?' · '+deferredAxis:'')+' · '+deferredReason+text(' · 不再自动重试',' · no automatic retry');
      if(candidate.measured)deferredMsg=compactMeasuredText(candidate.measured)+' · '+deferredMsg;
      setStatus(control,deferredMsg,deferred.errorCode||deferredReason);
      setPrimary(control,text('测评','Benchmark'),'menu',candidate.benchmarkable===true);return;
    }
    if(job&&job.state==='failed'){
      var failed=errorLabel(job);
      setStatus(control,candidate.measured?compactMeasuredText(candidate.measured)+text(' · 最近：',' · Latest: ')+failed:failed,job.error||failed);
      setPrimary(control,text('测评','Benchmark'),'menu',candidate.benchmarkable===true);return;
    }
    if(background.state==='measured-waiting'){
      setStatus(control,compactMeasuredText(candidate.measured)+text(' · 等待后台补测',' · waiting for background profiling'),measuredMetaText(candidate.measured));
    }else if(background.state==='measured'){
      setStatus(control,compactMeasuredText(candidate.measured),measuredMetaText(candidate.measured));
    }else if(background.state==='paused'){
      setStatus(control,text('后台测评已暂停 · 当前任务结束后继续','Background profiling paused · resumes after current work'));
    }else if(background.state==='awaiting-verification'){
      setStatus(control,text('Host标记仅文本 · 等待实际后台测评验证','Host marks text-only · waiting for real background verification'));
    }else if(background.state==='waiting'){
      setStatus(control,text('等待后台测评 · Auto暂时保持设置顺序','Waiting for background benchmark · Auto keeps configured order for now'));
    }else if(background.state==='declared-text-only'){
      setStatus(control,text('Host标记仅文本 · 仅作提示；可用测试识图/测评实际验证','Host marks text-only · advisory only; Test vision / Benchmark can verify it'));
    }else if(background.state==='unavailable'){
      setStatus(control,text('暂不可测评','Benchmark unavailable'));
    }else if(background.state==='policy-excluded'){
      setStatus(control,text('尚未测评 · 当前后台模式不会自动测此模型','Not benchmarked · current background mode will not test this model'));
    }else if(background.state==='not-measured'){
      setStatus(control,text('尚未测评 · Auto暂时保持设置顺序','Not benchmarked · Auto keeps configured order for now'));
    }else return legacyRenderControl(row,control,body);
    setPrimary(control,text('测评','Benchmark'),'menu',candidate.benchmarkable===true);
  }

`

const HOST_BACKGROUND_PENDING = String.raw`  function backgroundPending(body){
    if(!body||!Array.isArray(body.candidates))return false;
    var sawPresentation=false;
    for(var i=0;i<body.candidates.length;i+=1){
      var background=presentationBackground(body.candidates[i]);
      if(!background)continue;
      sawPresentation=true;
      if(background.state==='running'||background.state==='waiting'||background.state==='paused'||background.state==='awaiting-verification'||background.state==='measured-waiting')return true;
      if(background.state==='deferred'&&background.deferred&&background.deferred.retryable===true)return true;
    }
    return sawPresentation?false:legacyBackgroundPending(body);
  }
`

export function switchCapabilityBenchmarkClientSource(source) {
  if (typeof source !== 'string') throw new TypeError('capability benchmark client source must be a string')
  if (source.includes(SWITCH_SENTINEL)) return source

  let next = replaceExactlyOnce(
    source,
    "  'use strict';\n",
    `  'use strict';\n  ${SWITCH_SENTINEL}\n`,
    'strict-mode anchor',
  )
  next = replaceExactlyOnce(
    next,
    '        body.background = await fetchBackgroundStatus();\n',
    '',
    'redundant runtime fetch',
  )
  next = replaceExactlyOnce(
    next,
    '  function renderControl(row, control, body){\n',
    '  function legacyRenderControl(row, control, body){\n',
    'legacy renderControl',
  )
  next = replaceExactlyOnce(
    next,
    '  function removeControl(row){\n',
    `${HOST_RENDERER}  function removeControl(row){\n`,
    'Host renderer insertion',
  )
  next = replaceExactlyOnce(
    next,
    '    var isMeasuredTextOnly=measuredTextOnly(body,candidate.key);\n',
    "    var candidateBackground=presentationBackground(candidate);\n    var isMeasuredTextOnly=candidateBackground?candidateBackground.state==='measured-text-only':measuredTextOnly(body,candidate.key);\n",
    'benchmark modal measured-text-only decision',
  )
  next = replaceExactlyOnce(
    next,
    '  function backgroundPending(body){\n',
    '  function legacyBackgroundPending(body){\n',
    'legacy background pending',
  )
  next = replaceExactlyOnce(
    next,
    '  function pollDelay(body){\n',
    `${HOST_BACKGROUND_PENDING}  function pollDelay(body){\n`,
    'Host polling insertion',
  )
  return next
}

export function injectSwitchedCapabilityBenchmarkClient(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, CLIENT_MARK)) return html
  const source = switchCapabilityBenchmarkClientSource(CAPABILITY_BENCHMARK_CLIENT)
  const script = `<script ${CLIENT_MARK}>${source.replace(/<\/script/gi, '<\\/script')}</script>`
  const head = html.indexOf('<head>')
  return head === -1 ? `${script}${html}` : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
}

export function installSwitchedCapabilityBenchmarkClient(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectSwitchedCapabilityBenchmarkClient),
      'vision-router: capability benchmark Host presentation client controls',
    )
  })
}

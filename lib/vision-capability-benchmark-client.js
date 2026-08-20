const CLIENT_MARK = 'data-vision-router-capability-benchmark'

export const CAPABILITY_BENCHMARK_CLIENT = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/capability-benchmark';
  var CHAIN_ROOT = '#vr-vision-backend-chain';
  var ROW_SELECTOR = CHAIN_ROOT + ' .vr-chain-row';
  var CONTROL_ATTR = 'data-vr-capability-control';
  var MANUAL_MODEL_ID = '__vision_router_manual_model__';
  var SCORE_ORDER = ['structured', 'ocr', 'document', 'grounding', 'general'];
  var LABELS = {
    structured: ['结构', 'Structured'],
    ocr: ['OCR', 'OCR'],
    document: ['文档', 'Document'],
    grounding: ['定位', 'Grounding'],
    general: ['通用', 'General']
  };
  var snapshot;
  var snapshotAt = 0;
  var snapshotPromise;
  var scanTimer;
  var pollTimer;
  var rowControls = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function zh() {
    try {
      var lang = document && document.documentElement && document.documentElement.lang;
      return typeof lang === 'string' && lang.toLowerCase().startsWith('zh');
    } catch (_) { return true; }
  }

  function text(zhText, enText) { return zh() ? zhText : enText; }

  function controllerTimeout(ms) {
    if (typeof AbortController !== 'function') return { signal: undefined, clear: function(){} };
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, ms);
    return { signal: controller.signal, clear: function(){ clearTimeout(timer); } };
  }

  function invalidateSnapshot() {
    snapshot = undefined;
    snapshotAt = 0;
  }

  async function fetchSnapshot(force) {
    var now = Date.now();
    if (!force && snapshot && now - snapshotAt < 700) return snapshot;
    if (snapshotPromise) return snapshotPromise;
    snapshotPromise = (async function(){
      var timeout = controllerTimeout(3000);
      try {
        var response = await fetch(ENDPOINT, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: timeout.signal
        });
        if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
        var body = await response.json();
        if (!body || body.ok !== true || !Array.isArray(body.candidates) || !Array.isArray(body.jobs)) {
          throw new Error('invalid benchmark snapshot');
        }
        snapshot = body;
        snapshotAt = Date.now();
        return body;
      } finally {
        timeout.clear();
        snapshotPromise = undefined;
      }
    })();
    return snapshotPromise;
  }

  function rowSelection(row) {
    var selects = row && typeof row.querySelectorAll === 'function' ? row.querySelectorAll('select') : [];
    var provider = selects && selects[0] && typeof selects[0].value === 'string' ? selects[0].value.trim() : '';
    var model = selects && selects[1] && typeof selects[1].value === 'string' ? selects[1].value.trim() : '';
    return { provider: provider, model: model };
  }

  function completeSelection(selected) {
    return !!selected && !!selected.provider && !!selected.model && selected.model !== MANUAL_MODEL_ID;
  }

  function findCandidate(body, row) {
    var selected = rowSelection(row);
    if (!completeSelection(selected) || !body || !Array.isArray(body.candidates)) return undefined;
    return body.candidates.find(function(candidate) {
      return candidate && candidate.provider === selected.provider && candidate.model === selected.model;
    });
  }

  function latestJob(body, key) {
    if (!body || !Array.isArray(body.jobs) || !key) return undefined;
    var jobs = body.jobs.filter(function(job){ return job && job.key === key; });
    if (jobs.length === 0) return undefined;
    jobs.sort(function(a, b){
      var rank = function(job){ return job.state === 'running' ? 0 : job.state === 'queued' ? 1 : 2; };
      return rank(a) - rank(b) || Number(b.enqueuedAt || 0) - Number(a.enqueuedAt || 0);
    });
    return jobs[0];
  }

  function seconds(ms) {
    var value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '';
    return value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(value < 10000 ? 1 : 0) + 's';
  }

  function ageText(measuredAt, freshness) {
    var at = Number(measuredAt);
    if (!Number.isFinite(at) || at <= 0) return '';
    var days = Math.max(0, Math.floor((Date.now() - at) / 86400000));
    if (freshness === 'stale') return text('已陈旧 · ' + days + '天前', 'Stale · ' + days + 'd ago');
    if (days === 0) return text('刚刚', 'just now');
    return text(days + '天前', days + 'd ago');
  }

  function confidenceText(value) {
    if (value === 'medium') return text('中置信度', 'medium confidence');
    return text('低置信度', 'low confidence');
  }

  function scoreText(measured) {
    if (!measured || !measured.scores) return '';
    var rendered = [];
    SCORE_ORDER.forEach(function(key){
      var score = Number(measured.scores[key]);
      if (!Number.isFinite(score)) return;
      var label = LABELS[key] || [key, key];
      rendered.push((zh() ? label[0] : label[1]) + ' ' + Math.round(score * 100));
    });
    if (Number.isFinite(Number(measured.latencyMs))) {
      rendered.push(text('中位 ' + seconds(measured.latencyMs), 'median ' + seconds(measured.latencyMs)));
    }
    var age = ageText(measured.measuredAt, measured.freshness);
    if (age) rendered.push(age);
    rendered.push(confidenceText(measured.confidence));
    return rendered.join(' · ');
  }

  function groundingDiagnosticText(diag) {
    if (!diag) return '';
    var lines = [];
    lines.push(text('定位测试诊断', 'Grounding diagnostic'));
    lines.push('score=' + Math.round(Number(diag.score || 0) * 100) + '  IoU=' + Number(diag.iou || 0).toFixed(4));
    lines.push('parse=' + String(diag.parseSource || 'none') + '  shape=' + String(diag.responseShape || 'none'));
    lines.push('space=' + String(diag.coordinateSpace || 'none') + '  formatValid=' + String(diag.formatValid === true));
    if (Array.isArray(diag.parsed)) lines.push('parsed=' + JSON.stringify(diag.parsed));
    if (diag.normalized) lines.push('normalized=' + JSON.stringify(diag.normalized));
    if (Array.isArray(diag.candidateSpaces) && diag.candidateSpaces.length) lines.push('candidateSpaces=' + diag.candidateSpaces.join(','));
    return lines.join('\n');
  }

  function errorLabel(job) {
    var cls = job && job.errorClass;
    var labels = {
      auth: ['鉴权失败', 'Authentication failed'],
      'rate-limit': ['触发限流', 'Rate limited'],
      timeout: ['请求超时', 'Timed out'],
      'unsupported-image': ['模型拒绝图片', 'Model rejected images'],
      protocol: ['测试协议暂不支持', 'Benchmark protocol unsupported'],
      infrastructure: ['测试组件异常', 'Benchmark infrastructure failed'],
      network: ['网络失败', 'Network failed'],
      cancelled: ['已取消', 'Cancelled'],
      provider: ['模型调用失败', 'Provider call failed']
    };
    var pair = labels[cls] || labels.provider;
    return zh() ? pair[0] : pair[1];
  }

  function statusNode(control) { return control && control.querySelector('[data-vr-capability-status]'); }
  function buttonNode(control, action) { return control && control.querySelector('[data-vr-capability-action="' + action + '"]'); }

  function setStatus(control, message, detail) {
    var status = statusNode(control);
    if (!status) return;
    status.textContent = message || '';
    status.title = detail || message || '';
  }

  function setButton(control, action, visible, label, disabled) {
    var button = buttonNode(control, action);
    if (!button) return;
    button.hidden = !visible;
    button.disabled = disabled === true;
    if (label) button.textContent = label;
  }

  function resetButtons(control) {
    setButton(control, 'quick', false, text('快速测试', 'Quick test'));
    setButton(control, 'full', false, text('完整测试', 'Full test'));
    setButton(control, 'force', false, text('强制验证', 'Force verify'));
    setButton(control, 'details', false, text('定位详情', 'Grounding details'));
    setButton(control, 'cancel', false, text('取消', 'Cancel'));
    delete control.dataset.groundingDiagnostic;
  }

  function renderControl(row, control, body) {
    var candidate = findCandidate(body, row);
    control.dataset.selection = rowSelection(row).provider + '\u0000' + rowSelection(row).model;
    resetButtons(control);
    if (!candidate) {
      setStatus(control, text('当前模型暂不在可执行识图候选池', 'This model is not in the executable vision pool'));
      return;
    }
    control.dataset.candidateKey = candidate.key || '';
    control.dataset.cloudCostWarning = candidate.cloudCostWarning === true ? '1' : '0';
    var job = latestJob(body, candidate.key);
    if (job && job.state === 'running') {
      var progress = Number(job.completed || 0) + '/' + Number(job.total || 0);
      var current = job.currentIntent && LABELS[job.currentIntent]
        ? (zh() ? LABELS[job.currentIntent][0] : LABELS[job.currentIntent][1])
        : '';
      var runningText = text('测试中 ', 'Testing ') + progress;
      if (current) runningText += ' · ' + current;
      if (Number(job.elapsedMs) > 0) runningText += ' · ' + seconds(job.elapsedMs);
      setStatus(control, runningText);
      control.dataset.jobId = job.id || '';
      setButton(control, 'cancel', true, text('停止测试', 'Stop'));
      return;
    }
    if (job && job.state === 'queued') {
      setStatus(control, text(
        '排队中 · 第' + Number(job.position || 1) + '位 · ' + (job.mode === 'full' ? '完整测试' : '快速测试'),
        'Queued · #' + Number(job.position || 1) + ' · ' + (job.mode === 'full' ? 'full' : 'quick')
      ));
      control.dataset.jobId = job.id || '';
      setButton(control, 'cancel', true, text('取消排队', 'Cancel queue'));
      return;
    }
    delete control.dataset.jobId;
    var groundingDiagnostic = candidate.measured && candidate.measured.groundingDiagnostic
      ? candidate.measured.groundingDiagnostic
      : (job && job.groundingDiagnostic ? job.groundingDiagnostic : undefined);
    if (groundingDiagnostic) {
      control.dataset.groundingDiagnostic = JSON.stringify(groundingDiagnostic);
      setButton(control, 'details', true, text('定位详情', 'Grounding details'));
    }

    var measuredText = candidate.measured ? scoreText(candidate.measured) : '';
    if (job && job.state === 'failed') {
      var failed = errorLabel(job);
      setStatus(control, measuredText
        ? text('上次实测：', 'Last result: ') + measuredText + ' · ' + text('本次：', 'Latest: ') + failed
        : failed,
        job.error || failed);
    } else if (job && job.state === 'cancelled') {
      setStatus(control, measuredText ? measuredText + ' · ' + text('上次测试已取消', 'last test cancelled') : text('已取消', 'Cancelled'));
    } else if (measuredText) {
      setStatus(control, measuredText, groundingDiagnostic ? groundingDiagnosticText(groundingDiagnostic) : measuredText);
    } else if (candidate.imageCapability === 'text-only') {
      setStatus(control, text('DSH标记为仅文本；如确认该模型实际支持图片，可强制验证', 'DSH marks this model text-only; force verification only if it really accepts images'));
    } else if (candidate.benchmarkable !== true) {
      setStatus(control, text('暂无法生成稳定测试身份', 'No stable benchmark identity is available'));
    } else {
      setStatus(control, text('快速测试约3次请求；完整测试约6次请求', 'Quick ≈3 requests; full ≈6 requests'));
    }

    if (candidate.benchmarkable !== true) return;
    if (candidate.imageCapability === 'text-only' && !candidate.measured) {
      setButton(control, 'force', true, text('强制验证', 'Force verify'));
      return;
    }
    setButton(control, 'quick', true, candidate.measured ? text('快速重测', 'Quick retest') : text('快速测试', 'Quick test'));
    setButton(control, 'full', true, candidate.measured ? text('完整重测', 'Full retest') : text('完整测试', 'Full test'));
  }

  function removeControl(row) {
    if (!row) return;
    var control = rowControls && rowControls.get(row);
    if (!control && typeof row.querySelector === 'function') control = row.querySelector('[' + CONTROL_ATTR + ']');
    if (control && typeof control.remove === 'function') control.remove();
    if (rowControls) rowControls.delete(row);
    if (row.dataset && Object.prototype.hasOwnProperty.call(row.dataset, 'vrCapabilityOldFlexWrap')) {
      row.style.flexWrap = row.dataset.vrCapabilityOldFlexWrap;
      delete row.dataset.vrCapabilityOldFlexWrap;
    }
  }

  function actionButton(action, label) {
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-vr-capability-action', action);
    button.textContent = label;
    button.style.font = 'inherit';
    button.style.padding = '4px 9px';
    button.style.border = '1px solid currentColor';
    button.style.borderRadius = '6px';
    button.style.background = 'transparent';
    button.style.color = 'inherit';
    button.style.cursor = 'pointer';
    button.style.flex = '0 0 auto';
    button.hidden = true;
    return button;
  }

  function makeControl(row) {
    if (!row || !row.style) return undefined;
    if (row.dataset && !Object.prototype.hasOwnProperty.call(row.dataset, 'vrCapabilityOldFlexWrap')) {
      row.dataset.vrCapabilityOldFlexWrap = row.style.flexWrap || '';
    }
    row.style.flexWrap = 'wrap';
    var control = document.createElement('div');
    control.setAttribute(CONTROL_ATTR, '1');
    control.style.display = 'flex';
    control.style.alignItems = 'center';
    control.style.justifyContent = 'space-between';
    control.style.gap = '8px';
    control.style.flex = '1 0 100%';
    control.style.width = '100%';
    control.style.minWidth = '0';
    control.style.boxSizing = 'border-box';
    control.style.marginTop = '2px';
    control.style.paddingTop = '2px';

    var status = document.createElement('span');
    status.setAttribute('data-vr-capability-status', '1');
    status.style.fontSize = '12px';
    status.style.opacity = '0.72';
    status.style.overflow = 'hidden';
    status.style.textOverflow = 'ellipsis';
    status.style.whiteSpace = 'nowrap';
    status.style.minWidth = '0';
    status.style.flex = '1 1 auto';

    var actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';
    actions.style.gap = '6px';
    actions.style.flex = '0 0 auto';
    actions.appendChild(actionButton('quick', text('快速测试', 'Quick test')));
    actions.appendChild(actionButton('full', text('完整测试', 'Full test')));
    actions.appendChild(actionButton('force', text('强制验证', 'Force verify')));
    actions.appendChild(actionButton('details', text('定位详情', 'Grounding details')));
    actions.appendChild(actionButton('cancel', text('取消', 'Cancel')));

    control.appendChild(status);
    control.appendChild(actions);
    row.appendChild(control);
    if (rowControls) rowControls.set(row, control);
    control.addEventListener('click', function(event){
      var target = event && event.target;
      var button = target && typeof target.closest === 'function' ? target.closest('[data-vr-capability-action]') : undefined;
      if (!button || !control.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      var action = button.getAttribute('data-vr-capability-action');
      void handleAction(row, control, action);
    });
    return control;
  }

  function controlFor(row) {
    var control = rowControls && rowControls.get(row);
    if (control && control.isConnected !== false) return control;
    control = typeof row.querySelector === 'function' ? row.querySelector('[' + CONTROL_ATTR + ']') : undefined;
    if (control && rowControls) rowControls.set(row, control);
    return control;
  }

  function cloudCostConfirm(candidate, mode) {
    if (!candidate || candidate.cloudCostWarning !== true) return true;
    var count = mode === 'full' ? 6 : 3;
    return window.confirm(text(
      (mode === 'full' ? '完整测试' : '快速测试') + '会向这个云端模型发送约' + count + '次生成的测试图片请求，可能产生API费用。继续？',
      (mode === 'full' ? 'Full test' : 'Quick test') + ' sends about ' + count + ' generated-image requests to this cloud model and may incur API charges. Continue?'
    ));
  }

  async function enqueue(row, control, mode, force) {
    var body = await fetchSnapshot(true);
    var candidate = findCandidate(body, row);
    if (!candidate || !candidate.key) return;
    if (!cloudCostConfirm(candidate, mode)) return;
    setStatus(control, text('正在加入测试队列…', 'Adding to benchmark queue…'));
    var timeout = controllerTimeout(8000);
    try {
      var response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ key: candidate.key, mode: mode, force: force === true }),
        signal: timeout.signal
      });
      var result = await response.json().catch(function(){ return {}; });
      if (!response.ok || !result || result.ok !== true) {
        throw new Error(String(result && (result.error || result.code) || ('HTTP ' + response.status)));
      }
      invalidateSnapshot();
      await refreshAll(true);
    } catch (error) {
      setStatus(control, text('加入队列失败：', 'Queue failed: ') + String(error && error.message || error));
    } finally {
      timeout.clear();
    }
  }

  async function cancel(control) {
    var jobId = control && control.dataset.jobId;
    if (!jobId) return;
    var timeout = controllerTimeout(8000);
    try {
      var response = await fetch(ENDPOINT, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ jobId: jobId }),
        signal: timeout.signal
      });
      var result = await response.json().catch(function(){ return {}; });
      if (!response.ok || !result || result.ok !== true) throw new Error(String(result && (result.error || result.code) || ('HTTP ' + response.status)));
      invalidateSnapshot();
      await refreshAll(true);
    } catch (error) {
      setStatus(control, text('取消失败：', 'Cancel failed: ') + String(error && error.message || error));
    } finally {
      timeout.clear();
    }
  }

  async function handleAction(row, control, action) {
    if (action === 'details') {
      var raw = control && control.dataset.groundingDiagnostic;
      if (!raw) return;
      try { window.alert(groundingDiagnosticText(JSON.parse(raw))); } catch (_) {}
      return;
    }
    if (action === 'cancel') return cancel(control);
    if (action === 'force') return enqueue(row, control, 'quick', true);
    if (action === 'full') return enqueue(row, control, 'full', false);
    return enqueue(row, control, 'quick', false);
  }

  function hasActiveJobs(body) {
    return !!(body && Array.isArray(body.jobs) && body.jobs.some(function(job){
      return job && (job.state === 'queued' || job.state === 'running');
    }));
  }

  function schedulePoll(body) {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (!hasActiveJobs(body)) return;
    pollTimer = setTimeout(function(){
      pollTimer = undefined;
      invalidateSnapshot();
      void refreshAll(true);
    }, 1000);
  }

  async function refreshAll(force) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    var rows = document.querySelectorAll(ROW_SELECTOR);
    Array.prototype.forEach.call(rows, function(row){
      if (!completeSelection(rowSelection(row))) removeControl(row);
      else if (!controlFor(row)) makeControl(row);
    });
    var body;
    try {
      body = await fetchSnapshot(force === true);
    } catch (error) {
      Array.prototype.forEach.call(rows, function(row){
        var control = controlFor(row);
        if (control) setStatus(control, text('能力测试服务暂不可用', 'Capability test service unavailable') + ': ' + String(error && error.message || error));
      });
      return;
    }
    Array.prototype.forEach.call(rows, function(row){
      if (!completeSelection(rowSelection(row))) return;
      var control = controlFor(row) || makeControl(row);
      if (control) renderControl(row, control, body);
    });
    schedulePoll(body);
  }

  function scheduleScan(force) {
    if (scanTimer !== undefined) return;
    scanTimer = setTimeout(function(){
      scanTimer = undefined;
      void refreshAll(force === true);
    }, 50);
  }

  function nodeTouchesChain(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      if (typeof node.matches === 'function' && (node.matches(CHAIN_ROOT) || node.matches(ROW_SELECTOR))) return true;
      if (typeof node.querySelector === 'function' && node.querySelector(CHAIN_ROOT + ', ' + ROW_SELECTOR)) return true;
      if (typeof node.closest === 'function' && node.closest(CHAIN_ROOT)) return true;
    } catch (_) {}
    return false;
  }

  function install() {
    if (typeof document === 'undefined') return;
    document.addEventListener('change', function(event) {
      var target = event && event.target;
      var row = target && typeof target.closest === 'function' ? target.closest(ROW_SELECTOR) : undefined;
      if (!row) return;
      invalidateSnapshot();
      scheduleScan(true);
    }, true);
    if (typeof MutationObserver === 'function' && document.documentElement) {
      var observer = new MutationObserver(function(records){
        for (var i = 0; i < records.length; i += 1) {
          var added = records[i] && records[i].addedNodes;
          for (var j = 0; added && j < added.length; j += 1) {
            if (nodeTouchesChain(added[j])) {
              scheduleScan(false);
              return;
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    scheduleScan(true);
  }

  try { install(); } catch (_) {}
})();`

export function injectCapabilityBenchmarkClient(html) {
  const text = String(html ?? '')
  if (text.includes(CLIENT_MARK)) return text
  const script = `<script ${CLIENT_MARK}="1">${CAPABILITY_BENCHMARK_CLIENT}</script>`
  return /<\/body>/i.test(text) ? text.replace(/<\/body>/i, `${script}</body>`) : `${text}${script}`
}

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

  function modeText(mode) {
    if (mode === 'full') return text('完整测试', 'Full test');
    if (mode === 'grounding') return text('定位诊断', 'Grounding diagnostic');
    return text('快速测试', 'Quick test');
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
    return rendered.join(' · ');
  }

  function measuredMetaText(measured) {
    if (!measured) return '';
    var rendered = [];
    if (Number.isFinite(Number(measured.latencyMs))) {
      rendered.push(text('中位 ' + seconds(measured.latencyMs), 'median ' + seconds(measured.latencyMs)));
    }
    var age = ageText(measured.measuredAt, measured.freshness);
    if (age) rendered.push(age);
    rendered.push(confidenceText(measured.confidence));
    return rendered.join(' · ');
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
  function buttonNode(control) { return control && control.querySelector('[data-vr-capability-primary]'); }

  function setStatus(control, message, detail) {
    var status = statusNode(control);
    if (!status) return;
    status.textContent = message || '';
    status.title = detail || message || '';
  }

  function setPrimary(control, label, action, visible, disabled) {
    var button = buttonNode(control);
    if (!button) return;
    button.textContent = label || '';
    button.dataset.action = action || '';
    button.hidden = visible === false;
    button.disabled = disabled === true;
  }

  function clearControlState(control) {
    if (!control) return;
    delete control.dataset.jobId;
    delete control.dataset.candidateKey;
    delete control.dataset.cloudCostWarning;
  }

  function renderControl(row, control, body) {
    var candidate = findCandidate(body, row);
    clearControlState(control);
    control.dataset.selection = rowSelection(row).provider + '\u0000' + rowSelection(row).model;
    if (!candidate) {
      setStatus(control, text('当前模型暂不在可执行识图候选池', 'This model is not in the executable vision pool'));
      setPrimary(control, text('测评', 'Test'), 'menu', false);
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
      var runningText = text('正在测评 ', 'Testing ') + progress;
      if (current) runningText += ' · ' + current;
      if (Number(job.elapsedMs) > 0) runningText += ' · ' + seconds(job.elapsedMs);
      setStatus(control, runningText);
      control.dataset.jobId = job.id || '';
      setPrimary(control, text('停止', 'Stop'), 'cancel', true);
      return;
    }

    if (job && job.state === 'queued') {
      setStatus(control, text('排队中 · 第', 'Queued · #') + Number(job.position || 1) + text('位 · ', ' · ') + modeText(job.mode));
      control.dataset.jobId = job.id || '';
      setPrimary(control, text('取消', 'Cancel'), 'cancel', true);
      return;
    }

    var measured = candidate.measured;
    var measuredText = measured ? scoreText(measured) : '';

    if (job && job.state === 'failed') {
      var failed = errorLabel(job);
      setStatus(control, measuredText
        ? text('实测能力 · ', 'Measured · ') + measuredText + text(' · 最近：', ' · Latest: ') + failed
        : failed,
        job.error || failed);
    } else if (measuredText) {
      setStatus(control, text('实测能力 · ', 'Measured · ') + measuredText, measuredMetaText(measured));
    } else if (candidate.imageCapability === 'text-only') {
      setStatus(control, text('仅文本模型', 'Text-only model'));
    } else if (candidate.benchmarkable !== true) {
      setStatus(control, text('暂不可测评', 'Benchmark unavailable'));
    } else {
      setStatus(control, text('尚未测评', 'Not tested yet'));
    }

    if (candidate.benchmarkable !== true) {
      setPrimary(control, text('测评', 'Test'), 'menu', false);
      return;
    }
    setPrimary(control, text('测评', 'Test'), 'menu', true);
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

  function makePrimaryButton() {
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-vr-capability-primary', '1');
    button.style.font = 'inherit';
    button.style.padding = '4px 12px';
    button.style.border = '1px solid currentColor';
    button.style.borderRadius = '8px';
    button.style.background = 'transparent';
    button.style.color = 'inherit';
    button.style.cursor = 'pointer';
    button.style.flex = '0 0 auto';
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
    control.style.gap = '10px';
    control.style.flex = '1 0 100%';
    control.style.width = '100%';
    control.style.minWidth = '0';
    control.style.boxSizing = 'border-box';
    control.style.marginTop = '1px';
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

    var button = makePrimaryButton();
    control.appendChild(status);
    control.appendChild(button);
    row.appendChild(control);
    if (rowControls) rowControls.set(row, control);

    button.addEventListener('click', function(event){
      event.preventDefault();
      event.stopPropagation();
      var action = button.dataset.action;
      if (action === 'cancel') {
        void cancel(control);
        return;
      }
      void openBenchmarkModal(row, control);
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

  function closeModal() {
    var current = document.querySelector('[' + MODAL_ATTR + ']');
    if (current && typeof current.remove === 'function') current.remove();
  }

  function modalButton(label, description, action, tone) {
    var button = document.createElement('button');
    button.type = 'button';
    button.dataset.modalAction = action;
    button.style.display = 'block';
    button.style.width = '100%';
    button.style.textAlign = 'left';
    button.style.padding = '12px 14px';
    button.style.border = '1px solid rgba(127,127,127,.22)';
    button.style.borderRadius = '10px';
    button.style.background = tone === 'primary' ? 'rgba(127,127,127,.10)' : 'transparent';
    button.style.color = 'inherit';
    button.style.cursor = 'pointer';
    button.style.font = 'inherit';

    var title = document.createElement('div');
    title.textContent = label;
    title.style.fontWeight = '600';
    title.style.marginBottom = description ? '3px' : '0';

    var desc = document.createElement('div');
    desc.textContent = description || '';
    desc.style.fontSize = '12px';
    desc.style.opacity = '0.66';

    button.appendChild(title);
    if (description) button.appendChild(desc);
    return button;
  }

  function diagnosticSummary(diag) {
    if (!diag) return '';
    var score = Math.round(Number(diag.score || 0) * 100);
    var iou = Number(diag.iou || 0);
    return text('定位 ' + score + ' · IoU ' + iou.toFixed(3), 'Grounding ' + score + ' · IoU ' + iou.toFixed(3));
  }

  function appendDiagnosticDetails(container, diag) {
    if (!diag) return;
    var card = document.createElement('div');
    card.style.marginTop = '10px';
    card.style.padding = '12px 14px';
    card.style.border = '1px solid rgba(127,127,127,.22)';
    card.style.borderRadius = '10px';

    var title = document.createElement('div');
    title.textContent = text('定位能力', 'Grounding');
    title.style.fontWeight = '600';

    var summary = document.createElement('div');
    summary.textContent = diagnosticSummary(diag);
    summary.style.marginTop = '5px';

    var details = document.createElement('details');
    details.style.marginTop = '10px';
    var summaryNode = document.createElement('summary');
    summaryNode.textContent = text('开发者信息', 'Developer details');
    summaryNode.style.cursor = 'pointer';
    details.appendChild(summaryNode);

    var pre = document.createElement('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';
    pre.style.fontSize = '11px';
    pre.style.opacity = '0.72';
    pre.style.margin = '8px 0 0';
    var lines = [];
    lines.push('parse=' + String(diag.parseSource || 'none') + '  shape=' + String(diag.responseShape || 'none'));
    lines.push('space=' + String(diag.coordinateSpace || 'none') + '  formatValid=' + String(diag.formatValid === true));
    if (Array.isArray(diag.parsed)) lines.push('parsed=' + JSON.stringify(diag.parsed));
    if (diag.normalized) lines.push('normalized=' + JSON.stringify(diag.normalized));
    if (Array.isArray(diag.candidateSpaces) && diag.candidateSpaces.length) lines.push('candidateSpaces=' + diag.candidateSpaces.join(','));
    pre.textContent = lines.join('\n');
    details.appendChild(pre);

    card.appendChild(title);
    card.appendChild(summary);
    card.appendChild(details);
    container.appendChild(card);
  }

  function costNote(candidate) {
    if (!candidate || candidate.cloudCostWarning !== true) return '';
    return text(
      '云端测评会发送生成的测试图片，快速约3次、完整约6次，可能产生API费用。',
      'Cloud benchmarks send generated test images: about 3 requests for quick and 6 for full, which may incur API charges.'
    );
  }

  async function openBenchmarkModal(row, control) {
    var body;
    try {
      body = await fetchSnapshot(true);
    } catch (error) {
      setStatus(control, text('能力测试服务暂不可用', 'Capability test service unavailable') + ': ' + String(error && error.message || error));
      return;
    }
    var candidate = findCandidate(body, row);
    if (!candidate) return;
    closeModal();

    var overlay = document.createElement('div');
    overlay.setAttribute(MODAL_ATTR, '1');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '2147483646';
    overlay.style.background = 'rgba(0,0,0,.28)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '20px';

    var panel = document.createElement('div');
    panel.style.width = 'min(440px, calc(100vw - 32px))';
    panel.style.maxHeight = 'min(680px, calc(100vh - 40px))';
    panel.style.overflow = 'auto';
    panel.style.background = 'Canvas';
    panel.style.color = 'CanvasText';
    panel.style.border = '1px solid rgba(127,127,127,.25)';
    panel.style.borderRadius = '16px';
    panel.style.boxShadow = '0 18px 60px rgba(0,0,0,.22)';
    panel.style.padding = '18px';

    var head = document.createElement('div');
    head.style.display = 'flex';
    head.style.alignItems = 'flex-start';
    head.style.justifyContent = 'space-between';
    head.style.gap = '12px';

    var headingWrap = document.createElement('div');
    var heading = document.createElement('div');
    heading.textContent = text('模型测评', 'Model benchmark');
    heading.style.fontSize = '17px';
    heading.style.fontWeight = '700';

    var model = document.createElement('div');
    model.textContent = candidate.provider + ' / ' + candidate.model;
    model.style.fontSize = '12px';
    model.style.opacity = '0.68';
    model.style.marginTop = '3px';

    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.style.border = '0';
    close.style.background = 'transparent';
    close.style.color = 'inherit';
    close.style.fontSize = '24px';
    close.style.cursor = 'pointer';
    close.style.lineHeight = '1';
    close.addEventListener('click', closeModal);

    headingWrap.appendChild(heading);
    headingWrap.appendChild(model);
    head.appendChild(headingWrap);
    head.appendChild(close);
    panel.appendChild(head);

    if (candidate.measured) {
      var score = document.createElement('div');
      score.textContent = scoreText(candidate.measured);
      score.style.marginTop = '16px';
      score.style.fontWeight = '600';
      panel.appendChild(score);

      var meta = document.createElement('div');
      meta.textContent = measuredMetaText(candidate.measured);
      meta.style.fontSize = '12px';
      meta.style.opacity = '0.66';
      meta.style.marginTop = '4px';
      panel.appendChild(meta);
    } else {
      var empty = document.createElement('div');
      empty.textContent = candidate.imageCapability === 'text-only'
        ? text('DSH当前将此模型标记为仅文本。', 'DSH currently marks this model as text-only.')
        : text('尚未测评。', 'Not tested yet.');
      empty.style.marginTop = '16px';
      empty.style.opacity = '0.72';
      panel.appendChild(empty);
    }

    var list = document.createElement('div');
    list.style.display = 'grid';
    list.style.gap = '8px';
    list.style.marginTop = '16px';

    if (candidate.imageCapability === 'text-only' && !candidate.measured) {
      list.appendChild(modalButton(
        text('强制验证图片能力', 'Force-verify image support'),
        text('约3次请求；仅在你确认该模型实际可能支持图片时使用。', 'About 3 requests; use only if you believe the model may actually accept images.'),
        'force',
        'primary'
      ));
    } else {
      list.appendChild(modalButton(
        candidate.measured ? text('快速重测', 'Quick retest') : text('快速测试', 'Quick test'),
        text('约3次请求 · OCR与通用视觉 · 低置信度', 'About 3 requests · OCR and general vision · low confidence'),
        'quick',
        'primary'
      ));
      list.appendChild(modalButton(
        candidate.measured ? text('完整重测', 'Full retest') : text('完整测试', 'Full test'),
        text('约6次请求 · 包含结构、文档与定位 · 中置信度', 'About 6 requests · includes structure, document and grounding · medium confidence'),
        'full'
      ));
    }

    var groundingDiagnostic = candidate.measured && candidate.measured.groundingDiagnostic;
    var hasGroundingScore = !!(candidate.measured && candidate.measured.scores && Number.isFinite(Number(candidate.measured.scores.grounding)));
    if (hasGroundingScore && !groundingDiagnostic) {
      list.appendChild(modalButton(
        text('诊断定位', 'Diagnose grounding'),
        text('只发送1次定位测试，用于补充旧档案的定位诊断。', 'Sends one grounding request to repair diagnostic data for an older profile.'),
        'diagnose'
      ));
    }

    panel.appendChild(list);

    var noteText = costNote(candidate);
    if (noteText) {
      var note = document.createElement('div');
      note.textContent = noteText;
      note.style.fontSize = '11px';
      note.style.opacity = '0.58';
      note.style.marginTop = '12px';
      panel.appendChild(note);
    }

    if (groundingDiagnostic) appendDiagnosticDetails(panel, groundingDiagnostic);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(event){
      if (event.target === overlay) closeModal();
    });
    panel.addEventListener('click', function(event){
      var target = event && event.target;
      var button = target && typeof target.closest === 'function' ? target.closest('[data-modal-action]') : undefined;
      if (!button || !panel.contains(button)) return;
      var action = button.dataset.modalAction;
      closeModal();
      if (action === 'force') return void enqueue(row, control, 'quick', true);
      if (action === 'diagnose') return void enqueue(row, control, 'grounding', false);
      if (action === 'full') return void enqueue(row, control, 'full', false);
      return void enqueue(row, control, 'quick', false);
    });
  }

  async function enqueue(row, control, mode, force) {
    var body = await fetchSnapshot(true);
    var candidate = findCandidate(body, row);
    if (!candidate || !candidate.key) return;
    setStatus(control, text('正在加入测评队列…', 'Adding to benchmark queue…'));
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
    document.addEventListener('keydown', function(event){
      if (event && event.key === 'Escape') closeModal();
    });
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
  if (typeof html !== 'string' || html.includes(CLIENT_MARK)) return html
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

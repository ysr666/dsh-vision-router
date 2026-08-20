const CLIENT_MARK = 'data-vision-router-capability-benchmark'

export const CAPABILITY_BENCHMARK_CLIENT = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/capability-benchmark';
  var CHAIN_ROOT = '#vr-vision-backend-chain';
  var ROW_SELECTOR = CHAIN_ROOT + ' .vr-chain-row';
  var CONTROL_ATTR = 'data-vr-capability-control';
  var MANUAL_MODEL_ID = '__vision_router_manual_model__';
  var snapshot;
  var snapshotAt = 0;
  var snapshotPromise;
  var scanTimer;
  var activeRunKey = '';
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

  function runningKeyOf(body) {
    return body && typeof body.runningKey === 'string' ? body.runningKey.trim() : '';
  }

  async function fetchSnapshot(force) {
    var now = Date.now();
    if (!force && snapshot && now - snapshotAt < 5000) return snapshot;
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
        if (!body || body.ok !== true || !Array.isArray(body.candidates)) throw new Error('invalid benchmark snapshot');
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

  var LABELS = {
    structured: ['结构', 'Structured'],
    ocr: ['OCR', 'OCR'],
    document: ['文档', 'Document'],
    ui: ['UI', 'UI'],
    grounding: ['定位', 'Grounding'],
    detection: ['检测', 'Detection'],
    general: ['通用', 'General'],
    chart_diagram: ['图表', 'Diagram'],
    code_screenshot: ['代码', 'Code'],
    visual_compare: ['对比', 'Compare']
  };

  function scoreText(measured) {
    if (!measured || !measured.scores) return '';
    var entries = Object.keys(measured.scores).map(function(key) {
      return [key, Number(measured.scores[key])];
    }).filter(function(pair){ return Number.isFinite(pair[1]); });
    entries.sort(function(a, b){ return b[1] - a[1]; });
    var rendered = entries.slice(0, 6).map(function(pair) {
      var label = LABELS[pair[0]] || [pair[0], pair[0]];
      return (zh() ? label[0] : label[1]) + ' ' + Math.round(pair[1] * 100);
    });
    if (Number.isFinite(Number(measured.latencyMs))) rendered.push(Math.round(Number(measured.latencyMs)) + 'ms');
    return rendered.join(' · ');
  }

  function updateButton(control) {
    if (!control) return;
    var button = control.querySelector('button');
    if (!button) return;
    var state = control.dataset.capabilityState || 'idle';
    var key = control.dataset.candidateKey || '';
    var thisRun = !!activeRunKey && key === activeRunKey;
    button.hidden = state === 'unavailable';
    button.disabled = state === 'running' || !!activeRunKey;
    button.textContent = thisRun || state === 'running'
      ? text('测试中…', 'Testing…')
      : state === 'measured'
        ? text('重新测试能力', 'Retest capabilities')
        : text('测试能力', 'Test capabilities');
  }

  function syncRunningControls(key) {
    activeRunKey = typeof key === 'string' ? key.trim() : '';
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    var controls = document.querySelectorAll('[' + CONTROL_ATTR + ']');
    Array.prototype.forEach.call(controls, updateButton);
  }

  function setState(control, kind, message, detail) {
    if (!control) return;
    control.dataset.capabilityState = kind;
    var status = control.querySelector('[data-vr-capability-status]');
    if (status) {
      status.textContent = message || '';
      status.title = detail || message || '';
    }
    updateButton(control);
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

  async function refreshControl(row, control, force) {
    var selected = rowSelection(row);
    if (!completeSelection(selected)) {
      removeControl(row);
      return;
    }
    try {
      var body = await fetchSnapshot(force === true);
      var candidate = findCandidate(body, row);
      control.dataset.candidateKey = candidate && candidate.key ? candidate.key : '';
      control.dataset.selection = selected.provider + '\u0000' + selected.model;
      syncRunningControls(runningKeyOf(body));
      if (!candidate) {
        setState(control, 'unavailable', text(
          '当前模型暂不在可执行识图候选池',
          'This model is not currently in the executable vision pool'
        ));
        return;
      }
      if (body.runningKey === candidate.key) {
        setState(control, 'running', text(
          '正在逐项测试；不会切换到其他模型',
          'Testing sequentially; fallback is disabled'
        ));
        return;
      }
      if (candidate.measured) {
        setState(control, 'measured', scoreText(candidate.measured));
        return;
      }
      if (candidate.benchmarkable !== true) {
        setState(control, 'unavailable', text(
          '暂无法生成稳定的后端测试指纹',
          'A stable backend benchmark fingerprint is not available yet'
        ));
        return;
      }
      setState(control, 'idle', text(
        candidate.evidenceScope === 'adapter-route'
          ? '用生成的测试图实测这个DSH模型路由；不会切换备用模型'
          : '用生成的测试图实测这个端点；不会切换备用模型',
        candidate.evidenceScope === 'adapter-route'
          ? 'Measure this exact DSH model route with generated fixtures; fallback stays disabled'
          : 'Measure this exact endpoint with generated fixtures; fallback stays disabled'
      ));
    } catch (error) {
      setState(control, 'unavailable', text('能力测试服务暂不可用', 'Capability test service unavailable') + ': ' + String(error && error.message || error));
    }
  }

  async function runBenchmark(row, control) {
    var selected = rowSelection(row);
    if (!completeSelection(selected)) {
      removeControl(row);
      return;
    }
    var body;
    try {
      body = await fetchSnapshot(true);
    } catch (error) {
      setState(control, 'unavailable', text('读取候选模型失败', 'Failed to load model candidates') + ': ' + String(error && error.message || error));
      return;
    }
    var candidate = findCandidate(body, row);
    if (!candidate || !candidate.key) {
      setState(control, 'unavailable', text('当前模型暂不在可执行识图候选池', 'This model is not currently in the executable vision pool'));
      return;
    }
    var serverRunningKey = runningKeyOf(body);
    if (serverRunningKey) {
      syncRunningControls(serverRunningKey);
      if (serverRunningKey === candidate.key) {
        setState(control, 'running', text('正在逐项测试；不会切换到其他模型', 'Testing sequentially; fallback is disabled'));
      } else {
        setState(control, control.dataset.capabilityState || 'idle', text(
          '另一个识图模型正在测试，请等待完成',
          'Another vision model is being tested; wait for it to finish'
        ));
      }
      return;
    }
    if (candidate.benchmarkable !== true) {
      setState(control, 'unavailable', text('该模型暂缺稳定后端测试指纹', 'This model has no stable backend benchmark fingerprint yet'));
      return;
    }
    syncRunningControls(candidate.key);
    setState(control, 'running', text('正在逐项测试；不会切换到其他模型', 'Testing sequentially; fallback is disabled'));
    var timeout = controllerTimeout(5 * 60 * 1000 + 5000);
    try {
      var response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ key: candidate.key }),
        signal: timeout.signal
      });
      var result = await response.json().catch(function(){ return {}; });
      if (!response.ok || !result || result.ok !== true) {
        var code = result && result.code;
        var raw = String(result && (result.error || result.code) || ('HTTP ' + response.status));
        if (code === 'CAPABILITY_BENCHMARK_BUSY') {
          setState(control, 'idle', text(
            '另一个识图模型正在测试，请等待完成',
            'Another vision model is being tested; wait for it to finish'
          ), raw);
          return;
        }
        if (code === 'CAPABILITY_BENCHMARK_NO_USABLE_EVIDENCE') {
          setState(control, 'idle', text(
            '未获得有效能力数据；该模型未接受测试图片或所有测试调用失败',
            'No usable capability evidence; the model rejected test images or every test call failed'
          ), raw);
          return;
        }
        throw new Error(raw);
      }
      snapshot = undefined;
      snapshotAt = 0;
      setState(control, 'measured', scoreText({
        scores: result.record && result.record.scores,
        latencyMs: result.record && result.record.latencyMs
      }));
    } catch (error) {
      setState(control, 'idle', text('测试失败', 'Test failed') + ': ' + String(error && error.message || error));
    } finally {
      timeout.clear();
      snapshot = undefined;
      snapshotAt = 0;
      syncRunningControls('');
      scheduleScan(true);
    }
  }

  function makeControl(row) {
    if (!row || !row.style) return undefined;
    if (row.dataset && !Object.prototype.hasOwnProperty.call(row.dataset, 'vrCapabilityOldFlexWrap')) {
      row.dataset.vrCapabilityOldFlexWrap = row.style.flexWrap || '';
    }
    row.style.flexWrap = 'wrap';

    var control = document.createElement('div');
    control.setAttribute(CONTROL_ATTR, '1');
    control.dataset.capabilityState = 'idle';
    control.style.display = 'flex';
    control.style.alignItems = 'center';
    control.style.justifyContent = 'space-between';
    control.style.gap = '12px';
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

    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = text('测试能力', 'Test capabilities');
    button.style.font = 'inherit';
    button.style.padding = '4px 10px';
    button.style.border = '1px solid currentColor';
    button.style.borderRadius = '6px';
    button.style.background = 'transparent';
    button.style.color = 'inherit';
    button.style.cursor = 'pointer';
    button.style.flex = '0 0 auto';
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      void runBenchmark(row, control);
    });

    control.appendChild(status);
    control.appendChild(button);
    row.appendChild(control);
    if (rowControls) rowControls.set(row, control);
    updateButton(control);
    return control;
  }

  function controlFor(row) {
    var control = rowControls && rowControls.get(row);
    if (control && control.isConnected !== false) return control;
    control = typeof row.querySelector === 'function' ? row.querySelector('[' + CONTROL_ATTR + ']') : undefined;
    if (control && rowControls) rowControls.set(row, control);
    return control;
  }

  function scan(force) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    var rows = document.querySelectorAll(ROW_SELECTOR);
    Array.prototype.forEach.call(rows, function(row) {
      var selected = rowSelection(row);
      if (!completeSelection(selected)) {
        removeControl(row);
        return;
      }
      var control = controlFor(row) || makeControl(row);
      if (!control) return;
      var selection = selected.provider + '\u0000' + selected.model;
      if (force === true || control.dataset.selection !== selection) void refreshControl(row, control, force === true);
    });
  }

  function scheduleScan(force) {
    if (scanTimer !== undefined) return;
    scanTimer = setTimeout(function(){
      scanTimer = undefined;
      scan(force === true);
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
      var control = controlFor(row);
      if (control) control.dataset.selection = '';
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
  if (typeof html !== 'string' || html.includes(CLIENT_MARK)) return html
  const script = `<script ${CLIENT_MARK}>${CAPABILITY_BENCHMARK_CLIENT.replace(/<\/script/gi, '<\\/script')}</script>`
  const head = html.indexOf('<head>')
  return head === -1 ? `${script}${html}` : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
}

export function installCapabilityBenchmarkClient(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectCapabilityBenchmarkClient),
      'vision-router: capability benchmark client controls',
    )
  })
}

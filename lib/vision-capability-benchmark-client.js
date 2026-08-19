const CLIENT_MARK = 'data-vision-router-capability-benchmark'

export const CAPABILITY_BENCHMARK_CLIENT = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/capability-benchmark';
  var CONTROL_ATTR = 'data-vr-capability-control';
  var snapshot;
  var snapshotAt = 0;
  var snapshotPromise;
  var scanTimer;

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

  function findCandidate(body, row) {
    var selected = rowSelection(row);
    if (!selected.provider || !selected.model || !body || !Array.isArray(body.candidates)) return undefined;
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

  function setState(control, kind, message) {
    if (!control) return;
    var button = control.querySelector('button');
    var status = control.querySelector('[data-vr-capability-status]');
    if (button) {
      button.disabled = kind === 'running';
      button.textContent = kind === 'running'
        ? text('测试中…', 'Testing…')
        : kind === 'measured'
          ? text('重新测试能力', 'Retest capabilities')
          : text('测试能力', 'Test capabilities');
    }
    if (status) {
      status.textContent = message || '';
      status.title = message || '';
    }
  }

  async function refreshControl(row, control, force) {
    try {
      var body = await fetchSnapshot(force === true);
      var candidate = findCandidate(body, row);
      control.dataset.candidateKey = candidate && candidate.key ? candidate.key : '';
      var selected = rowSelection(row);
      control.dataset.selection = selected.provider + '\u0000' + selected.model;
      if (!candidate) {
        setState(control, 'idle', selected.provider && selected.model
          ? text('当前模型不在可执行识图候选池', 'This model is not in the executable vision pool')
          : '');
        return;
      }
      if (candidate.measured) {
        setState(control, 'measured', scoreText(candidate.measured));
        return;
      }
      if (candidate.benchmarkable !== true) {
        setState(control, 'idle', text('暂无法获得稳定端点指纹，不能保存实测结果', 'No stable endpoint fingerprint; measured evidence cannot be persisted'));
        return;
      }
      setState(control, 'idle', text('用生成的测试图对这个端点做一次实测', 'Measure this exact endpoint with generated fixtures'));
    } catch (error) {
      setState(control, 'idle', text('能力测试服务暂不可用', 'Capability test service unavailable') + ': ' + String(error && error.message || error));
    }
  }

  async function runBenchmark(row, control) {
    var body;
    try {
      body = await fetchSnapshot(true);
    } catch (error) {
      setState(control, 'idle', text('读取候选模型失败', 'Failed to load model candidates') + ': ' + String(error && error.message || error));
      return;
    }
    var candidate = findCandidate(body, row);
    if (!candidate || !candidate.key) {
      setState(control, 'idle', text('当前模型不在可执行识图候选池', 'This model is not in the executable vision pool'));
      return;
    }
    if (candidate.benchmarkable !== true) {
      setState(control, 'idle', text('该模型缺少稳定端点指纹，暂不能实测', 'This model has no stable endpoint fingerprint yet'));
      return;
    }
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
        throw new Error(result && (result.error || result.code) || ('HTTP ' + response.status));
      }
      snapshot = undefined;
      snapshotAt = 0;
      setState(control, 'measured', scoreText({
        scores: result.record && result.record.scores,
        latencyMs: result.record && result.record.latencyMs
      }));
      scheduleScan(true);
    } catch (error) {
      setState(control, 'idle', text('测试失败', 'Test failed') + ': ' + String(error && error.message || error));
    } finally {
      timeout.clear();
    }
  }

  function makeControl(row) {
    var control = document.createElement('div');
    control.setAttribute(CONTROL_ATTR, '1');
    control.style.display = 'flex';
    control.style.alignItems = 'center';
    control.style.gap = '8px';
    control.style.marginTop = '6px';
    control.style.minWidth = '0';

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
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      void runBenchmark(row, control);
    });

    var status = document.createElement('span');
    status.setAttribute('data-vr-capability-status', '1');
    status.style.fontSize = '12px';
    status.style.opacity = '0.72';
    status.style.overflow = 'hidden';
    status.style.textOverflow = 'ellipsis';
    status.style.whiteSpace = 'nowrap';

    control.appendChild(button);
    control.appendChild(status);
    row.appendChild(control);
    return control;
  }

  function scan(force) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    var rows = document.querySelectorAll('.vr-chain-row');
    Array.prototype.forEach.call(rows, function(row) {
      var control = row.querySelector('[' + CONTROL_ATTR + ']') || makeControl(row);
      var selected = rowSelection(row);
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

  function install() {
    if (typeof document === 'undefined') return;
    document.addEventListener('change', function(event) {
      var target = event && event.target;
      var row = target && typeof target.closest === 'function' ? target.closest('.vr-chain-row') : undefined;
      if (!row) return;
      var control = row.querySelector('[' + CONTROL_ATTR + ']');
      if (control) control.dataset.selection = '';
      scheduleScan(true);
    }, true);
    if (typeof MutationObserver === 'function' && document.documentElement) {
      var observer = new MutationObserver(function(){ scheduleScan(false); });
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
